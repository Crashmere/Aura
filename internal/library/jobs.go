package library

import (
	"database/sql"
	"net/http"
)

type jobSummary struct {
	Hash      string `json:"hash"`
	AssetID   string `json:"assetId"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Mime      string `json:"mime"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	CreatedAt string `json:"createdAt"`
}

func (l *Library) pagedJobs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status := q.Get("status")
	if status == "" {
		status = "all"
	}
	if status != "all" && status != "queued" && status != "processing" && status != "error" && status != "ready" {
		fail(w, 400, "处理状态无效")
		return
	}
	date, hash, ok := pageCursor(w, q.Get("cursor"))
	if !ok {
		return
	}
	counts := map[string]int64{"queued": 0, "processing": 0, "error": 0, "ready": 0, "all": 0}
	countRows, e := l.DB.Query("SELECT status,count(*) FROM files GROUP BY status")
	if e != nil {
		fail(w, 500, e)
		return
	}
	for countRows.Next() {
		var state string
		var count int64
		if e = countRows.Scan(&state, &count); e != nil {
			countRows.Close()
			fail(w, 500, e)
			return
		}
		counts[state] = count
		counts["all"] += count
	}
	e = countRows.Err()
	countRows.Close()
	if e != nil {
		fail(w, 500, e)
		return
	}
	where := "WHERE 1=1"
	args := []any{}
	if status != "all" {
		where += " AND status=?"
		args = append(args, status)
	}
	if date != "" {
		where += " AND (created_at<? OR (created_at=? AND hash<?))"
		args = append(args, date, date, hash)
	}
	limit := pageLimit(q, 50, 240)
	args = append(args, limit+1)
	rows, e := l.DB.Query("SELECT hash,asset_id,name,size,mime,status,error,created_at FROM files "+where+" ORDER BY created_at DESC,hash DESC LIMIT ?", args...)
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer rows.Close()
	items := []jobSummary{}
	for rows.Next() {
		var file jobSummary
		if e = rows.Scan(&file.Hash, &file.AssetID, &file.Name, &file.Size, &file.Mime, &file.Status, &file.Error, &file.CreatedAt); e != nil {
			fail(w, 500, e)
			return
		}
		items = append(items, file)
	}
	if e = rows.Err(); e != nil {
		fail(w, 500, e)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		file := items[len(items)-1]
		next = file.CreatedAt + "|" + file.Hash
	}
	writeJSON(w, 200, map[string]any{"items": items, "next": next, "counts": counts})
}

func (l *Library) retryErrors(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Hashes []string `json:"hashes"`
	}
	if !decode(w, r, &p) {
		return
	}
	if len(p.Hashes) == 0 || len(p.Hashes) > 1000 {
		fail(w, 400, "每次请选择 1-1000 个失败资源")
		return
	}
	hashes := []string{}
	seen := map[string]bool{}
	for _, hash := range p.Hashes {
		if !validHash.MatchString(hash) {
			fail(w, 400, "资源标识无效")
			return
		}
		if !seen[hash] {
			hashes = append(hashes, hash)
			seen[hash] = true
		}
	}
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	for _, hash := range hashes {
		var status string
		e = tx.QueryRow("SELECT status FROM files WHERE hash=?", hash).Scan(&status)
		if e == sql.ErrNoRows {
			fail(w, 400, "资源不存在")
			return
		}
		if e != nil {
			fail(w, 500, e)
			return
		}
		if status != "error" {
			fail(w, 409, "部分资源不再处于失败状态，请刷新后重试")
			return
		}
	}
	for _, hash := range hashes {
		if _, e = tx.Exec("UPDATE files SET status='queued',error='' WHERE hash=?", hash); e != nil {
			fail(w, 500, e)
			return
		}
	}
	if e = tx.Commit(); e != nil {
		fail(w, 500, e)
		return
	}
	l.Notify()
	writeJSON(w, 202, map[string]int{"queued": len(hashes)})
}
