package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type queryer interface {
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
}

type deletionPlan struct {
	IDs        []string `json:"ids"`
	Hashes     []string `json:"hashes"`
	SourceKeys []string `json:"sourceKeys"`
	Bytes      int64    `json:"bytes"`
}

type deletionStatus struct {
	ID    string   `json:"id"`
	State string   `json:"state"`
	IDs   []string `json:"ids"`
	Bytes int64    `json:"bytes"`
	Error string   `json:"error,omitempty"`
}

type deletedOriginal struct {
	Scope     string
	Hash      string
	SourceKey string
}

func (e *deletedOriginal) Error() string {
	return "原件已被永久删除，不会自动重新导入"
}

func deletedFailure(w http.ResponseWriter, e error) bool {
	var deleted *deletedOriginal
	if !errors.As(e, &deleted) {
		return false
	}
	result := map[string]any{"error": deleted.Error(), "code": "original_deleted", "deleted": true, "scope": deleted.Scope, "hash": deleted.Hash}
	if deleted.Scope == "source" {
		result["sourceKey"] = deleted.SourceKey
	}
	writeJSON(w, 410, result)
	return true
}

func originalDeletion(q queryer, hash, source string) error {
	var exists bool
	if e := q.QueryRow(`SELECT EXISTS(SELECT 1 FROM decisions d,json_each(d.detail,'$.hashes') h
 WHERE d.action='purge-request' AND h.value=?)`, hash).Scan(&exists); e != nil {
		return e
	}
	if exists {
		return &deletedOriginal{Scope: "hash", Hash: hash}
	}
	if source != "" {
		if e := q.QueryRow(`SELECT EXISTS(SELECT 1 FROM decisions d,json_each(d.detail,'$.sourceKeys') s
 WHERE d.action='purge-request' AND s.value=?)`, source).Scan(&exists); e != nil {
			return e
		}
		if exists {
			return &deletedOriginal{Scope: "source", Hash: hash, SourceKey: source}
		}
	}
	return nil
}

func assetDeletion(q queryer, id string) (string, error) {
	var request string
	e := q.QueryRow(`SELECT d.id FROM decisions d,json_each(d.detail,'$.ids') a
 WHERE d.action='purge-request' AND a.value=? AND NOT EXISTS
 (SELECT 1 FROM decisions c WHERE c.action='purge-complete' AND json_extract(c.detail,'$.requestId')=d.id)
 LIMIT 1`, id).Scan(&request)
	if e == sql.ErrNoRows {
		return "", nil
	}
	return request, e
}

func assetDeletionFailure(w http.ResponseWriter, request string) {
	writeJSON(w, 409, map[string]string{"error": "照片正在永久删除，不能再修改或恢复", "code": "asset_deletion_pending", "requestId": request})
}

func allowAssetMutation(w http.ResponseWriter, q queryer, id string) bool {
	request, e := assetDeletion(q, id)
	if e != nil {
		fail(w, 500, e)
		return false
	}
	if request != "" {
		assetDeletionFailure(w, request)
		return false
	}
	return true
}

func (l *Library) getDeletion(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !validID.MatchString(id) {
		fail(w, 404, "删除任务不存在")
		return
	}
	status, _, e := readDeletion(l.DB, id)
	if e != nil {
		if e == sql.ErrNoRows {
			fail(w, 404, "删除任务不存在")
		} else {
			fail(w, 500, e)
		}
		return
	}
	writeJSON(w, 200, status)
}

func readDeletion(q queryer, id string) (deletionStatus, deletionPlan, error) {
	status := deletionStatus{ID: id, State: "pending"}
	var plan deletionPlan
	var detail string
	e := q.QueryRow("SELECT detail FROM decisions WHERE id=? AND action='purge-request'", id).Scan(&detail)
	if e != nil {
		return status, plan, e
	}
	if e = json.Unmarshal([]byte(detail), &plan); e != nil {
		return status, plan, e
	}
	status.IDs, status.Bytes = plan.IDs, plan.Bytes
	var complete bool
	if e = q.QueryRow("SELECT EXISTS(SELECT 1 FROM decisions WHERE action='purge-complete' AND json_extract(detail,'$.requestId')=?)", id).Scan(&complete); e != nil {
		return status, plan, e
	}
	if complete {
		status.State = "complete"
	} else {
		e = q.QueryRow(`SELECT COALESCE(json_extract(detail,'$.error'),'') FROM decisions
 WHERE action='purge-error' AND json_extract(detail,'$.requestId')=? ORDER BY created_at DESC,id DESC LIMIT 1`, id).Scan(&status.Error)
		if e == sql.ErrNoRows {
			e = nil
		}
	}
	return status, plan, e
}

