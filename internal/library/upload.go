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
var errOriginalIntegrity = errors.New("原件完整性异常，需要单独检查，未覆盖现有文件")

func (l *Library) originalPresent(f File) (bool, error) {
	stat, e := os.Lstat(l.Object(f.Hash))
	if os.IsNotExist(e) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if !stat.Mode().IsRegular() || stat.Size() != f.Size {
		return false, errOriginalIntegrity
	}
	return true, nil
}

func originalFailure(w http.ResponseWriter, e error) {
	if deletedFailure(w, e) {
		return
	}
	if errors.Is(e, errOriginalIntegrity) {
		writeJSON(w, 409, map[string]string{"error": e.Error(), "code": "original_integrity_error"})
	} else {
		fail(w, 500, e)
	}
}

func (l *Library) incomingOffset(hash string) (int64, error) {
	stat, e := os.Stat(filepath.Join(l.Root, "incoming", hash))
	if os.IsNotExist(e) {
		return 0, nil
	}
	if e != nil {
		return 0, e
	}
	return stat.Size(), nil
}

func (l *Library) fileUploadResult(f File, present bool) (map[string]any, error) {
	if e := originalDeletion(l.DB, f.Hash, ""); e != nil {
		return nil, e
	}
	result := map[string]any{"id": f.Hash, "offset": int64(0), "complete": present, "present": present, "missing": !present, "chunkSize": chunkSize}
	if present {
		result["offset"] = f.Size
	}
	var asset, status, trashed string
	e := l.DB.QueryRow("SELECT f.asset_id,f.status,COALESCE(a.trashed_at,'') FROM files f LEFT JOIN assets a ON a.id=f.asset_id WHERE f.hash=?", f.Hash).Scan(&asset, &status, &trashed)
	if e != nil {
		return nil, e
	}
	result["assetId"], result["status"] = asset, status
	result["trashed"], result["trashedAt"] = trashed != "", trashed
	return result, nil
}

