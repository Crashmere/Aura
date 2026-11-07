package library

import (
	"archive/zip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
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
			if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
				l.Notify()
			}
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
	r.Get("/api/playback/{hash}", l.playbackInfo)
	r.Get("/api/assets", l.list)
	r.Get("/api/filter-options", l.filterOptions)
	r.Patch("/api/assets", l.batchUpdateAssets)
	r.Post("/api/assets/purge", l.purgeAssets)
	r.Get("/api/deletions/{id}", l.getDeletion)
	r.Get("/api/timeline", l.timeline)
	r.Get("/api/albums", l.listAlbums)
	r.Post("/api/albums", l.createAlbum)
	r.Post("/api/albums/common", l.commonAlbums)
	r.Delete("/api/albums/assets", l.removeAssetsFromAlbums)
	r.Post("/api/albums/import", l.importAlbum)
	r.Patch("/api/albums/group", l.moveAlbumGroup)
	r.Get("/api/album-groups", l.listAlbumGroups)
	r.Post("/api/album-groups", l.createAlbumGroup)
	r.Patch("/api/album-groups/order", l.orderAlbumGroups)
	r.Patch("/api/album-groups/{id}", l.updateAlbumGroup)
	r.Delete("/api/album-groups/{id}", l.updateAlbumGroup)
	r.Get("/api/albums/{id}", l.albumDetail)
	r.Patch("/api/albums/{id}", l.renameAlbum)
	r.Patch("/api/albums/{id}/cover", l.setAlbumCover)
	r.Delete("/api/albums/{id}", l.deleteAlbum)
	r.Post("/api/albums/{id}/assets", l.changeAlbumAssets)
	r.Delete("/api/albums/{id}/assets", l.changeAlbumAssets)
	r.Get("/api/assets/{id}", l.detail)
	r.Get("/api/assets/{id}/similar", l.assetSimilar)
	r.Patch("/api/assets/{id}", l.updateAsset)
	r.Patch("/api/assets/{id}/rotation", l.rotate)
	r.Patch("/api/assets/{id}/cover", l.saveCover)
	r.Get("/api/assets/{id}/frame", l.frame)
	r.Post("/api/assets/{id}/merge", l.merge)
	r.Post("/api/assets/{id}/split", l.split)
	r.Get("/api/assets/{id}/download", l.download)
	r.Get("/api/similar", l.similar)
	r.Get("/api/review-history", l.reviewHistory)
	r.Post("/api/splits/{id}/restore", l.restoreSplit)
	r.Post("/api/similar/ignore", l.ignoreSimilar)
	r.Delete("/api/similar/ignore", l.ignoreSimilar)
	r.Get("/api/jobs", l.jobs)
	r.Post("/api/files/retry", l.retryErrors)
	r.Post("/api/files/{hash}/retry", l.retry)
	r.Post("/api/files/{hash}/rebuild-cover", l.rebuildCover)
	r.Post("/api/uploads", l.prepare)
	r.Get("/api/uploads", l.listUploads)
	r.Get("/api/uploads/{id}", l.uploadStatus)
	r.Put("/api/uploads/{id}", l.chunk)
	r.Post("/api/uploads/{id}/complete", l.commitUpload)
	r.Get("/media/{hash}/stream/index.m3u8", l.streamPlaylist)
	r.Head("/media/{hash}/stream/index.m3u8", l.streamPlaylist)
	r.Get("/media/{hash}/stream/{segment}.ts", l.streamSegment)
	r.Head("/media/{hash}/stream/{segment}.ts", l.streamSegment)
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
	out := map[string]any{"name": "Aura", "version": "0.3.0", "chunkSize": chunkSize, "processingConcurrency": l.ProcessingLimits,
		"similarityIndex":      l.dinoSnapshot(),
		"videoSimilarityIndex": l.videoSimilarityStatus(),
		"capabilities":         map[string]bool{"originalPresence": true, "albumImport": true, "processingPages": true, "uploadPages": true, "similarReview": true, "dinoSimilarity": true, "timeline": true, "permanentDelete": true, "rotation": true, "coverFrames": true}}
	value, err := l.cachedCatalog(r.Context(), "info", "library", func() (any, error) {
		values := map[string]int64{}
		counts := map[string]string{
			"total": "SELECT count(*) FROM assets WHERE trashed_at=''", "favorites": "SELECT count(*) FROM assets WHERE favorite=1 AND trashed_at=''",
			"live": "SELECT count(*) FROM assets WHERE kind='live' AND trashed_at=''", "videos": "SELECT count(*) FROM assets WHERE kind='video' AND trashed_at=''",
			"trash": "SELECT count(*) FROM assets WHERE trashed_at!=''", "originals": "SELECT count(*) FROM files", "bytes": "SELECT COALESCE(sum(size),0) FROM files",
			"queued": "SELECT count(*) FROM files WHERE status IN ('queued','processing')", "errors": "SELECT count(*) FROM files WHERE status='error'",
			"grouped":          "SELECT count(*) FROM assets a WHERE a.trashed_at='' AND " + imageVersionsSQL + ">1",
			"automatic":        "SELECT count(*) FROM assets a WHERE a.trashed_at='' AND " + groupingFilterSQL("automatic"),
			"merged":           "SELECT count(*) FROM assets a WHERE a.trashed_at='' AND " + groupingFilterSQL("manual"),
			"pendingDeletions": `SELECT count(*) FROM deletion_pending`,
		}
		for k, q := range counts {
			var n int64
			if e := l.DB.QueryRow(q).Scan(&n); e != nil {
				return nil, e
			}
			values[k] = n
		}
		return values, nil
	})
	if err != nil {
		fail(w, 500, err)
		return
	}
	for key, value := range value.(map[string]int64) {
		out[key] = value
	}
	revision, _ := l.revision(r.Context(), "library")
	out["revision"] = revision

	writeJSON(w, 200, out)
}
func (l *Library) list(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	where, args, ok := l.assetFilter(w, q)
	if !ok {
		return
	}
	if raw := q.Get("ids"); raw != "" {
		ids := strings.Split(raw, ",")
		if len(ids) > 1000 {
			fail(w, 400, "每次最多刷新 1000 项")
			return
		}
		for _, id := range ids {
			if !validID.MatchString(id) {
				fail(w, 400, "照片编号无效")
				return
			}
		}
		where += " AND a.id IN (" + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + ")"
		for _, id := range ids {
			args = append(args, id)
		}
	}
	maximum := 240
	if q.Get("ids") != "" {
		maximum = 1000
	}
	limit := pageLimit(q, 120, maximum)
	date, id, ok := pageCursor(w, q.Get("cursor"))
	if !ok {
		return
	}
	if date != "" {
		where += " AND (a.captured_at<? OR (a.captured_at=? AND a.id<?))"
		args = append(args, date, date, id)
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
	rows.Close()
	next := ""
	if len(items) > limit {
		items = items[:limit]
		a := items[len(items)-1]
		next = a.CapturedAt + "|" + a.ID
	}
	if e = l.addAssetSimilarCounts(r.Context(), items); e != nil {
		fail(w, 500, e)
		return
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
	writeJSON(w, 200, map[string]any{"asset": a, "files": files, "metadata": merged, "edits": l.editRecords(files)})
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
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	var exists bool
	if e = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?)", id).Scan(&exists); e != nil {
		fail(w, 500, e)
		return
	}
	if !exists {
		fail(w, 404, "照片不存在")
		return
	}
	if !allowAssetMutation(w, tx, id) {
		return
	}
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
		e = setPrimaryTx(tx, id, p.Primary)
		if e == nil {
			e = refreshTx(tx, id)
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

func (l *Library) batchUpdateAssets(w http.ResponseWriter, r *http.Request) {
	var p struct {
		IDs   []string `json:"ids"`
		Trash *bool    `json:"trash"`
	}
	if !decode(w, r, &p) {
		return
	}
	if len(p.IDs) == 0 || len(p.IDs) > 1000 || p.Trash == nil {
		fail(w, 400, "每次请选择 1-1000 张照片并指定删除状态")
		return
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, id := range p.IDs {
		if !validID.MatchString(id) {
			fail(w, 400, "照片标识无效")
			return
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	for _, id := range ids {
		var exists bool
		if e = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?)", id).Scan(&exists); e != nil {
			fail(w, 500, e)
			return
		}
		if !exists {
			fail(w, 404, "部分照片不存在，请刷新后重试")
			return
		}
		if !allowAssetMutation(w, tx, id) {
			return
		}
	}
	trashed := ""
	if *p.Trash {
		trashed = now()
	}
	for _, id := range ids {
		if _, e = tx.Exec("UPDATE assets SET trashed_at=? WHERE id=?", trashed, id); e != nil {
			fail(w, 500, e)
			return
		}
	}
	if e = tx.Commit(); e != nil {
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, map[string]any{"updated": ids})
}

func (l *Library) merge(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var p struct {
		Other   string `json:"other"`
		Primary string `json:"primary"`
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
	if e == nil && p.Primary != "" {
		e = setPrimaryTx(tx, id, p.Primary)
	}
	if e == nil {
		e = refreshTx(tx, id)
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		if errors.Is(e, errPrimarySelection) {
			fail(w, 400, e)
			return
		}
		var pending *pendingDeletion
		if errors.As(e, &pending) {
			assetDeletionFailure(w, pending.request)
			return
		}
		if errors.Is(e, errTrashStateConflict) {
			writeJSON(w, 409, map[string]string{"error": e.Error(), "code": "trash_state_conflict"})
			return
		}
		if errors.Is(e, sql.ErrNoRows) {
			fail(w, 404, "照片不存在")
			return
		}
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
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	var trashed string
	var favorite bool
	if e = tx.QueryRow("SELECT trashed_at,favorite FROM assets WHERE id=?", id).Scan(&trashed, &favorite); e != nil {
		if e == sql.ErrNoRows {
			fail(w, 404, "照片不存在")
		} else {
			fail(w, 500, e)
		}
		return
	}
	if !allowAssetMutation(w, tx, id) {
		return
	}
	var count int
	if e = tx.QueryRow("SELECT count(*) FROM files WHERE asset_id=?", id).Scan(&count); e != nil {
		fail(w, 500, e)
		return
	}
	if count < 2 {
		fail(w, 400, "没有可分离的版本")
		return
	}
	f, e := scanFile(tx.QueryRow("SELECT "+fileColumns+" FROM files WHERE hash=? AND asset_id=?", p.Hash, id))
	if e != nil {
		if e == sql.ErrNoRows {
			fail(w, 404, "版本不存在")
		} else {
			fail(w, 500, e)
		}
		return
	}
	var anchor string
	if e = tx.QueryRow("SELECT hash FROM files WHERE asset_id=? AND hash!=? ORDER BY score DESC,created_at LIMIT 1", id, f.Hash).Scan(&anchor); e != nil {
		fail(w, 500, e)
		return
	}
	newID := ID()
	_, e = tx.Exec("INSERT INTO assets(id,captured_at,favorite,trashed_at,created_at) VALUES(?,?,?,?,?)", newID, f.CapturedAt, favorite, trashed, now())
	if e == nil {
		_, e = tx.Exec("UPDATE files SET asset_id=? WHERE hash=?", newID, f.Hash)
	}
	if e == nil {
		_, e = tx.Exec("INSERT INTO album_assets(album_id,asset_id) SELECT album_id,? FROM album_assets WHERE asset_id=?", newID, id)
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
		_, e = tx.Exec("INSERT INTO decisions VALUES(?,?,?,?)", ID(), "split", marshal(splitRecord{From: id, To: newID, Hash: f.Hash, Anchor: anchor, Name: f.Name}), now())
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
	if r.URL.Query().Get("paged") == "true" {
		l.pagedJobs(w, r)
		return
	}
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
	if e = rows.Err(); e != nil {
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, out)
}
func (l *Library) retry(w http.ResponseWriter, r *http.Request) {
	h := chi.URLParam(r, "hash")
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	if e = originalDeletion(tx, h, ""); e != nil {
		originalFailure(w, e)
		return
	}
	res, e := tx.Exec("UPDATE files SET status='queued',error='' WHERE hash=? AND status IN ('ready','error')", h)
	if e != nil {
		fail(w, 500, e)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		fail(w, 409, "资源正在处理或不存在")
		return
	}
	if e = tx.Commit(); e != nil {
		fail(w, 500, e)
		return
	}
	l.Notify()
	writeJSON(w, 202, map[string]string{"status": "queued"})
}
func (l *Library) media(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	hash, kind := chi.URLParam(r, "hash"), chi.URLParam(r, "kind")
	if !validHash.MatchString(hash) {
		http.NotFound(w, r)
		return
	}
	if e := originalDeletion(l.DB, hash, ""); e != nil {
		originalFailure(w, e)
		return
	}
	f, e := l.File(hash)
	if e != nil {
		http.NotFound(w, r)
		return
	}
	if kind == "play" {
		query := r.URL.Query().Encode()
		target := "/aura/media/" + hash + "/stream/index.m3u8"
		if query != "" {
			target += "?" + query
		}
		http.Redirect(w, r, target, http.StatusTemporaryRedirect)
		return
	}
	path := ""
	rotation := f.Rotation
	if kind != "original" {
		if values, present := r.URL.Query()["rotation"]; present {
			if len(values) != 1 {
				fail(w, 400, "旋转方向无效")
				return
			}
			rotation, e = strconv.Atoi(values[0])
			if e != nil || !validRotation(rotation) {
				fail(w, 400, "旋转方向无效")
				return
			}
		}
	}
	if kind == "thumb" || kind == "preview" {
		if values, present := r.URL.Query()["cover"]; present {
			if len(values) != 1 || values[0] != "original" && !validID.MatchString(values[0]) {
				fail(w, 400, "封面版本无效")
				return
			}
			if values[0] == "original" {
				f.Cover = nil
			} else if coverRevision(f) != values[0] {
				frameFailure(w, errCoverConflict)
				return
			}
		}
	}
	switch kind {
	case "original":
		path = l.Object(hash)
		w.Header().Set("Content-Type", f.Mime)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": f.Name}))
	case "source":
		sourceMime := playbackSourceMime(f.Mime)
		if sourceMime == "" {
			http.NotFound(w, r)
			return
		}
		if rotation != 0 {
			fail(w, 409, "此播放方向需要按需转码")
			return
		}
		path = l.Object(hash)
		w.Header().Set("Content-Type", sourceMime)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": f.Name}))
	case "thumb":
		path = l.Derived(hash, "-thumb.jpg")
		w.Header().Set("Content-Type", "image/jpeg")
	case "preview":
		path = l.Derived(hash, "-preview.jpg")
		w.Header().Set("Content-Type", "image/jpeg")
	default:
		http.NotFound(w, r)
		return
	}
	if kind != "original" && kind != "source" && (rotation != 0 || f.Cover != nil && (kind == "thumb" || kind == "preview")) {
		targets := []File{f}
		if f.Cover != nil && f.Cover.Motion != hash && (kind == "thumb" || kind == "preview") {
			targets = append(targets, File{Hash: f.Cover.Motion})
		}
		unlock := l.lockFrameTargets(targets)
		current, err := l.File(hash)
		if err == nil && (kind == "thumb" || kind == "preview") {
			if requested := r.URL.Query().Get("cover"); requested == "original" {
				current.Cover = nil
			} else if coverRevision(current) != coverRevision(f) {
				err = errCoverConflict
			}
		}
		if err == nil {
			ctx := r.Context()
			var finish func()
			if current.Cover != nil && (kind == "thumb" || kind == "preview") && (!readyDerivative(l.coverPath(current, "preview")) || !readyDerivative(l.coverPath(current, "thumb"))) {
				ctx, finish, err = l.beginFrameWork(ctx, targets)
			}
			if err == nil {
				path, err = l.rotatedDerivative(ctx, current, kind, rotation)
			}
			if finish != nil {
				finish()
			}
		}
		unlock()
		if errors.Is(err, errCoverConflict) {
			frameFailure(w, err)
			return
		}
		if err != nil && f.Cover != nil && (kind == "thumb" || kind == "preview") {
			frameFailure(w, err)
			return
		}
		if err != nil && !os.IsNotExist(err) && !errors.Is(err, errRotationNotReady) {
			originalFailure(w, err)
			return
		}
	}
	file, e := os.Open(path)
	if e != nil {
		if e = originalDeletion(l.DB, hash, ""); e != nil {
			originalFailure(w, e)
			return
		}
		if kind == "original" || kind == "source" {
			writeJSON(w, 503, map[string]string{"error": "原件暂不可读，请检查存储或重新选择源文件修复", "code": "original_missing"})
			return
		}
		if f.Status == "ready" {
			tx, err := l.DB.Begin()
			if err == nil {
				err = originalDeletion(tx, hash, "")
				if err == nil {
					_, err = tx.Exec("UPDATE files SET status='queued' WHERE hash=? AND status='ready'", hash)
				}
				if err == nil {
					err = tx.Commit()
				}
				tx.Rollback()
			}
			if err != nil {
				originalFailure(w, err)
				return
			}
			l.Notify()
		}
		fail(w, 404, "预览尚未就绪，原件已保存")
		return
	}
	defer file.Close()
	if e = originalDeletion(l.DB, hash, ""); e != nil {
		originalFailure(w, e)
		return
	}
	stat, e := file.Stat()
	if e != nil || !stat.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	// Derivatives can be rebuilt without changing the original's hash. Validate the
	// opened representation so revalidation and If-Range never identify old bytes.
	etag := `"` + hash + `"`
	if kind != "original" && kind != "source" {
		etag = fmt.Sprintf(`"%s-%s-%d-%x-%x"`, hash, kind, rotation, stat.Size(), stat.ModTime().UnixNano())
	}
	w.Header().Set("ETag", etag)
	http.ServeContent(w, r, stat.Name(), stat.ModTime(), file)
}
func (l *Library) download(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var deletedHash string
	e := l.DB.QueryRow(`SELECT json_extract(d.detail,'$.hashes[0]') FROM decisions d,json_each(d.detail,'$.ids') a
 WHERE d.action='purge-request' AND a.value=? LIMIT 1`, id).Scan(&deletedHash)
	if e == nil {
		originalFailure(w, &deletedOriginal{Scope: "hash", Hash: deletedHash})
		return
	}
	if e != sql.ErrNoRows {
		fail(w, 500, e)
		return
	}
	a, e := l.Asset(id)
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
		if e = originalDeletion(l.DB, f.Hash, ""); e != nil {
			originalFailure(w, e)
			return
		}
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
		if e = originalDeletion(l.DB, f.Hash, ""); e != nil {
			return
		}
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