func (l *Library) purgeAssets(w http.ResponseWriter, r *http.Request) {
	var p struct {
		IDs          []string `json:"ids"`
		Confirmation string   `json:"confirmation"`
	}
	if !decode(w, r, &p) {
		return
	}
	if len(p.IDs) == 0 || len(p.IDs) > 1000 || p.Confirmation != "永久删除" {
		fail(w, 400, "请选择 1-1000 张照片，并确认永久删除")
		return
	}
	ids := []string{}
	chosen := map[string]bool{}
	for _, id := range p.IDs {
		if !validID.MatchString(id) {
			fail(w, 400, "照片标识无效")
			return
		}
		if !chosen[id] {
			chosen[id] = true
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	// Repeating the same selected batch resumes its durable intent, including after a lost response.
	rows, e := tx.Query("SELECT id,detail FROM decisions WHERE action='purge-request' ORDER BY created_at DESC,id DESC")
	if e != nil {
		fail(w, 500, e)
		return
	}
	request := ""
	for rows.Next() {
		var id, detail string
		if e = rows.Scan(&id, &detail); e != nil {
			break
		}
		var old deletionPlan
		if e = json.Unmarshal([]byte(detail), &old); e != nil {
			break
		}
		if sameIDs(ids, old.IDs) {
			request = id
			break
		}
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		fail(w, 500, e)
		return
	}
	if request == "" {
		for _, id := range ids {
			pending, err := assetDeletion(tx, id)
			if err != nil {
				fail(w, 500, err)
				return
			}
			if pending != "" {
				assetDeletionFailure(w, pending)
				return
			}
			var trashed string
			if e = tx.QueryRow("SELECT trashed_at FROM assets WHERE id=?", id).Scan(&trashed); e != nil {
				if e == sql.ErrNoRows {
					fail(w, 404, "部分照片不存在，请刷新后重试")
				} else {
					fail(w, 500, e)
				}
				return
			}
			if trashed == "" {
				writeJSON(w, 409, map[string]string{"error": "只能永久删除最近删除中的照片", "code": "asset_not_trashed"})
				return
			}
		}
		plan, err := planDeletion(tx, ids)
		if err != nil {
			fail(w, 500, err)
			return
		}
		request = ID()
		if _, e = tx.Exec("INSERT INTO decisions(id,action,detail,created_at) VALUES(?,?,?,?)", request, "purge-request", marshal(plan), now()); e != nil {
			fail(w, 500, e)
			return
		}
	}
	status, plan, e := readDeletion(tx, request)
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 500, e)
		return
	}
	if status.State == "pending" {
		l.cancelProcessing(plan.Hashes)
		l.deletionMu.Lock()
		delete(l.deletionAttempts, request)
		l.deletionMu.Unlock()
		l.Notify()
	}
	code := 202
	if status.State == "complete" {
		code = 200
	}
	writeJSON(w, code, map[string]any{"requestId": request, "state": status.State, "accepted": ids})
}

func sameIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	other := append([]string(nil), b...)
	sort.Strings(other)
	for i := range a {
		if a[i] != other[i] {
			return false
		}
	}
	return true
}

