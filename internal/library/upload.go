package library

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

const chunkSize int64 = 8 << 20

var validHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var validID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var allowedExtensions = map[string]bool{}

func init() {
	for _, s := range strings.Fields("jpg jpeg heic heif png webp gif tif tiff avif jxl dng cr2 cr3 nef arw raf rw2 orf pef srw mov mp4 m4v avi mkv mts 3gp aae xmp") {
		allowedExtensions[s] = true
	}
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, err any) {
	writeJSON(w, status, map[string]any{"error": fmt.Sprint(err)})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d := json.NewDecoder(r.Body)
	if e := d.Decode(v); e != nil {
		fail(w, 400, "请求格式不正确")
		return false
	}
	return true
}
func (l *Library) prepare(w http.ResponseWriter, r *http.Request) {
	var h Hints
	if !decode(w, r, &h) {
		return
	}
	h.Name = filepath.Base(strings.ReplaceAll(h.Name, "\\", "/"))
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(h.Name), "."))
	if !validHash.MatchString(h.Hash) || h.Size <= 0 || h.Size > 32<<30 || len(h.Name) > 512 || (!allowedExtensions[ext] && !(h.ResourceType == "adjustmentData" && strings.HasPrefix(h.SourceKey, "photokit:"))) || len(h.SourceKey) > 1024 {
		fail(w, 400, "不支持的文件或文件参数无效")
		return
	}
	for _, date := range []string{h.From, h.To} {
		if date != "" {
			if _, e := time.Parse("2006-01-02", date); e != nil {
				fail(w, 400, "日期格式应为 YYYY-MM-DD")
				return
			}
		}
	}
	if h.From != "" && h.To != "" && h.From > h.To {
		fail(w, 400, "开始日期不能晚于结束日期")
		return
	}
	l.UploadMu.Lock()
	defer l.UploadMu.Unlock()
	f, e := l.File(h.Hash)
	if e == nil {
		if f.Size != h.Size {
			fail(w, 409, "文件长度与已存原件不一致")
			return
		}
		if e = l.remember(h); e != nil {
			fail(w, 500, e)
			return
		}
		writeJSON(w, 200, map[string]any{"id": h.Hash, "offset": h.Size, "complete": true, "duplicate": true, "assetId": f.AssetID, "status": f.Status})
		return
	}
	if !errors.Is(e, sql.ErrNoRows) {
		fail(w, 500, e)
		return
	}
	// The checksum identifies the byte stream; a reselected date range applies to the resumed upload.
	var oldHints, state string
	e = l.DB.QueryRow("SELECT hints,state FROM uploads WHERE id=?", h.Hash).Scan(&oldHints, &state)
	if errors.Is(e, sql.ErrNoRows) {
		_, e = l.DB.Exec("INSERT INTO uploads(id,hints,created_at) VALUES(?,?,?)", h.Hash, marshal(h), now())
	} else if e == nil {
		var old Hints
		_ = json.Unmarshal([]byte(oldHints), &old)
		if old.Size != h.Size {
			fail(w, 409, "上传长度冲突")
			return
		}
		if state != "complete" {
			_, e = l.DB.Exec("UPDATE uploads SET state='uploading',hints=? WHERE id=?", marshal(h), h.Hash)
		}
	}
	if e != nil {
		fail(w, 500, e)
		return
	}
	if e = l.remember(h); e != nil {
		fail(w, 500, e)
		return
	}
	var offset int64
	if st, e := os.Stat(filepath.Join(l.Root, "incoming", h.Hash)); e == nil {
		offset = st.Size()
	} else if !os.IsNotExist(e) {
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, map[string]any{"id": h.Hash, "offset": offset, "chunkSize": chunkSize, "complete": false})
}
func (l *Library) uploadState(id string) (Hints, string, error) {
	var h Hints
	var s, state string
	e := l.DB.QueryRow("SELECT hints,state FROM uploads WHERE id=?", id).Scan(&s, &state)
	if e == nil {
		e = json.Unmarshal([]byte(s), &h)
	}
	return h, state, e
}
func (l *Library) uploadStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !validHash.MatchString(id) {
		fail(w, 404, "未找到上传")
		return
	}
	h, state, e := l.uploadState(id)
	if e != nil {
		fail(w, 404, "未找到上传")
		return
	}
	var offset int64
	if st, e := os.Stat(filepath.Join(l.Root, "incoming", id)); e == nil {
		offset = st.Size()
	}
	if f, e := l.File(id); e == nil {
		writeJSON(w, 200, map[string]any{"id": id, "offset": h.Size, "complete": true, "assetId": f.AssetID, "status": f.Status})
		return
	}
	writeJSON(w, 200, map[string]any{"id": id, "offset": offset, "complete": state == "filtered", "filtered": state == "filtered", "chunkSize": chunkSize})
}
func (l *Library) chunk(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !validHash.MatchString(id) {
		fail(w, 404, "未找到上传")
		return
	}
	offset, e := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if e != nil || offset < 0 {
		fail(w, 400, "缺少有效 Upload-Offset")
		return
	}
	l.UploadMu.Lock()
	defer l.UploadMu.Unlock()
	h, state, e := l.uploadState(id)
	if e != nil || state != "uploading" {
		fail(w, 409, "上传已完成或不存在")
		return
	}
	f, e := os.OpenFile(filepath.Join(l.Root, "incoming", id), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		fail(w, 500, e)
		return
	}
	if st.Size() != offset {
		writeJSON(w, 409, map[string]any{"error": "请从已接收的位置继续", "offset": st.Size()})
		return
	}
	max := min(chunkSize, h.Size-offset)
	if max <= 0 {
		fail(w, 409, "文件已收齐，请完成上传")
		return
	}
	if _, e = f.Seek(offset, io.SeekStart); e != nil {
		fail(w, 500, e)
		return
	}
	n, e := io.Copy(f, http.MaxBytesReader(w, r.Body, max))
	if e != nil {
		_ = f.Truncate(offset)
		_ = f.Sync()
		fail(w, 400, "分片接收未完成，请重试")
		return
	}
	if n == 0 {
		fail(w, 400, "空分片")
		return
	}
	if e = f.Sync(); e != nil {
		_ = f.Truncate(offset)
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, map[string]any{"offset": offset + n})
}
func (l *Library) commitUpload(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !validHash.MatchString(id) {
		fail(w, 404, "未找到上传")
		return
	}
	l.UploadMu.Lock()
	defer l.UploadMu.Unlock()
	if f, e := l.File(id); e == nil {
		writeJSON(w, 200, map[string]any{"complete": true, "assetId": f.AssetID, "status": f.Status})
		return
	}
	h, _, e := l.uploadState(id)
	if e != nil {
		fail(w, 404, "未找到上传")
		return
	}
	path := filepath.Join(l.Root, "incoming", id)
	// Recover the atomic rename if the process stopped before committing its database row.
	if _, e = os.Stat(path); os.IsNotExist(e) {
		path = l.Object(id)
	}
	f, e := os.Open(path)
	if e != nil {
		fail(w, 409, "尚未接收完整文件")
		return
	}
	hasher := sha256.New()
	n, e := io.Copy(hasher, f)
	_ = f.Close()
	if e != nil {
		fail(w, 500, e)
		return
	}
	if n != h.Size {
		fail(w, 409, "文件尚未传完")
		return
	}
	if hex.EncodeToString(hasher.Sum(nil)) != id {
		// Discard only this failed temporary stream; no accepted original is replaced.
		if path != l.Object(id) {
			_ = os.Remove(path)
		}
		fail(w, 422, "文件校验失败，请重新上传")
		return
	}
	if h.From != "" || h.To != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		data, err := command(ctx, "exiftool", "-j", "-G1", "-n", "-api", "QuickTimeUTC=1", path)
		cancel()
		m := map[string]any{}
		if err == nil {
			var items []map[string]any
			if json.Unmarshal(data, &items) == nil && len(items) > 0 {
				m = items[0]
			}
		}
		captured := captureDate(m, h)
		day := captured[:10]
		if h.From != "" && day < h.From || h.To != "" && day > h.To {
			if path != l.Object(id) {
				if e = os.Remove(path); e != nil {
					fail(w, 500, e)
					return
				}
			}
			if _, e = l.DB.Exec("UPDATE uploads SET state='filtered' WHERE id=?", id); e != nil {
				fail(w, 500, e)
				return
			}
			writeJSON(w, 200, map[string]any{"complete": true, "filtered": true, "capturedAt": captured})
			return
		}
	}
	if e = os.MkdirAll(filepath.Dir(l.Object(id)), 0700); e != nil {
		fail(w, 500, e)
		return
	}
	if path != l.Object(id) {
		if e = os.Rename(path, l.Object(id)); e != nil {
			fail(w, 500, e)
			return
		}
		if d, e := os.Open(filepath.Dir(l.Object(id))); e == nil {
			_ = d.Sync()
			d.Close()
		}
	}
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	if _, e = tx.Exec("INSERT INTO files(hash,name,size,hints,created_at) VALUES(?,?,?,?,?)", id, h.Name, h.Size, marshal(h), now()); e == nil {
		_, e = tx.Exec("UPDATE uploads SET state='complete' WHERE id=?", id)
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 500, e)
		return
	}
	l.Notify()
	writeJSON(w, 202, map[string]any{"complete": true, "status": "queued"})
}
