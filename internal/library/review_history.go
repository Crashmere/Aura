package library

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

type splitRecord struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Hash   string `json:"hash"`
	Anchor string `json:"anchor,omitempty"`
	Name   string `json:"name,omitempty"`
}

type historyItem struct {
	ID         string `json:"id"`
	CreatedAt  string `json:"createdAt"`
	Left       string `json:"left"`
	Right      string `json:"right"`
	Hash       string `json:"hash,omitempty"`
	Name       string `json:"name,omitempty"`
	CanRestore bool   `json:"canRestore"`
	Reason     string `json:"reason,omitempty"`
}

const latestDismissalSQL = `d.action='similar-ignore' AND NOT EXISTS (
 SELECT 1 FROM decisions n WHERE n.action IN ('similar-ignore','similar-restore')
 AND json_extract(n.detail,'$.left')=json_extract(d.detail,'$.left')
 AND json_extract(n.detail,'$.right')=json_extract(d.detail,'$.right')
 AND (n.created_at>d.created_at OR n.created_at=d.created_at AND n.id>d.id))`

const pendingSplitSQL = `d.action='split' AND NOT EXISTS (SELECT 1 FROM decisions u
 WHERE u.action='split-restore' AND json_extract(u.detail,'$.splitId')=d.id)`

func splitState(tx *sql.Tx, id string, record splitRecord) (target, current, reason string, err error) {
	if err = tx.QueryRow("SELECT asset_id FROM files WHERE hash=?", record.Hash).Scan(&current); err != nil {
		if err == sql.ErrNoRows {
			return "", "", "原件已不在图库中", nil
		}
		return
	}
	target = record.From
	var exists bool
	seen := map[string]bool{}
	for target != "" && !seen[target] {
		seen[target] = true
		if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?)", target).Scan(&exists); err != nil {
			return
		}
		if exists {
			break
		}
		var merged string
		err = tx.QueryRow(`SELECT json_extract(detail,'$.keep') FROM decisions
 WHERE action='merge' AND json_extract(detail,'$.drop')=? ORDER BY created_at DESC,id DESC LIMIT 1`, target).Scan(&merged)
		if err == sql.ErrNoRows {
			err = nil
			break
		}
		if err != nil {
			return
		}
		target = merged
	}
	if !exists && record.Anchor != "" {
		var moved bool
		err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM decisions n JOIN decisions d ON d.id=?
 WHERE n.action='split' AND json_extract(n.detail,'$.hash')=?
 AND (n.created_at>d.created_at OR n.created_at=d.created_at AND n.id>d.id))`, id, record.Anchor).Scan(&moved)
		if err != nil {
			return
		}
		if moved {
			reason = "原照片已被重新整理"
			return
		}
		err = tx.QueryRow("SELECT asset_id FROM files WHERE hash=?", record.Anchor).Scan(&target)
		if err == sql.ErrNoRows {
			err = nil
			target = ""
		}
		if err != nil {
			return
		}
		if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?)", target).Scan(&exists); err != nil {
			return
		}
	}
	if target == "" || !exists {
		reason = "原照片已不在图库中"
		return
	}
	if current == target {
		reason = "已重新组合"
		return
	}
	if current != record.To {
		reason = "此版本已被重新整理"
		return
	}
	var later bool
	err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM decisions n JOIN decisions d ON d.id=?
 WHERE n.action='split' AND json_extract(n.detail,'$.hash')=?
 AND (n.created_at>d.created_at OR n.created_at=d.created_at AND n.id>d.id))`, id, record.Hash).Scan(&later)
	if err != nil {
		return
	}
	if later {
		reason = "此版本已有更新的分离记录"
		return
	}
	var targetTrash, currentTrash string
	for i, asset := range []string{target, current} {
		request, e := assetDeletion(tx, asset)
		if e != nil {
			err = e
			return
		}
		if request != "" {
			reason = "照片正在永久删除"
			return
		}
		var trash string
		if err = tx.QueryRow("SELECT trashed_at FROM assets WHERE id=?", asset).Scan(&trash); err != nil {
			if err == sql.ErrNoRows {
				reason = "照片已不在图库中"
				err = nil
			}
			return
		}
		if i == 0 {
			targetTrash = trash
		} else {
			currentTrash = trash
		}
	}
	if (targetTrash == "") != (currentTrash == "") {
		reason = "请先将两项都恢复，或都移入最近删除"
	}
	return
}