func planDeletion(tx *sql.Tx, ids []string) (deletionPlan, error) {
	plan := deletionPlan{IDs: ids, Hashes: []string{}, SourceKeys: []string{}}
	chosen := map[string]bool{}
	for _, id := range ids {
		chosen[id] = true
	}
	type resource struct {
		asset string
		size  int64
	}
	files := map[string]resource{}
	refs := map[string]map[string]bool{}
	addRef := func(hash, source string) {
		if source == "" {
			return
		}
		if refs[source] == nil {
			refs[source] = map[string]bool{}
		}
		refs[source][hash] = true
	}
	rows, e := tx.Query("SELECT hash,asset_id,size,COALESCE(json_extract(hints,'$.sourceKey'),'') FROM files")
	if e != nil {
		return plan, e
	}
	selected := map[string]bool{}
	for rows.Next() {
		var hash, asset, source string
		var size int64
		if e = rows.Scan(&hash, &asset, &size, &source); e != nil {
			break
		}
		files[hash] = resource{asset: asset, size: size}
		selected[hash] = chosen[asset]
		addRef(hash, source)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return plan, e
	}
	rows, e = tx.Query("SELECT hash,COALESCE(json_extract(hints,'$.sourceKey'),'') FROM observations")
	if e != nil {
		return plan, e
	}
	for rows.Next() {
		var hash, source string
		if e = rows.Scan(&hash, &source); e != nil {
			break
		}
		addRef(hash, source)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return plan, e
	}
	uploads := map[string]bool{}
	rows, e = tx.Query("SELECT id,COALESCE(json_extract(hints,'$.sourceKey'),'') FROM uploads")
	if e != nil {
		return plan, e
	}
	for rows.Next() {
		var hash, source string
		if e = rows.Scan(&hash, &source); e != nil {
			break
		}
		uploads[hash] = true
		addRef(hash, source)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return plan, e
	}
	candidates := map[string]bool{}
	for source, hashes := range refs {
		for hash := range hashes {
			if selected[hash] {
				candidates[source] = true
			}
		}
	}
	rows, e = tx.Query("SELECT key,asset_id FROM asset_keys WHERE key LIKE 'source:%'")
	if e != nil {
		return plan, e
	}
	for rows.Next() {
		var key, asset string
		if e = rows.Scan(&key, &asset); e != nil {
			break
		}
		if chosen[asset] {
			candidates[strings.TrimPrefix(key, "source:")] = true
		}
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return plan, e
	}
	deletedHashes := map[string]bool{}
	rows, e = tx.Query("SELECT h.value FROM decisions d,json_each(d.detail,'$.hashes') h WHERE d.action='purge-request'")
	if e != nil {
		return plan, e
	}
	for rows.Next() {
		var hash string
		if e = rows.Scan(&hash); e != nil {
			break
		}
		deletedHashes[hash] = true
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return plan, e
	}
	// A retained split member owns its own bytes, even when old observations share a native source.
	outsideSources := map[string]bool{}
	retainedSources := map[string]bool{}
	for source, hashes := range refs {
		for hash := range hashes {
			if f, exists := files[hash]; exists && f.asset != "" && !chosen[f.asset] {
				outsideSources[source] = true
				if !deletedHashes[hash] {
					retainedSources[source] = true
				}
			}
		}
	}
	ambiguous := map[string]bool{}
	for source := range outsideSources {
		for hash := range refs[source] {
			ambiguous[hash] = true
		}
	}
	for source := range candidates {
		if retainedSources[source] {
			continue
		}
		if !outsideSources[source] {
			for hash := range refs[source] {
				f, exists := files[hash]
				if !deletedHashes[hash] && !ambiguous[hash] && ((!exists && uploads[hash]) || (exists && f.asset == "")) {
					selected[hash] = true
				}
			}
		}
		retained := false
		for hash := range refs[source] {
			_, exists := files[hash]
			if (exists || uploads[hash]) && !selected[hash] && !deletedHashes[hash] {
				retained = true
				break
			}
		}
		if !retained {
			plan.SourceKeys = append(plan.SourceKeys, source)
		}
	}
	for hash, yes := range selected {
		if !yes {
			continue
		}
		if !validHash.MatchString(hash) {
			return plan, fmt.Errorf("invalid original hash in deletion plan")
		}
		plan.Hashes = append(plan.Hashes, hash)
		plan.Bytes += files[hash].size
	}
	sort.Strings(plan.Hashes)
	sort.Strings(plan.SourceKeys)
	return plan, nil
}

func (l *Library) cancelProcessing(hashes []string) {
	l.processingMu.Lock()
	defer l.processingMu.Unlock()
	for _, hash := range hashes {
		if job := l.processing[hash]; job != nil {
			job.cancel()
		}
	}
}

