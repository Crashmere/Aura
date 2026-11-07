package library

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"
)

type AlbumGroup struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	Deleted   bool   `json:"deleted,omitempty"`
}

var errAlbumGroupMissing = errors.New("分组不存在")
var errAlbumMissing = errors.New("相片集不存在")

func albumGroup(tx *sql.Tx, id string) (AlbumGroup, error) {
	var group AlbumGroup
	var detail string
	err := tx.QueryRow(`SELECT detail FROM decisions WHERE id=? AND action='album-group'
 AND COALESCE(json_extract(detail,'$.deleted'),0)=0`, "album-group:"+id).Scan(&detail)
	if errors.Is(err, sql.ErrNoRows) {
		return group, errAlbumGroupMissing
	}
	if err == nil {
		err = json.Unmarshal([]byte(detail), &group)
	}
	return group, err
}

func saveAlbumGroup(tx *sql.Tx, group AlbumGroup) error {
	_, err := tx.Exec(`INSERT INTO decisions(id,action,detail,created_at) VALUES(?,'album-group',?,?)
 ON CONFLICT(id) DO UPDATE SET detail=excluded.detail`, "album-group:"+group.ID, marshal(group), group.CreatedAt)
	return err
}

func assignAlbumGroup(tx *sql.Tx, ids []string, groupID, date string) error {
	if groupID != "" {
		if _, err := albumGroup(tx, groupID); err != nil {
			return err
		}
	}
	for _, id := range ids {
		res, err := tx.Exec("UPDATE albums SET updated_at=? WHERE id=?", date, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return errAlbumMissing
		}
		_, err = tx.Exec(`INSERT INTO decisions(id,action,detail,created_at) VALUES(?,'album-grouping',?,?)
 ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,created_at=excluded.created_at`,
			"album-grouping:"+id, marshal(map[string]string{"groupId": groupID}), date)
		if err != nil {
			return err
		}
	}
	return nil
}

func albumGroupWriteError(w http.ResponseWriter, err error) {
	if errors.Is(err, errAlbumGroupMissing) || errors.Is(err, errAlbumMissing) {
		fail(w, 404, err)
	} else {
		albumWriteError(w, err)
	}
}

func (l *Library) listAlbumGroups(w http.ResponseWriter, r *http.Request) {
	value, err := l.cachedCatalog(r.Context(), "album-groups", "library", func() (any, error) {
		rows, err := l.DB.Query(`SELECT detail FROM decisions WHERE action='album-group'
 AND COALESCE(json_extract(detail,'$.deleted'),0)=0 ORDER BY created_at DESC,id DESC`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		groups := []AlbumGroup{}
		for rows.Next() {
			var detail string
			var group AlbumGroup
			if err := rows.Scan(&detail); err != nil {
				return nil, err
			}
			if err := json.Unmarshal([]byte(detail), &group); err != nil {
				return nil, err
			}
			groups = append(groups, group)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		rows.Close()
		var detail string
		err = l.DB.QueryRow("SELECT detail FROM decisions WHERE id='album-group-order' AND action='album-group-order'").Scan(&detail)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if err == nil {
			var order struct {
				Groups []string `json:"groups"`
			}
			if err := json.Unmarshal([]byte(detail), &order); err != nil {
				return nil, err
			}
			ranks := map[string]int{}
			for i, id := range order.Groups {
				ranks[id] = i
			}
			rank := func(id string) int {
				if value, ok := ranks[id]; ok {
					return value
				}
				return len(order.Groups)
			}
			sort.SliceStable(groups, func(i, j int) bool { return rank(groups[i].ID) < rank(groups[j].ID) })
		}
		return groups, nil
	})
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, value)
}

func (l *Library) orderAlbumGroups(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Groups []string `json:"groups"`
	}
	if !decode(w, r, &p) {
		return
	}
	if p.Groups == nil || len(p.Groups) > 1000 {
		fail(w, 400, "请提供分组顺序，每次最多 1000 个分组")
		return
	}
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	seen := map[string]bool{}
	for _, id := range p.Groups {
		if seen[id] {
			fail(w, 400, "分组顺序不能包含重复分组")
			return
		}
		seen[id] = true
		if _, err := albumGroup(tx, id); err != nil {
			albumGroupWriteError(w, err)
			return
		}
	}
	_, err = tx.Exec(`INSERT INTO decisions(id,action,detail,created_at) VALUES('album-group-order','album-group-order',?,?)
 ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,created_at=excluded.created_at`, marshal(p), now())
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ordered": true})
}

func (l *Library) createAlbumGroup(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Name   string   `json:"name"`
		Albums []string `json:"albums"`
	}
	if !decode(w, r, &p) {
		return
	}
	name, valid := albumName(p.Name)
	if !valid || len(p.Albums) > 1000 {
		fail(w, 400, "请输入 1–100 字的分组名称，每次最多移动 1000 个相片集")
		return
	}
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	date := now()
	group := AlbumGroup{ID: ID(), Name: name, CreatedAt: date, UpdatedAt: date}
	err = saveAlbumGroup(tx, group)
	if err == nil {
		err = assignAlbumGroup(tx, p.Albums, group.ID, date)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		albumGroupWriteError(w, err)
		return
	}
	writeJSON(w, 201, group)
}

func (l *Library) updateAlbumGroup(w http.ResponseWriter, r *http.Request) {
	name := ""
	if r.Method == http.MethodPatch {
		var p struct {
			Name string `json:"name"`
		}
		if !decode(w, r, &p) {
			return
		}
		var valid bool
		name, valid = albumName(p.Name)
		if !valid {
			fail(w, 400, "请输入 1–100 字的分组名称")
			return
		}
	}
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	group, err := albumGroup(tx, chi.URLParam(r, "id"))
	if err == nil {
		group.UpdatedAt = now()
		if r.Method == http.MethodDelete {
			// The tombstone makes existing assignments resolve to ungrouped.
			group.Deleted = true
		} else {
			group.Name = name
		}
		err = saveAlbumGroup(tx, group)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		albumGroupWriteError(w, err)
		return
	}
	if group.Deleted {
		writeJSON(w, 200, map[string]bool{"deleted": true})
	} else {
		writeJSON(w, 200, group)
	}
}

func (l *Library) moveAlbumGroup(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Albums  []string        `json:"albums"`
		GroupID json.RawMessage `json:"groupId"`
	}
	if !decode(w, r, &p) {
		return
	}
	var groupID *string
	if len(p.Albums) == 0 || len(p.Albums) > 1000 || len(p.GroupID) == 0 ||
		json.Unmarshal(p.GroupID, &groupID) != nil || groupID != nil && !validID.MatchString(*groupID) {
		fail(w, 400, "请选择 1–1000 个相片集，以及目标分组；移出分组请使用 null")
		return
	}
	id := ""
	if groupID != nil {
		id = *groupID
	}
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	err = assignAlbumGroup(tx, p.Albums, id, now())
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		albumGroupWriteError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"moved": true})
}
