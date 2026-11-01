package library

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"math"
	"math/bits"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

type similarItem struct {
	ID, Date string
	Value    uint64
	Ratio    float64
}

type similarPair struct {
	Left     string  `json:"left"`
	Right    string  `json:"right"`
	Distance int     `json:"distance"`
	Source   string  `json:"source,omitempty"`
	Score    float32 `json:"score,omitempty"`
}

type similarMatch struct {
	Item     similarItem
	Distance int
}

type bkNode struct {
	Item     similarItem
	Children map[int]*bkNode
}

func (n *bkNode) add(v similarItem) {
	d := bits.OnesCount64(n.Item.Value ^ v.Value)
	if child := n.Children[d]; child != nil {
		child.add(v)
	} else {
		n.Children[d] = &bkNode{v, map[int]*bkNode{}}
	}
}

func (n *bkNode) find(v similarItem, out *[]similarMatch) {
	d := bits.OnesCount64(n.Item.Value ^ v.Value)
	if d <= 4 && math.Abs(n.Item.Ratio-v.Ratio) < 0.03 {
		*out = append(*out, similarMatch{n.Item, d})
	}
	for step, child := range n.Children {
		if step >= d-4 && step <= d+4 {
			child.find(v, out)
		}
	}
}

func pairKey(left, right string) string {
	if left > right {
		left, right = right, left
	}
	return left + "|" + right
}

func (l *Library) ignoredPairs() (map[string]bool, error) {
	rows, e := l.DB.Query("SELECT action,detail FROM decisions WHERE action IN ('similar-ignore','similar-restore') ORDER BY created_at DESC,id DESC")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	ignored := map[string]bool{}
	for rows.Next() {
		var action, detail string
		if e = rows.Scan(&action, &detail); e != nil {
			return nil, e
		}
		var pair similarPair
		if e = json.Unmarshal([]byte(detail), &pair); e != nil {
			return nil, e
		}
		key := pairKey(pair.Left, pair.Right)
		if _, seen := ignored[key]; !seen {
			ignored[key] = action == "similar-ignore"
		}
	}
	return ignored, rows.Err()
}

func (l *Library) similar(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if source := q.Get("source"); source == "dino" {
		l.similarDINO(w, r)
		return
	} else if source != "" && source != "dhash" {
		fail(w, 400, "相似类型无效")
		return
	}
	paged := q.Get("paged") == "true"
	limit := 100
	cursorDate, cursorItem, cursorMatch := "", "", ""
	if paged {
		limit = pageLimit(q, 50, 240)
		if cursor := q.Get("cursor"); cursor != "" {
			raw, e := base64.RawURLEncoding.DecodeString(cursor)
			parts := strings.SplitN(string(raw), "|", 3)
			if e != nil || len(parts) != 3 || parts[0] == "" || !validID.MatchString(parts[1]) || !validID.MatchString(parts[2]) {
				fail(w, 400, "分页位置无效")
				return
			}
			cursorDate, cursorItem, cursorMatch = parts[0], parts[1], parts[2]
		}
	}
	ignored, e := l.ignoredPairs()
	if e != nil {
		fail(w, 500, e)
		return
	}
	rows, e := l.DB.Query("SELECT a.id,a.captured_at,f.dhash,f.width,f.height FROM assets a JOIN files f ON f.hash=a.primary_hash WHERE a.trashed_at='' AND f.dhash!='' ORDER BY a.captured_at DESC,a.id DESC")
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer rows.Close()
	var root *bkNode
	items := []similarPair{}
	cursors := []string{}
	for rows.Next() {
		if r.Context().Err() != nil {
			return
		}
		var item similarItem
		var hash string
		var width, height int
		if e = rows.Scan(&item.ID, &item.Date, &hash, &width, &height); e != nil {
			fail(w, 500, e)
			return
		}
		if height == 0 {
			continue
		}
		item.Value, e = strconv.ParseUint(hash, 16, 64)
		if e != nil {
			continue
		}
		item.Ratio = float64(width) / float64(height)
		if root == nil {
			root = &bkNode{item, map[int]*bkNode{}}
			continue
		}
		// Rebuild the earlier tree so later pages retain matches to newer items.
		if cursorDate == "" || item.Date < cursorDate || item.Date == cursorDate && item.ID <= cursorItem {
			matches := []similarMatch{}
			root.find(item, &matches)
			sort.Slice(matches, func(i, j int) bool { return matches[i].Item.ID < matches[j].Item.ID })
			for _, match := range matches {
				if item.Date == cursorDate && item.ID == cursorItem && match.Item.ID <= cursorMatch {
					continue
				}
				if ignored[pairKey(item.ID, match.Item.ID)] {
					continue
				}
				items = append(items, similarPair{Left: match.Item.ID, Right: item.ID, Distance: match.Distance, Source: "dhash"})
				cursors = append(cursors, item.Date+"|"+item.ID+"|"+match.Item.ID)
				if len(items) > limit {
					break
				}
			}
		}
		if len(items) > limit {
			break
		}
		root.add(item)
	}
	if e = rows.Err(); e != nil {
		fail(w, 500, e)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = base64.RawURLEncoding.EncodeToString([]byte(cursors[limit-1]))
	}
	if paged {
		writeJSON(w, 200, map[string]any{"items": items, "next": next})
	} else {
		writeJSON(w, 200, items)
	}
}