func (l *Library) waitProcessing(ctx context.Context, hashes []string) error {
	l.processingMu.Lock()
	jobs := []*processingJob{}
	for _, hash := range hashes {
		if job := l.processing[hash]; job != nil {
			job.cancel()
			jobs = append(jobs, job)
		}
	}
	l.processingMu.Unlock()
	for _, job := range jobs {
		select {
		case <-job.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// RecoverDeletions resumes accepted intents before processing ordinary media after a restart.
func (l *Library) RecoverDeletions(ctx context.Context) error { return l.recoverDeletions(ctx, true) }

func (l *Library) recoverDeletions(ctx context.Context, force bool) error {
	rows, e := l.DB.Query(`SELECT d.id FROM decisions d WHERE d.action='purge-request' AND NOT EXISTS
 (SELECT 1 FROM decisions c WHERE c.action='purge-complete' AND json_extract(c.detail,'$.requestId')=d.id)
 ORDER BY d.created_at,d.id`)
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			break
		}
		ids = append(ids, id)
	}
	if e == nil {
		e = rows.Err()
	}
	rows.Close()
	if e != nil {
		return e
	}
	var first error
	for _, id := range ids {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		l.deletionMu.Lock()
		if l.deletionAttempts == nil {
			l.deletionAttempts = map[string]time.Time{}
		}
		last := l.deletionAttempts[id]
		if !force && time.Since(last) < 5*time.Second {
			l.deletionMu.Unlock()
			continue
		}
		l.deletionAttempts[id] = time.Now()
		l.deletionMu.Unlock()
		_, plan, err := readDeletion(l.DB, id)
		if err == nil {
			l.cancelProcessing(plan.Hashes)
			err = l.runDeletion(ctx, id, plan)
		}
		if err != nil {
			if first == nil {
				first = err
			}
			if ctx.Err() == nil {
				if recordErr := l.recordDeletionError(id, err.Error()); recordErr != nil {
					return recordErr
				}
			}
		}
	}
	return first
}

func (l *Library) recordDeletionError(id, message string) error {
	var old string
	e := l.DB.QueryRow(`SELECT json_extract(detail,'$.error') FROM decisions WHERE action='purge-error'
 AND json_extract(detail,'$.requestId')=? ORDER BY created_at DESC,id DESC LIMIT 1`, id).Scan(&old)
	if e != nil && e != sql.ErrNoRows {
		return e
	}
	if old == message {
		return nil
	}
	_, e = l.DB.Exec("INSERT INTO decisions(id,action,detail,created_at) VALUES(?,?,?,?)", ID(), "purge-error", marshal(map[string]string{"requestId": id, "error": message}), now())
	return e
}

func (l *Library) runDeletion(ctx context.Context, id string, plan deletionPlan) error {
	if e := l.waitProcessing(ctx, plan.Hashes); e != nil {
		return e
	}
	unlocks := []func(){}
	for _, hash := range plan.Hashes {
		if !validHash.MatchString(hash) {
			return fmt.Errorf("invalid original hash in deletion plan")
		}
	}
	hashes := append([]string(nil), plan.Hashes...)
	sort.Strings(hashes)
	for _, hash := range hashes {
		unlocks = append(unlocks, l.lockUpload(hash))
	}
	defer func() {
		for i := len(unlocks) - 1; i >= 0; i-- {
			unlocks[i]()
		}
	}()
	for _, hash := range hashes {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if e := l.removeOriginalWork(hash); e != nil {
			return e
		}
		for _, path := range []string{l.Object(hash), l.Derived(hash, "-thumb.jpg"), l.Derived(hash, "-preview.jpg"), l.Derived(hash, "-play.mp4"), filepath.Join(l.Root, "incoming", hash)} {
			if e := removeDurably(path); e != nil {
				return e
			}
		}
	}
	tx, e := l.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	status, _, e := readDeletion(tx, id)
	if e != nil || status.State == "complete" {
		return e
	}
	for _, hash := range hashes {
		for _, table := range []string{"files", "observations"} {
			if _, e = tx.Exec("DELETE FROM "+table+" WHERE hash=?", hash); e != nil {
				return e
			}
		}
		if _, e = tx.Exec("DELETE FROM uploads WHERE id=?", hash); e != nil {
			return e
		}
	}
	for _, asset := range plan.IDs {
		if _, e = tx.Exec("DELETE FROM asset_keys WHERE asset_id=?", asset); e != nil {
			return e
		}
		if _, e = tx.Exec("DELETE FROM assets WHERE id=?", asset); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("INSERT INTO decisions(id,action,detail,created_at) VALUES(?,?,?,?)", ID(), "purge-complete", marshal(map[string]string{"requestId": id}), now()); e != nil {
		return e
	}
	return tx.Commit()
}

func removeDurably(path string) error {
	if e := os.Remove(path); e != nil && !os.IsNotExist(e) {
		return e
	}
	return syncDirectory(filepath.Dir(path))
}

func syncDirectory(path string) error {
	dir, e := os.Open(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	defer dir.Close()
	return dir.Sync()
}

func (l *Library) removeOriginalWork(hash string) error {
	entries, e := os.ReadDir(filepath.Join(l.Root, "work"))
	if e != nil {
		return e
	}
	original, statErr := os.Lstat(l.Object(hash))
	if statErr != nil && !os.IsNotExist(statErr) {
		return statErr
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(l.Root, "work", entry.Name())
		owned := false
		if strings.HasPrefix(entry.Name(), hash+"-") || strings.HasPrefix(entry.Name(), hash[:8]+"-") {
			children, err := os.ReadDir(path)
			if err != nil {
				return err
			}
			for _, child := range children {
				if child.Name() != "source" && !strings.HasPrefix(child.Name(), "source.") {
					continue
				}
				stat, err := os.Lstat(filepath.Join(path, child.Name()))
				if err != nil {
					return err
				}
				if !stat.Mode().IsRegular() {
					continue
				}
				if original != nil {
					owned = os.SameFile(original, stat)
				}
				// Repair can change the object inode while an old work link retains identical bytes.
				if !owned {
					_, checksum, err := hashUploadFile(filepath.Join(path, child.Name()))
					if err != nil {
						return err
					}
					owned = checksum == hash
				}
				if owned {
					break
				}
			}
		}
		if owned {
			if e = os.RemoveAll(path); e != nil {
				return e
			}
		}
	}
	return syncDirectory(filepath.Join(l.Root, "work"))
}
