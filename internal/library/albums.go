package library

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
)

type Album struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Count     int    `json:"count"`
	Cover     *Asset `json:"cover,omitempty"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

const albumSelect = `SELECT al.id,al.name,al.created_at,al.updated_at,
 (SELECT count(*) FROM album_assets aa JOIN assets a ON a.id=aa.asset_id WHERE aa.album_id=al.id AND a.trashed_at=''),
 COALESCE((SELECT a.id FROM album_assets aa JOIN assets a ON a.id=aa.asset_id
 WHERE aa.album_id=al.id AND a.trashed_at='' ORDER BY a.captured_at DESC,a.id DESC LIMIT 1),'')
 FROM albums al `

func scanAlbum(row scanner) (a Album, cover string, err error) {
	err = row.Scan(&a.ID, &a.Name, &a.CreatedAt, &a.UpdatedAt, &a.Count, &cover)
	return
}

func (l *Library) Album(id string) (Album, error) {
	a, cover, err := scanAlbum(l.DB.QueryRow(albumSelect+"WHERE al.id=?", id))
	if err == nil && cover != "" {
		asset, e := l.Asset(cover)
		if e != nil {
			return a, e
		}
		a.Cover = &asset
	}
	return a, err
}

func (l *Library) listAlbums(w http.ResponseWriter, r *http.Request) {
	rows, err := l.DB.Query(albumSelect + "ORDER BY al.created_at DESC,al.id DESC")
	if err != nil {
		fail(w, 500, err)
		return
	}
	albums, covers := []Album{}, []string{}
	for rows.Next() {
		a, cover, e := scanAlbum(rows)
		if e != nil {
			rows.Close()
			fail(w, 500, e)
			return
		}
		albums = append(albums, a)
		covers = append(covers, cover)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		fail(w, 500, err)
		return
	}
	// Close the catalog cursor before fetching covers on the single connection.
	for i, id := range covers {
		if id == "" {
			continue
		}
		a, e := l.Asset(id)
		if e != nil {
			fail(w, 500, e)
			return
		}
		albums[i].Cover = &a
	}
	writeJSON(w, 200, albums)
}

func (l *Library) albumDetail(w http.ResponseWriter, r *http.Request) {
	l.writeAlbum(w, chi.URLParam(r, "id"), 200)
}

func (l *Library) writeAlbum(w http.ResponseWriter, id string, status int) {
	a, err := l.Album(id)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "相片集不存在")
	} else if err != nil {
		fail(w, 500, err)
	} else {
		writeJSON(w, status, a)
	}
}

func albumName(name string) (string, bool) {
	name = strings.TrimSpace(name)
	return name, name != "" && utf8.RuneCountInString(name) <= 100
}

var errAlbumAsset = errors.New("照片不存在或已移入最近删除")

func addAlbumAssets(tx *sql.Tx, id string, assets []string) error {
	for _, asset := range assets {
		request, err := assetDeletion(tx, asset)
		if err != nil {
			return err
		}
		if request != "" {
			return &pendingDeletion{request: request}
		}
		var exists bool
		if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM assets WHERE id=? AND trashed_at='')", asset).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errAlbumAsset
		}
		if _, err := tx.Exec("INSERT OR IGNORE INTO album_assets(album_id,asset_id) VALUES(?,?)", id, asset); err != nil {
			return err
		}
	}
	return nil
}

func albumWriteError(w http.ResponseWriter, err error) {
	var pending *pendingDeletion
	if errors.As(err, &pending) {
		assetDeletionFailure(w, pending.request)
	} else if errors.Is(err, errAlbumAsset) {
		fail(w, 400, err)
	} else {
		fail(w, 500, err)
	}
}

func (l *Library) createAlbum(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Name   string   `json:"name"`
		Assets []string `json:"assets"`
	}
	if !decode(w, r, &p) {
		return
	}
	name, valid := albumName(p.Name)
	if !valid || len(p.Assets) > 1000 {
		fail(w, 400, "请输入 1–100 字的相片集名称，每次最多添加 1000 项")
		return
	}
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	id, date := ID(), now()
	_, err = tx.Exec("INSERT INTO albums(id,name,created_at,updated_at) VALUES(?,?,?,?)", id, name, date, date)
	if err == nil {
		err = addAlbumAssets(tx, id, p.Assets)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		albumWriteError(w, err)
		return
	}
	l.writeAlbum(w, id, 201)
}

func (l *Library) renameAlbum(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &p) {
		return
	}
	name, valid := albumName(p.Name)
	if !valid {
		fail(w, 400, "请输入 1–100 字的相片集名称")
		return
	}
	id := chi.URLParam(r, "id")
	res, err := l.DB.Exec("UPDATE albums SET name=?,updated_at=? WHERE id=?", name, now(), id)
	if err != nil {
		fail(w, 500, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 404, "相片集不存在")
		return
	}
	l.writeAlbum(w, id, 200)
}

func (l *Library) deleteAlbum(w http.ResponseWriter, r *http.Request) {
	res, err := l.DB.Exec("DELETE FROM albums WHERE id=?", chi.URLParam(r, "id"))
	if err != nil {
		fail(w, 500, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, 404, "相片集不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"deleted": true})
}

func (l *Library) changeAlbumAssets(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Assets []string `json:"assets"`
	}
	if !decode(w, r, &p) {
		return
	}
	if len(p.Assets) == 0 || len(p.Assets) > 1000 {
		fail(w, 400, "每次请选择 1–1000 项")
		return
	}
	tx, err := l.DB.Begin()
	if err != nil {
		fail(w, 500, err)
		return
	}
	defer tx.Rollback()
	id := chi.URLParam(r, "id")
	var exists bool
	err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM albums WHERE id=?)", id).Scan(&exists)
	if err != nil {
		fail(w, 500, err)
		return
	}
	if !exists {
		fail(w, 404, "相片集不存在")
		return
	}
	if r.Method == http.MethodPost {
		err = addAlbumAssets(tx, id, p.Assets)
	} else {
		for _, asset := range p.Assets {
			if !allowAssetMutation(w, tx, asset) {
				return
			}
			if _, err = tx.Exec("DELETE FROM album_assets WHERE album_id=? AND asset_id=?", id, asset); err != nil {
				break
			}
		}
	}
	if err == nil {
		_, err = tx.Exec("UPDATE albums SET updated_at=? WHERE id=?", now(), id)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		albumWriteError(w, err)
		return
	}
	l.writeAlbum(w, id, 200)
}

func (l *Library) importAlbum(w http.ResponseWriter, r *http.Request) {
	var p struct {
		SourceKey string   `json:"sourceKey"`
		Name      string   `json:"name"`
		Assets    []string `json:"assets"`
	}
	if !decode(w, r, &p) {
		return
	}
	p.SourceKey = strings.TrimSpace(p.SourceKey)
	name, valid := albumName(p.Name)
	if p.SourceKey == "" || len(p.SourceKey) > 1024 || !valid || len(p.Assets) > 1000 {
		fail(w, 400, "相片集来源或名称无效，每次最多添加 1000 项")
		return
	}
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	var id string
	e = tx.QueryRow(`SELECT json_extract(detail,'$.albumId') FROM decisions
 WHERE action='album-import' AND json_extract(detail,'$.sourceKey')=? ORDER BY created_at DESC,id DESC LIMIT 1`, p.SourceKey).Scan(&id)
	created := e == sql.ErrNoRows
	if e != nil && !created {
		fail(w, 500, e)
		return
	}
	if created {
		id = ID()
		date := now()
		if _, e = tx.Exec("INSERT INTO albums(id,name,created_at,updated_at) VALUES(?,?,?,?)", id, name, date, date); e != nil {
			fail(w, 500, e)
			return
		}
		if _, e = tx.Exec("INSERT INTO decisions(id,action,detail,created_at) VALUES(?,?,?,?)", ID(), "album-import", marshal(map[string]string{"sourceKey": p.SourceKey, "albumId": id}), date); e != nil {
			fail(w, 500, e)
			return
		}
	} else {
		var exists bool
		if e = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM albums WHERE id=?)", id).Scan(&exists); e != nil {
			fail(w, 500, e)
			return
		}
		if !exists {
			writeJSON(w, 409, map[string]string{"error": "导入的相片集已在 Aura 删除，不会自动重建", "code": "imported_album_deleted"})
			return
		}
	}
	var before, after int
	if e = tx.QueryRow("SELECT count(*) FROM album_assets WHERE album_id=?", id).Scan(&before); e != nil {
		fail(w, 500, e)
		return
	}
	if e = addAlbumAssets(tx, id, p.Assets); e != nil {
		albumWriteError(w, e)
		return
	}
	if e = tx.QueryRow("SELECT count(*) FROM album_assets WHERE album_id=?", id).Scan(&after); e != nil {
		fail(w, 500, e)
		return
	}
	if after != before {
		if _, e = tx.Exec("UPDATE albums SET updated_at=? WHERE id=?", now(), id); e != nil {
			fail(w, 500, e)
			return
		}
	}
	if e = tx.Commit(); e != nil {
		fail(w, 500, e)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	l.writeAlbum(w, id, status)
}