func (l *Library) reconcileUpload(f File) error {
	tx, e := l.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = originalDeletion(tx, f.Hash, ""); e != nil {
		return e
	}
	result, e := tx.Exec("UPDATE uploads SET state='complete' WHERE id=? AND state='uploading' AND json_extract(hints,'$.size')=?", f.Hash, f.Size)
	if e != nil {
		return e
	}
	changed, e := result.RowsAffected()
	if e != nil {
		return e
	}
	if changed > 0 {
		// An interrupted repair may have restored bytes before queuing their processing.
		if _, e = tx.Exec("UPDATE files SET status='queued',error='' WHERE hash=? AND status='error'", f.Hash); e != nil {
			return e
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	if changed > 0 {
		l.Notify()
	}
	return nil
}

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
	unlock := l.lockUpload(h.Hash)
	defer unlock()
	if e := originalDeletion(l.DB, h.Hash, h.SourceKey); e != nil {
		originalFailure(w, e)
		return
	}
	f, e := l.File(h.Hash)
	repair := e == nil
	if e == nil {
		if f.Size != h.Size {
			fail(w, 409, "文件长度与已存原件不一致")
			return
		}
		present, err := l.originalPresent(f)
		if err != nil {
			originalFailure(w, err)
			return
		}
		if present {
			if e = l.remember(h); e != nil {
				originalFailure(w, e)
				return
			}
			if e = l.reconcileUpload(f); e != nil {
				originalFailure(w, e)
				return
			}
			result, err := l.fileUploadResult(f, true)
			if err != nil {
				originalFailure(w, err)
				return
			}
			result["duplicate"] = true
			writeJSON(w, 200, result)
			return
		}
	}
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		fail(w, 500, e)
		return
	}
	// The checksum identifies the byte stream; a reselected date range applies to the resumed upload.
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	if e = originalDeletion(tx, h.Hash, h.SourceKey); e != nil {
		originalFailure(w, e)
		return
	}
	var oldHints, state string
	e = tx.QueryRow("SELECT hints,state FROM uploads WHERE id=?", h.Hash).Scan(&oldHints, &state)
	if errors.Is(e, sql.ErrNoRows) {
		_, e = tx.Exec("INSERT INTO uploads(id,hints,created_at) VALUES(?,?,?)", h.Hash, marshal(h), now())
	} else if e == nil {
		var old Hints
		_ = json.Unmarshal([]byte(oldHints), &old)
		if old.Size != h.Size {
			fail(w, 409, "上传长度冲突")
			return
		}
		if state != "complete" || repair {
			_, e = tx.Exec("UPDATE uploads SET state='uploading',hints=? WHERE id=?", marshal(h), h.Hash)
		}
	}
	if e != nil {
		fail(w, 500, e)
		return
	}
	if e = rememberTx(tx, h); e != nil {
		originalFailure(w, e)
		return
	}
	if e = tx.Commit(); e != nil {
		fail(w, 500, e)
		return
	}
	if e = originalDeletion(l.DB, h.Hash, h.SourceKey); e != nil {
		originalFailure(w, e)
		return
	}
	offset, e := l.incomingOffset(h.Hash)
	if e != nil {
		fail(w, 500, e)
		return
	}
	result := map[string]any{"id": h.Hash, "offset": offset, "chunkSize": chunkSize, "complete": false, "missing": false}
	if repair {
		result, e = l.fileUploadResult(f, false)
		if e != nil {
			originalFailure(w, e)
			return
		}
		result["offset"] = offset
	}
	writeJSON(w, 200, result)
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
	unlock := l.lockUpload(id)
	defer unlock()
	if e := originalDeletion(l.DB, id, ""); e != nil {
		originalFailure(w, e)
		return
	}
	if f, e := l.File(id); e == nil {
		present, err := l.originalPresent(f)
		if err != nil {
			originalFailure(w, err)
			return
		}
		result, err := l.fileUploadResult(f, present)
		if err != nil {
			originalFailure(w, err)
			return
		}
		if !present {
			offset, err := l.incomingOffset(id)
			if err != nil {
				fail(w, 500, err)
				return
			}
			result["offset"] = offset
		}
		writeJSON(w, 200, result)
		return
	} else if e != sql.ErrNoRows {
		fail(w, 500, e)
		return
	}
	_, state, e := l.uploadState(id)
	if e != nil {
		if e == sql.ErrNoRows {
			fail(w, 404, "未找到上传")
		} else {
			fail(w, 500, e)
		}
		return
	}
	offset, e := l.incomingOffset(id)
	if e != nil {
		fail(w, 500, e)
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
	unlock := l.lockUpload(id)
	defer unlock()
	if e = originalDeletion(l.DB, id, ""); e != nil {
		originalFailure(w, e)
		return
	}
	h, state, e := l.uploadState(id)
	if e == nil {
		if e = originalDeletion(l.DB, id, h.SourceKey); e != nil {
			originalFailure(w, e)
			return
		}
	}
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
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(120 * time.Second))
	defer controller.SetReadDeadline(time.Time{})
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
	if e = originalDeletion(l.DB, id, h.SourceKey); e != nil {
		originalFailure(w, e)
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
	unlock := l.lockUpload(id)
	defer unlock()
	if e := originalDeletion(l.DB, id, ""); e != nil {
		originalFailure(w, e)
		return
	}
	h, state, stateErr := l.uploadState(id)
	if stateErr == nil {
		if e := originalDeletion(l.DB, id, h.SourceKey); e != nil {
			originalFailure(w, e)
			return
		}
	}
	existing, fileErr := l.File(id)
	repair := fileErr == nil
	if repair {
		if e := originalDeletion(l.DB, id, existing.Hints.SourceKey); e != nil {
			originalFailure(w, e)
			return
		}
		present, e := l.originalPresent(existing)
		if e != nil {
			originalFailure(w, e)
			return
		}
		if present {
			if e = l.reconcileUpload(existing); e != nil {
				originalFailure(w, e)
				return
			}
			result, e := l.fileUploadResult(existing, true)
			if e != nil {
				originalFailure(w, e)
				return
			}
			writeJSON(w, 200, result)
			return
		}
	} else if fileErr != sql.ErrNoRows {
		fail(w, 500, fileErr)
		return
	}
	if stateErr != nil {
		if stateErr == sql.ErrNoRows {
			fail(w, 404, "未找到上传")
		} else {
			fail(w, 500, stateErr)
		}
		return
	}
	if state == "filtered" && !repair {
		writeJSON(w, 200, map[string]any{"id": id, "complete": true, "filtered": true, "present": false})
		return
	}
	path := filepath.Join(l.Root, "incoming", id)
	// Recover publication if the process stopped before committing its database row.
	if _, err := os.Stat(path); os.IsNotExist(err) {
		path = l.Object(id)
	}
	n, checksum, e := hashUploadFile(path)
	if e != nil {
		if os.IsNotExist(e) {
			fail(w, 409, "尚未接收完整文件")
		} else {
			fail(w, 500, e)
		}
		return
	}
	if n != h.Size {
		if path == l.Object(id) {
			originalFailure(w, errOriginalIntegrity)
		} else {
			fail(w, 409, "文件尚未传完")
		}
		return
	}
	if checksum != id {
		// Discard only this failed temporary stream; no accepted original is replaced.
		if path != l.Object(id) {
			_ = os.Remove(path)
			fail(w, 422, "文件校验失败，请重新上传")
		} else {
			originalFailure(w, errOriginalIntegrity)
		}
		return
	}
	// A repair restores an already accepted object regardless of new import filters.
	if !repair && (h.From != "" || h.To != "") {
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
	if e = l.publishUploadObject(path, id, h.Size); e != nil {
		originalFailure(w, e)
		return
	}
	tx, e := l.DB.Begin()
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer tx.Rollback()
	if e = originalDeletion(tx, id, h.SourceKey); e != nil {
		originalFailure(w, e)
		return
	}
	if repair {
		_, e = tx.Exec("UPDATE files SET status='queued',error='' WHERE hash=?", id)
	} else {
		_, e = tx.Exec("INSERT INTO files(hash,name,size,hints,created_at) VALUES(?,?,?,?,?)", id, h.Name, h.Size, marshal(h), now())
	}
	if e == nil {
		_, e = tx.Exec("UPDATE uploads SET state='complete' WHERE id=?", id)
	}
	if e == nil {
		e = tx.Commit()
	}
	if e != nil {
		fail(w, 500, e)
		return
	}
	file, e := l.File(id)
	if e != nil {
		fail(w, 500, e)
		return
	}
	result, e := l.fileUploadResult(file, true)
	if e != nil {
		originalFailure(w, e)
		return
	}
	l.Notify()
	writeJSON(w, 202, result)
}

func hashUploadFile(path string) (int64, string, error) {
	file, e := os.Open(path)
	if e != nil {
		return 0, "", e
	}
	defer file.Close()
	hasher := sha256.New()
	n, e := io.Copy(hasher, file)
	return n, hex.EncodeToString(hasher.Sum(nil)), e
}

func (l *Library) publishUploadObject(path, hash string, size int64) error {
	object := l.Object(hash)
	if e := os.MkdirAll(filepath.Dir(object), 0700); e != nil {
		return e
	}
	if path != object {
		// Linking publishes atomically without replacing any existing original.
		if e := os.Link(path, object); e != nil {
			if !os.IsExist(e) {
				return e
			}
			present, e := l.originalPresent(File{Hash: hash, Size: size})
			if e != nil {
				return e
			}
			if !present {
				return os.ErrNotExist
			}
			n, checksum, e := hashUploadFile(object)
			if e != nil {
				return e
			}
			if n != size || checksum != hash {
				return errOriginalIntegrity
			}
		}
	} else {
		present, e := l.originalPresent(File{Hash: hash, Size: size})
		if e != nil {
			return e
		}
		if !present {
			return os.ErrNotExist
		}
	}
	for _, dir := range []string{filepath.Dir(object), filepath.Join(l.Root, "assets")} {
		d, e := os.Open(dir)
		if e != nil {
			return e
		}
		e = d.Sync()
		d.Close()
		if e != nil {
			return e
		}
	}
	if path != object {
		return os.Remove(path)
	}
	return nil
}
