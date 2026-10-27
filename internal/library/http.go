package library

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"math"
	"math/bits"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func (l *Library) Handler(frontend fs.FS) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Referrer-Policy", "same-origin")
			if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
				origin := r.Header.Get("Origin")
				if origin != "" {
					u, e := url.Parse(origin)
					if e != nil || u.Host != r.Host {
						fail(w, 403, "请求来源不匹配")
						return
					}
				}
				if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
					fail(w, 403, "不接受跨站写入")
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if e := l.DB.PingContext(ctx); e != nil {
			fail(w, 503, "database unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ok", "service": "Aura"})
	})
	r.Get("/api/info", l.info)
	r.Get("/api/assets", l.list)
	r.Get("/api/assets/{id}", l.detail)
	r.Patch("/api/assets/{id}", l.updateAsset)
	r.Post("/api/assets/{id}/merge", l.merge)
	r.Post("/api/assets/{id}/split", l.split)
	r.Get("/api/assets/{id}/download", l.download)
	r.Get("/api/similar", l.similar)
	r.Get("/api/jobs", l.jobs)
	r.Post("/api/files/{hash}/retry", l.retry)
	r.Post("/api/uploads", l.prepare)
	r.Get("/api/uploads/{id}", l.uploadStatus)
	r.Put("/api/uploads/{id}", l.chunk)
	r.Post("/api/uploads/{id}/complete", l.commitUpload)
	r.Get("/media/{hash}/{kind}", l.media)
	r.Head("/media/{hash}/{kind}", l.media)
	static := http.FileServer(http.FS(frontend))
	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		if strings.HasPrefix(name, "api/") || strings.HasPrefix(name, "media/") {
			http.NotFound(w, r)
			return
		}
		if strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		if _, e := fs.Stat(frontend, name); e != nil {
			name = "index.html"
		}
		if name == "index.html" {
			b, e := fs.ReadFile(frontend, name)
			if e != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Write(b)
			return
		}
		if strings.HasPrefix(name, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		static.ServeHTTP(w, r)
	})
	r.Head("/*", func(w http.ResponseWriter, r *http.Request) { static.ServeHTTP(w, r) })
	return http.HandlerFunc(func(w http.ResponseWriter, rq *http.Request) {
		if strings.HasPrefix(rq.URL.Path, "/aura/") {
			q := rq.Clone(rq.Context())
			u := *rq.URL
			u.Path = strings.TrimPrefix(u.Path, "/aura")
			q.URL = &u
			r.ServeHTTP(w, q)
			return
		}
		r.ServeHTTP(w, rq)
	})
}
func (l *Library) info(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"name": "Aura", "version": "0.1.0", "chunkSize": chunkSize}
	counts := map[string]string{
		"total": "SELECT count(*) FROM assets WHERE trashed_at=''", "favorites": "SELECT count(*) FROM assets WHERE favorite=1 AND trashed_at=''",
		"live": "SELECT count(*) FROM assets WHERE kind='live' AND trashed_at=''", "videos": "SELECT count(*) FROM assets WHERE kind='video' AND trashed_at=''",
		"trash": "SELECT count(*) FROM assets WHERE trashed_at!=''", "originals": "SELECT count(*) FROM files", "bytes": "SELECT COALESCE(sum(size),0) FROM files",
		"queued": "SELECT count(*) FROM files WHERE status IN ('queued','processing')", "errors": "SELECT count(*) FROM files WHERE status='error'",
		"grouped": "SELECT count(*) FROM assets a WHERE (SELECT count(*) FROM files f WHERE f.asset_id=a.id AND f.mime LIKE 'image/%')>1",
	}
	for k, q := range counts {
		var n int64
		if e := l.DB.QueryRow(q).Scan(&n); e != nil {
			fail(w, 500, e)
			return
		}
		out[k] = n
	}
	writeJSON(w, 200, out)
}
func (l *Library) list(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where := "WHERE a.trashed_at=''"
	args := []any{}
	switch q.Get("view") {
	case "favorites":
		where += " AND a.favorite=1"
	case "live":
		where += " AND a.kind='live'"
	case "videos":
		where += " AND a.kind='video'"
	case "trash":
		where = "WHERE a.trashed_at!=''"
	case "grouped":
		where += " AND (SELECT count(*) FROM files v WHERE v.asset_id=a.id AND v.mime LIKE 'image/%')>1"
	}
	if search := strings.TrimSpace(q.Get("q")); search != "" {
		where += ` AND EXISTS (SELECT 1 FROM files s WHERE s.asset_id=a.id AND (s.name LIKE ? ESCAPE '\' OR s.metadata LIKE ? ESCAPE '\'))`
		search = strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(search)
		args = append(args, "%"+search+"%", "%"+search+"%")
	}
	if from := q.Get("from"); from != "" {
		where += " AND substr(a.captured_at,1,10)>=?"
		args = append(args, from)
	}
	if to := q.Get("to"); to != "" {
		where += " AND substr(a.captured_at,1,10)<=?"
		args = append(args, to)
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit < 1 || limit > 240 {
		limit = 120
	}
	if cursor := q.Get("cursor"); cursor != "" {
		parts := strings.SplitN(cursor, "|", 2)
		if len(parts) != 2 {
			fail(w, 400, "分页位置无效")
			return
		}
		where += " AND (a.captured_at<? OR (a.captured_at=? AND a.id<?))"
		args = append(args, parts[0], parts[0], parts[1])
	}
	args = append(args, limit+1)
	rows, e := l.DB.Query(assetSelect+where+" ORDER BY a.captured_at DESC,a.id DESC LIMIT ?", args...)
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer rows.Close()
	items := []Asset{}
	for rows.Next() {
		a, e := scanAsset(rows)
		if e != nil {
			fail(w, 500, e)
			return
		}
		items = append(items, a)
	}
	if e = rows.Err(); e != nil {
		fail(w, 500, e)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		a := items[len(items)-1]
		next = a.CapturedAt + "|" + a.ID
	}
	writeJSON(w, 200, map[string]any{"items": items, "next": next})
}
func (l *Library) detail(w http.ResponseWriter, r *http.Request) {
	a, e := l.Asset(chi.URLParam(r, "id"))
	if e != nil {
		fail(w, 404, "照片不存在")
		return
	}
	files, e := l.Files(a.ID)
	if e != nil {
		fail(w, 500, e)
		return
	}
	merged := map[string]any{}
	for i := len(files) - 1; i >= 0; i-- {
		var m map[string]any
		_ = json.Unmarshal(files[i].Metadata, &m)
		for k, v := range m {
			merged[k] = v
		}
	}
	writeJSON(w, 200, map[string]any{"asset": a, "files": files, "metadata": merged})
}
func (l *Library) updateAsset(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Favorite *bool  `json:"favorite"`
		Trash    *bool  `json:"trash"`
		Primary  string `json:"primary"`
	}
	if !decode(w, r, &p) {
		return
	}
	id := chi.URLParam(r, "id")
	if _, e := l.Asset(id); e != nil {
		fail(w, 404, "照片不存在")
		return
	}
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	if p.Favorite != nil {
		_, e = tx.Exec("UPDATE assets SET favorite=? WHERE id=?", *p.Favorite, id)
	}
	if e == nil && p.Trash != nil {
		value := ""
		if *p.Trash {
			value = now()
		}
		_, e = tx.Exec("UPDATE assets SET trashed_at=? WHERE id=?", value, id)
	}
	if e == nil && p.Primary != "" {
		var m string
		e = tx.QueryRow("SELECT mime FROM files WHERE hash=? AND asset_id=?", p.Primary, id).Scan(&m)
		if e == nil && !strings.HasPrefix(m, "image/") {
			e = fmt.Errorf("主版本必须为照片")
		}
		if e == nil {
			_, e = tx.Exec("UPDATE assets SET primary_hash=? WHERE id=?", p.Primary, id)
		}
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 400, e)
		return
	}
	a, e := l.Asset(id)
	if e != nil {
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, a)
}
func (l *Library) merge(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var p struct {
		Other string `json:"other"`
	}
	if !decode(w, r, &p) {
		return
	}
	if id == p.Other {
		fail(w, 400, "请选择两张不同照片")
		return
	}
	if _, e := l.Asset(id); e != nil {
		fail(w, 404, "照片不存在")
		return
	}
	if _, e := l.Asset(p.Other); e != nil {
		fail(w, 404, "照片不存在")
		return
	}
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	e = mergeTx(tx, id, p.Other, "user review")
	if e == nil {
		e = refreshTx(tx, id)
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, map[string]string{"id": id})
}
func (l *Library) split(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var p struct {
		Hash string `json:"hash"`
	}
	if !decode(w, r, &p) {
		return
	}
	files, e := l.Files(id)
	if e != nil || len(files) < 2 {
		fail(w, 400, "没有可分离的版本")
		return
	}
	var f File
	for _, v := range files {
		if v.Hash == p.Hash {
			f = v
		}
	}
	if f.Hash == "" {
		fail(w, 404, "版本不存在")
		return
	}
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	newID := ID()
	_, e = tx.Exec("INSERT INTO assets(id,captured_at,created_at) VALUES(?,?,?)", newID, f.CapturedAt, now())
	if e == nil {
		_, e = tx.Exec("UPDATE files SET asset_id=? WHERE hash=?", newID, f.Hash)
	}
	// Explicit splitting removes automatic keys for the old group; a later import can rediscover exact duplicates.
	if e == nil {
		_, e = tx.Exec("DELETE FROM asset_keys WHERE asset_id=?", id)
	}
	if e == nil {
		e = refreshTx(tx, id)
	}
	if e == nil {
		e = refreshTx(tx, newID)
	}
	if e == nil {
		_, e = tx.Exec("INSERT INTO decisions VALUES(?,?,?,?)", ID(), "split", marshal(map[string]string{"from": id, "to": newID, "hash": f.Hash}), now())
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, map[string]string{"id": newID})
}
func (l *Library) jobs(w http.ResponseWriter, r *http.Request) {
	rows, e := l.DB.Query("SELECT " + fileColumns + " FROM files WHERE status IN ('queued','processing','error') ORDER BY created_at DESC LIMIT 100")
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer rows.Close()
	out := []File{}
	for rows.Next() {
		f, e := scanFile(rows)
		if e != nil {
			fail(w, 500, e)
			return
		}
		out = append(out, f)
	}
	writeJSON(w, 200, out)
}
func (l *Library) retry(w http.ResponseWriter, r *http.Request) {
	h := chi.URLParam(r, "hash")
	res, e := l.DB.Exec("UPDATE files SET status='queued',error='' WHERE hash=? AND status IN ('ready','error')", h)
	if e != nil {
		fail(w, 500, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		fail(w, 409, "资源正在处理或不存在")
		return
	}
	l.Notify()
	writeJSON(w, 202, map[string]string{"status": "queued"})
}
func (l *Library) media(w http.ResponseWriter, r *http.Request) {
	hash, kind := chi.URLParam(r, "hash"), chi.URLParam(r, "kind")
	if !validHash.MatchString(hash) {
		http.NotFound(w, r)
		return
	}
	f, e := l.File(hash)
	if e != nil {
		http.NotFound(w, r)
		return
	}
	path := ""
	switch kind {
	case "original":
		path = l.Object(hash)
		w.Header().Set("Content-Type", f.Mime)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": f.Name}))
	case "thumb":
		path = l.Derived(hash, "-thumb.jpg")
		w.Header().Set("Content-Type", "image/jpeg")
	case "preview":
		path = l.Derived(hash, "-preview.jpg")
		w.Header().Set("Content-Type", "image/jpeg")
	case "play":
		path = l.Derived(hash, "-play.mp4")
		w.Header().Set("Content-Type", "video/mp4")
	default:
		http.NotFound(w, r)
		return
	}
	if _, e = os.Stat(path); e != nil {
		if kind != "original" && f.Status == "ready" {
			_, _ = l.DB.Exec("UPDATE files SET status='queued' WHERE hash=? AND status='ready'", hash)
			l.Notify()
		}
		fail(w, 404, "预览尚未就绪，原件已保存")
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("ETag", `"`+hash+"-"+kind+`"`)
	http.ServeFile(w, r, path)
}
func (l *Library) download(w http.ResponseWriter, r *http.Request) {
	a, e := l.Asset(chi.URLParam(r, "id"))
	if e != nil {
		fail(w, 404, "照片不存在")
		return
	}
	files, e := l.Files(a.ID)
	if e != nil {
		fail(w, 500, e)
		return
	}
	for _, f := range files {
		if _, e = os.Stat(l.Object(f.Hash)); e != nil {
			fail(w, 500, "原件暂不可读")
			return
		}
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": strings.TrimSuffix(a.Name, filepath.Ext(a.Name)) + ".zip"}))
	w.Header().Set("Cache-Control", "no-store")
	zw := zip.NewWriter(w)
	defer zw.Close()
	manifest := map[string]any{"format": "aura-originals-v1", "asset": a, "files": files}
	entry, e := zw.Create("aura.json")
	if e != nil {
		return
	}
	if _, e = entry.Write([]byte(marshal(manifest))); e != nil {
		return
	}
	for i, f := range files {
		hdr := &zip.FileHeader{Name: fmt.Sprintf("originals/%02d-%s", i+1, f.Name), Method: zip.Store}
		hdr.SetMode(0600)
		dst, e := zw.CreateHeader(hdr)
		if e != nil {
			return
		}
		src, e := os.Open(l.Object(f.Hash))
		if e != nil {
			return
		}
		_, e = io.Copy(dst, src)
		src.Close()
		if e != nil {
			return
		}
	}
}

type similarItem struct {
	ID, Hash string
	Value    uint64
	Ratio    float64
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
func (n *bkNode) find(v similarItem, out *[]map[string]any) {
	d := bits.OnesCount64(n.Item.Value ^ v.Value)
	if d <= 4 && math.Abs(n.Item.Ratio-v.Ratio) < 0.03 {
		*out = append(*out, map[string]any{"left": n.Item.ID, "right": v.ID, "distance": d})
	}
	for step, child := range n.Children {
		if step >= d-4 && step <= d+4 {
			child.find(v, out)
		}
	}
}
func (l *Library) similar(w http.ResponseWriter, r *http.Request) {
	rows, e := l.DB.Query("SELECT a.id,f.hash,f.dhash,f.width,f.height FROM assets a JOIN files f ON f.hash=a.primary_hash WHERE a.trashed_at='' AND f.dhash!='' ORDER BY a.captured_at DESC")
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer rows.Close()
	var root *bkNode
	out := []map[string]any{}
	for rows.Next() {
		if r.Context().Err() != nil {
			return
		}
		var item similarItem
		var h string
		var width, height int
		if e = rows.Scan(&item.ID, &item.Hash, &h, &width, &height); e != nil {
			fail(w, 500, e)
			return
		}
		if height == 0 {
			continue
		}
		item.Value, _ = strconv.ParseUint(h, 16, 64)
		item.Ratio = float64(width) / float64(height)
		if root == nil {
			root = &bkNode{item, map[int]*bkNode{}}
		} else {
			root.find(item, &out)
			root.add(item)
		}
		if len(out) >= 100 {
			break
		}
	}
	writeJSON(w, 200, out)
}