func (l *Library) reviewHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where := latestDismissalSQL
	if q.Get("kind") == "split" {
		where = pendingSplitSQL
	} else if q.Get("kind") != "similar" {
		fail(w, 400, "记录类型无效")
		return
	}
	args := []any{}
	if cursor := q.Get("cursor"); cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		parts := strings.SplitN(string(raw), "|", 2)
		if err != nil || len(parts) != 2 || parts[0] == "" || !validID.MatchString(parts[1]) {
			fail(w, 400, "分页位置无效")
			return
		}
		where += " AND (d.created_at<? OR d.created_at=? AND d.id<?)"
		args = append(args, parts[0], parts[0], parts[1])
	}
	limit := pageLimit(q, 20, 100)
	args = append(args, limit+1)
	rows, err := l.DB.QueryContext(r.Context(), "SELECT d.id,d.detail,d.created_at FROM decisions d WHERE "+where+" ORDER BY d.created_at DESC,d.id DESC LIMIT ?", args...)
	if err != nil {
		fail(w, 500, err)
		return
	}
	type rawRecord struct{ id, detail, date string }
	records := []rawRecord{}
	for rows.Next() {
		var d rawRecord
		if err = rows.Scan(&d.id, &d.detail, &d.date); err != nil {
			break
		}
		records = append(records, d)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		fail(w, 500, err)
		return
	}
	next := ""
	if len(records) > limit {
		records = records[:limit]
		last := records[len(records)-1]
		next = base64.RawURLEncoding.EncodeToString([]byte(last.date + "|" + last.id))
	}
	items := []historyItem{}
	ids := map[string]bool{}
	for _, d := range records {
		item := historyItem{ID: d.id, CreatedAt: d.date, CanRestore: true}
		if q.Get("kind") == "similar" {
			var pair similarPair
			if err = json.Unmarshal([]byte(d.detail), &pair); err != nil {
				fail(w, 500, err)
				return
			}
			item.Left, item.Right = pair.Left, pair.Right
		} else {
			var record splitRecord
			if err = json.Unmarshal([]byte(d.detail), &record); err != nil {
				fail(w, 500, err)
				return
			}
			tx, e := l.DB.BeginTx(r.Context(), nil)
			if e != nil {
				fail(w, 500, e)
				return
			}
			item.Left, item.Right, item.Reason, e = splitState(tx, d.id, record)
			tx.Rollback()
			if e != nil {
				fail(w, 500, e)
				return
			}
			item.Hash, item.Name, item.CanRestore = record.Hash, record.Name, item.Reason == ""
			if item.Name == "" {
				_ = l.DB.QueryRow("SELECT name FROM files WHERE hash=?", record.Hash).Scan(&item.Name)
			}
		}
		if item.Left != "" {
			ids[item.Left] = true
		}
		if item.Right != "" {
			ids[item.Right] = true
		}
		items = append(items, item)
	}
	cards, err := l.assetCards(r.Context(), ids)
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items, "assets": cards, "next": next})
}

func (l *Library) restoreSplit(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tx, err := l.DB.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	var detail string
	if err = tx.QueryRow("SELECT detail FROM decisions WHERE id=? AND action='split'", id).Scan(&detail); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 404, "分离记录不存在")
		} else {
			fail(w, 500, err)
		}
		return
	}
	var record splitRecord
	if err = json.Unmarshal([]byte(detail), &record); err != nil {
		fail(w, 500, err)
		return
	}
	var restored string
	err = tx.QueryRow("SELECT json_extract(detail,'$.assetId') FROM decisions WHERE action='split-restore' AND json_extract(detail,'$.splitId')=? LIMIT 1", id).Scan(&restored)
	if err == nil {
		writeJSON(w, 200, map[string]string{"id": restored})
		return
	}
	if err != sql.ErrNoRows {
		fail(w, 500, err)
		return
	}
	target, current, reason, err := splitState(tx, id, record)
	if err != nil {
		fail(w, 500, err)
		return
	}
	if reason != "" && reason != "已重新组合" {
		writeJSON(w, 409, map[string]string{"error": reason, "code": "split_restore_conflict"})
		return
	}
	if current != target {
		if _, err = tx.Exec("INSERT OR IGNORE INTO album_assets(album_id,asset_id) SELECT album_id,? FROM album_assets WHERE asset_id=?", target, current); err == nil {
			_, err = tx.Exec("UPDATE assets SET favorite=MAX(favorite,COALESCE((SELECT favorite FROM assets WHERE id=?),0)) WHERE id=?", current, target)
		}
		if err == nil {
			_, err = tx.Exec("UPDATE files SET asset_id=? WHERE hash=?", target, record.Hash)
		}
		if err == nil {
			var remaining int
			err = tx.QueryRow("SELECT count(*) FROM files WHERE asset_id=?", current).Scan(&remaining)
			if err == nil && remaining == 0 {
				_, err = tx.Exec("DELETE FROM asset_keys WHERE asset_id=?", current)
				if err == nil {
					_, err = tx.Exec("DELETE FROM assets WHERE id=?", current)
				}
			} else if err == nil {
				err = refreshTx(tx, current)
			}
		}
		if err == nil {
			err = refreshTx(tx, target)
		}
	}
	if err == nil {
		_, err = tx.Exec("INSERT INTO decisions VALUES(?,?,?,?)", ID(), "split-restore", marshal(map[string]string{"splitId": id, "assetId": target, "hash": record.Hash}), now())
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]string{"id": target})
}