func (l *Library) similarDINO(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 100
	paged := q.Get("paged") == "true"
	if paged {
		limit = pageLimit(q, 50, 240)
	}
	var cursor struct {
		Score float32 `json:"score"`
		Left  string  `json:"left"`
		Right string  `json:"right"`
	}
	if value := q.Get("cursor"); value != "" {
		raw, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil || json.Unmarshal(raw, &cursor) != nil || !validID.MatchString(cursor.Left) || !validID.MatchString(cursor.Right) || cursor.Score < .7 || cursor.Score > 1.001 {
			fail(w, 400, "分页位置无效")
			return
		}
	}
	ignored, err := l.ignoredPairs()
	if err != nil {
		fail(w, 500, err)
		return
	}
	rows, err := l.DB.QueryContext(r.Context(), `SELECT a.id,f.hash,f.dhash,f.width,f.height FROM assets a
 JOIN files f ON f.hash=a.primary_hash WHERE a.trashed_at='' AND f.status='ready' AND NOT EXISTS
 (SELECT 1 FROM decisions d,json_each(d.detail,'$.hashes') h WHERE d.action='purge-request' AND h.value=f.hash)`)
	if err != nil {
		fail(w, 500, err)
		return
	}
	type entry struct {
		id, hash, dhash string
		width, height   int
	}
	assets := map[string]entry{}
	for rows.Next() {
		var item entry
		if err = rows.Scan(&item.id, &item.hash, &item.dhash, &item.width, &item.height); err != nil {
			break
		}
		assets[item.hash] = item
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		fail(w, 500, err)
		return
	}
	records := l.dinoRecordSnapshot()
	pairs := map[string]similarPair{}
	for hash, record := range records {
		if record.Error != "" {
			continue
		}
		left, exists := assets[hash]
		if !exists {
			continue
		}
		for _, match := range record.Matches {
			right, exists := assets[match.Hash]
			target, indexed := records[match.Hash]
			if !exists || !indexed || target.Error != "" || left.id == right.id || match.Score < .7 {
				continue
			}
			a, b := orderedDINO(left.id, right.id)
			key := pairKey(a, b)
			if ignored[key] {
				continue
			}
			lh, le := strconv.ParseUint(left.dhash, 16, 64)
			rh, re := strconv.ParseUint(right.dhash, 16, 64)
			if le == nil && re == nil && left.height > 0 && right.height > 0 && bits.OnesCount64(lh^rh) <= 4 && math.Abs(float64(left.width)/float64(left.height)-float64(right.width)/float64(right.height)) < .03 {
				continue
			}
			if previous, ok := pairs[key]; !ok || previous.Score < match.Score {
				pairs[key] = similarPair{Left: a, Right: b, Source: "dino", Score: match.Score}
			}
		}
	}
	items := []similarPair{}
	for _, pair := range pairs {
		if cursor.Left != "" && (pair.Score > cursor.Score || pair.Score == cursor.Score && (pair.Left < cursor.Left || pair.Left == cursor.Left && pair.Right <= cursor.Right)) {
			continue
		}
		items = append(items, pair)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Score != items[j].Score {
			return items[i].Score > items[j].Score
		}
		if items[i].Left != items[j].Left {
			return items[i].Left < items[j].Left
		}
		return items[i].Right < items[j].Right
	})
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		next = base64.RawURLEncoding.EncodeToString([]byte(marshal(map[string]any{"score": last.Score, "left": last.Left, "right": last.Right})))
	}
	if paged {
		writeJSON(w, 200, map[string]any{"items": items, "next": next, "index": l.dinoSnapshot()})
	} else {
		writeJSON(w, 200, items)
	}
}

func (l *Library) ignoreSimilar(w http.ResponseWriter, r *http.Request) {
	var pair similarPair
	if !decode(w, r, &pair) {
		return
	}
	if !validID.MatchString(pair.Left) || !validID.MatchString(pair.Right) || pair.Left == pair.Right {
		fail(w, 400, "请选择两张不同照片")
		return
	}
	if pair.Left > pair.Right {
		pair.Left, pair.Right = pair.Right, pair.Left
	}
	ignored := r.Method == http.MethodPost
	action := "similar-restore"
	if ignored {
		action = "similar-ignore"
	}
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	if ignored {
		var count int
		if e = tx.QueryRow("SELECT count(*) FROM assets WHERE id IN (?,?) AND trashed_at=''", pair.Left, pair.Right).Scan(&count); e != nil {
			fail(w, 500, e)
			return
		}
		if count != 2 {
			fail(w, 404, "照片不存在或已移入最近删除")
			return
		}
	}
	var previous string
	e = tx.QueryRow(`SELECT action FROM decisions WHERE action IN ('similar-ignore','similar-restore')
 AND json_extract(detail,'$.left')=? AND json_extract(detail,'$.right')=? ORDER BY created_at DESC,id DESC LIMIT 1`, pair.Left, pair.Right).Scan(&previous)
	if e != nil && e != sql.ErrNoRows {
		fail(w, 500, e)
		return
	}
	if previous != action {
		if _, e = tx.Exec("INSERT INTO decisions(id,action,detail,created_at) VALUES(?,?,?,?)", ID(), action, marshal(map[string]string{"left": pair.Left, "right": pair.Right}), now()); e != nil {
			fail(w, 500, e)
			return
		}
	}
	if e = tx.Commit(); e != nil {
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, map[string]bool{"ignored": ignored})
}
