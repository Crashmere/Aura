package library

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type limitedBuffer struct {
	bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < b.max {
		_, _ = b.Buffer.Write(p[:min(len(p), b.max-b.Len())])
	}
	return n, nil
}
func command(ctx context.Context, bin string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = append(os.Environ(), "VIPS_CONCURRENCY=2", "VIPS_DISC_THRESHOLD=64m")
	out := &limitedBuffer{max: 8 << 20}
	stderr := &limitedBuffer{max: 4096}
	cmd.Stdout = out
	cmd.Stderr = stderr
	e := cmd.Run()
	if e != nil {
		return nil, fmt.Errorf("%s: %w: %s", bin, e, strings.TrimSpace(stderr.String()))
	}
	return out.Bytes(), nil
}
func tag(m map[string]any, names ...string) string {
	for _, name := range names {
		if v, ok := m[name]; ok {
			return fmt.Sprint(v)
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if strings.HasSuffix(k, ":"+name) {
				return fmt.Sprint(m[k])
			}
		}
	}
	return ""
}
func number(m map[string]any, names ...string) int {
	v, _ := strconv.ParseFloat(tag(m, names...), 64)
	return int(v)
}
func captureDate(m map[string]any, h Hints) string {
	loc := time.Local
	nativeDate := ""
	if strings.HasPrefix(h.SourceKey, "photokit:") {
		nativeDate = h.CapturedAt
	}
	for _, s := range []string{tag(m, "SubSecDateTimeOriginal"), tag(m, "DateTimeOriginal"), tag(m, "Keys:CreationDate"), nativeDate, tag(m, "QuickTime:CreateDate"), tag(m, "CreateDate"), h.CapturedAt, h.ModifiedAt} {
		if s == "" || strings.HasPrefix(s, "0000") {
			continue
		}
		if len(s) >= 10 && s[4] == ':' {
			s = s[:4] + "-" + s[5:7] + "-" + s[8:]
		}
		for _, format := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02 15:04:05.999999999-0700", "2006-01-02 15:04:05.999999999", "2006-01-02"} {
			if t, e := time.ParseInLocation(format, s, loc); e == nil && t.Year() >= 1900 {
				return t.Format(time.RFC3339Nano)
			}
		}
	}
	return now()
}
func (l *Library) Worker(ctx context.Context) {
	if e := l.RecoverDeletions(ctx); e != nil && ctx.Err() == nil {
		slog.Error("recover permanent deletion", "error", e)
	}
	if _, e := l.DB.Exec("UPDATE files SET status='queued' WHERE status='processing'"); e != nil {
		slog.Error("recover processing jobs", "error", e)
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		_ = l.recoverDeletions(ctx, false)
		f, e := scanFile(l.DB.QueryRow("SELECT " + fileColumns + ` FROM files WHERE status='queued' AND NOT EXISTS
 (SELECT 1 FROM decisions d,json_each(d.detail,'$.hashes') h WHERE d.action='purge-request' AND h.value=files.hash)
 ORDER BY created_at LIMIT 1`))
		if e == sql.ErrNoRows {
			select {
			case <-ctx.Done():
				return
			case <-l.Wake:
			case <-ticker.C:
			}
			continue
		}
		if e != nil {
			slog.Error("job lookup", "error", e)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			continue
		}
		if e = l.processQueued(ctx, f.Hash); e != nil {
			var deleted *deletedOriginal
			if errors.As(e, &deleted) || errors.Is(e, sql.ErrNoRows) {
				continue
			}
			if ctx.Err() != nil {
				_, _ = l.DB.Exec("UPDATE files SET status='queued' WHERE hash=? AND status='processing'", f.Hash)
				return
			}
			slog.Error("media processing", "hash", f.Hash, "error", e)
			_, _ = l.DB.Exec("UPDATE files SET status='error',error=? WHERE hash=? AND status='processing'", e.Error(), f.Hash)
		}
	}
}

func (l *Library) processQueued(parent context.Context, hash string) error {
	unlock := l.lockUpload(hash)
	locked := true
	defer func() {
		if locked {
			unlock()
		}
	}()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	job := &processingJob{cancel: cancel, done: make(chan struct{})}
	l.processingMu.Lock()
	if l.processing == nil {
		l.processing = map[string]*processingJob{}
	}
	if l.processing[hash] != nil {
		l.processingMu.Unlock()
		return sql.ErrNoRows
	}
	l.processing[hash] = job
	l.processingMu.Unlock()
	defer func() {
		l.processingMu.Lock()
		delete(l.processing, hash)
		close(job.done)
		l.processingMu.Unlock()
	}()
	tx, e := l.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	f, e := scanFile(tx.QueryRow("SELECT "+fileColumns+" FROM files WHERE hash=? AND status='queued'", hash))
	if e != nil {
		return e
	}
	source := ""
	if f.AssetID == "" {
		source = f.Hints.SourceKey
	}
	if e = originalDeletion(tx, hash, source); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE files SET status='processing' WHERE hash=?", hash); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	unlock()
	locked = false
	e = l.process(ctx, f)
	if deleted := originalDeletion(l.DB, hash, ""); deleted != nil {
		return deleted
	}
	return e
}

func (l *Library) process(parent context.Context, f File) error {
	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	defer cancel()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	work, e := os.MkdirTemp(filepath.Join(l.Root, "work"), f.Hash+"-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(work)
	// The extension helps RAW/sidecar decoders; the object itself remains content addressed.
	input := filepath.Join(work, "source"+strings.ToLower(filepath.Ext(f.Name)))
	if e = os.Link(l.Object(f.Hash), input); e != nil {
		return e
	}
	meta := map[string]any{}
	raw, extractErr := command(ctx, "exiftool", "-j", "-G1", "-n", "-struct", "-api", "LargeFileSupport=1", "-api", "QuickTimeUTC=1", input)
	if extractErr == nil {
		var list []map[string]any
		if e = json.Unmarshal(raw, &list); e == nil && len(list) > 0 {
			meta = list[0]
		} else {
			extractErr = fmt.Errorf("metadata decode: %v", e)
		}
	}
	for k := range meta {
		if k == "SourceFile" || strings.HasPrefix(k, "System:") {
			delete(meta, k)
		}
	}
	f.Mime = tag(meta, "MIMEType")
	if f.Mime == "" {
		f.Mime = "application/octet-stream"
	}
	f.Width = number(meta, "ExifImageWidth", "ImageWidth", "SourceImageWidth")
	f.Height = number(meta, "ExifImageHeight", "ImageHeight", "SourceImageHeight")
	f.CapturedAt = captureDate(meta, f.Hints)
	f.ContentID = tag(meta, "ContentIdentifier", "MediaGroupUUID", "AssetIdentifier")
	f.Metadata = json.RawMessage(marshal(meta))
	f.Score = int64(f.Width)*int64(f.Height)*1000 + int64(min(len(meta), 999))*100
	if tag(meta, "GPSLatitude") != "" || f.Hints.Latitude != nil {
		f.Score += 20000
	}
	if tag(meta, "DateTimeOriginal") != "" {
		f.Score += 10000
	}
	if strings.Contains(strings.ToLower(f.Hints.ResourceType), "original") || f.Hints.ResourceType == "photo" {
		f.Score += 50000
	}
	var mediaErr error
	if strings.HasPrefix(f.Mime, "image/") {
		previewInput := input
		// Decode once: RAW decoders are expensive, and both previews and pixel identity need the same samples.
		upright := filepath.Join(work, "upright.v")
		_, decodeErr := command(ctx, "vips", "autorot", input, upright)
		if decodeErr == nil {
			previewInput = upright
		}
		_, mediaErr = command(ctx, "vips", "thumbnail", previewInput, filepath.Join(work, "preview.jpg")+"[Q=92,strip]", "2560", "--size", "down")
		if mediaErr != nil {
			for _, name := range []string{"JpgFromRaw", "PreviewImage", "OtherImage"} {
				embedded, err := command(ctx, "exiftool", "-b", "-"+name, input)
				if err != nil || len(embedded) < 100 {
					continue
				}
				previewInput = filepath.Join(work, "embedded.jpg")
				if os.WriteFile(previewInput, embedded, 0600) != nil {
					continue
				}
				_, mediaErr = command(ctx, "vips", "thumbnail", previewInput, filepath.Join(work, "preview.jpg")+"[Q=92,strip]", "2560", "--size", "down")
				if mediaErr == nil {
					break
				}
			}
		}
		if mediaErr == nil {
			_, mediaErr = command(ctx, "vips", "thumbnail", previewInput, filepath.Join(work, "thumb.jpg")+"[Q=85,strip]", "640", "--size", "down")
		}
		if mediaErr == nil {
			for _, s := range []string{"preview", "thumb"} {
				if e = os.Rename(filepath.Join(work, s+".jpg"), l.Derived(f.Hash, "-"+s+".jpg")); e != nil {
					return e
				}
			}
			f.DHash = perceptual(l.Derived(f.Hash, "-thumb.jpg"))
			// Hash full decoded pixels and their interpretation. No resized or lossy hash triggers automatic grouping.
			if decodeErr == nil {
				header, he := command(ctx, "vipsheader", filepath.Join(work, "upright.v"))
				_, re := command(ctx, "vips", "rawsave", filepath.Join(work, "upright.v"), filepath.Join(work, "pixels.raw"))
				if he == nil && re == nil {
					pixels, pe := os.Open(filepath.Join(work, "pixels.raw"))
					if pe == nil {
						sum := sha256.New()
						description := strings.SplitN(string(header), ": ", 2)
						if len(description) == 2 {
							io.WriteString(sum, description[1])
						}
						// Color profiles affect the meaning of otherwise equal sample values.
						icc := map[string]any{}
						for k, v := range meta {
							if strings.HasPrefix(k, "ICC-") || strings.HasPrefix(k, "ICC_Profile:") {
								icc[k] = v
							}
						}
						io.WriteString(sum, marshal(icc))
						_, pe = io.Copy(sum, pixels)
						pixels.Close()
						if pe == nil {
							f.PixelHash = hex.EncodeToString(sum.Sum(nil))
						}
					}
				}
			}
		}
	} else if strings.HasPrefix(f.Mime, "video/") {
		_, mediaErr = command(ctx, "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", input, "-frames:v", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease", "-threads", "2", "-y", filepath.Join(work, "thumb.jpg"))
		if mediaErr == nil {
			if e = os.Rename(filepath.Join(work, "thumb.jpg"), l.Derived(f.Hash, "-thumb.jpg")); e != nil {
				return e
			}
		}
		_, videoErr := command(ctx, "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", input, "-map", "0:v:0", "-map", "0:a?", "-vf", "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-threads", "2", "-y", filepath.Join(work, "play.mp4"))
		if videoErr == nil {
			if e = os.Rename(filepath.Join(work, "play.mp4"), l.Derived(f.Hash, "-play.mp4")); e != nil {
				return e
			}
		} else if mediaErr == nil {
			mediaErr = videoErr
		}
	}
	f.Status = "ready"
	f.Error = ""
	if mediaErr != nil {
		f.Status = "error"
		f.Error = mediaErr.Error()
	}
	if extractErr != nil {
		f.Status = "error"
		f.Error = extractErr.Error()
	}
	return l.publish(f)
}
func (l *Library) publish(f File) error {
	tx, e := l.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	current, e := scanFile(tx.QueryRow("SELECT "+fileColumns+" FROM files WHERE hash=?", f.Hash))
	if e != nil {
		return e
	}
	source := ""
	if current.AssetID == "" {
		source = current.Hints.SourceKey
	}
	if e = originalDeletion(tx, f.Hash, source); e != nil {
		return e
	}
	if current.AssetID != "" {
		var exists bool
		if e = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?)", current.AssetID).Scan(&exists); e != nil {
			return e
		}
		if !exists {
			return fmt.Errorf("resource references missing library item")
		}
	}
	var split bool
	if e = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM decisions d WHERE d.action='split'
 AND (json_extract(d.detail,'$.from')=? OR json_extract(d.detail,'$.to')=? OR json_extract(d.detail,'$.hash')=?)
 AND d.created_at>COALESCE((SELECT max(created_at) FROM observations WHERE hash=?),''))`, current.AssetID, current.AssetID, f.Hash, f.Hash).Scan(&split); e != nil {
		return e
	}
	grouping := current.AssetID == f.AssetID && !split
	_, e = tx.Exec(`UPDATE files SET mime=?,width=?,height=?,captured_at=?,content_id=?,pixel_hash=?,dhash=?,metadata=?,score=?,status=?,error=? WHERE hash=?`, f.Mime, f.Width, f.Height, f.CapturedAt, f.ContentID, f.PixelHash, f.DHash, string(f.Metadata), f.Score, f.Status, f.Error, f.Hash)
	if e != nil {
		return e
	}
	keys := []string{}
	if current.Hints.SourceKey != "" {
		keys = append(keys, "source:"+current.Hints.SourceKey)
	}
	observations, e := tx.Query("SELECT hints FROM observations WHERE hash=? ORDER BY created_at,id", f.Hash)
	if e != nil {
		return e
	}
	favorite := f.Hints.Favorite
	for observations.Next() {
		var s string
		_ = observations.Scan(&s)
		var h Hints
		_ = json.Unmarshal([]byte(s), &h)
		if h.SourceKey != "" {
			keys = append(keys, "source:"+h.SourceKey)
		}
		favorite = favorite || h.Favorite
	}
	observations.Close()
	if f.ContentID != "" {
		keys = append(keys, "apple:"+f.ContentID)
	}
	if f.PixelHash != "" {
		keys = append(keys, "pixels:"+f.PixelHash)
	}
	asset := current.AssetID
	skipped := map[string]bool{}
	for _, key := range keys {
		if !grouping {
			break
		}
		var other string
		e = tx.QueryRow("SELECT k.asset_id FROM asset_keys k JOIN assets a ON a.id=k.asset_id WHERE k.key=?", key).Scan(&other)
		if e != nil && e != sql.ErrNoRows {
			return e
		}
		if other != "" {
			request, err := assetDeletion(tx, other)
			if err != nil {
				return err
			}
			if request != "" {
				skipped[key] = true
				continue
			}
			if asset == "" {
				asset = other
			} else if other != asset {
				if e = mergeTx(tx, asset, other, key); e != nil {
					var pending *pendingDeletion
					if errors.Is(e, errTrashStateConflict) || errors.As(e, &pending) {
						skipped[key] = true
						continue
					}
					return e
				}
			}
		}
	}
	if asset == "" {
		asset = ID()
		if _, e = tx.Exec("INSERT INTO assets(id,captured_at,favorite,created_at) VALUES(?,?,?,?)", asset, f.CapturedAt, favorite, now()); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("UPDATE files SET asset_id=? WHERE hash=?", asset, f.Hash); e != nil {
		return e
	}
	for _, key := range keys {
		if !grouping {
			break
		}
		if skipped[key] {
			continue
		}
		if _, e = tx.Exec("INSERT INTO asset_keys VALUES(?,?) ON CONFLICT(key) DO UPDATE SET asset_id=excluded.asset_id", key, asset); e != nil {
			return e
		}
	}
	if favorite && current.AssetID == "" {
		if _, e = tx.Exec("UPDATE assets SET favorite=1 WHERE id=?", asset); e != nil {
			return e
		}
	}
	if e = refreshTx(tx, asset); e != nil {
		return e
	}
	return tx.Commit()
}
func perceptual(path string) string {
	f, e := os.Open(path)
	if e != nil {
		return ""
	}
	defer f.Close()
	im, _, e := image.Decode(f)
	if e != nil {
		return ""
	}
	b := im.Bounds()
	if b.Dx() < 9 || b.Dy() < 8 {
		return ""
	}
	var hash uint64
	var low, high uint32 = 65535, 0
	grey := func(x, y int) uint32 {
		r, g, bl, _ := im.At(b.Min.X+x*(b.Dx()-1)/8, b.Min.Y+y*(b.Dy()-1)/7).RGBA()
		return (r*299 + g*587 + bl*114) / 1000
	}
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			a, c := grey(x, y), grey(x+1, y)
			low = min(low, a)
			high = max(high, a)
			hash <<= 1
			if a > c {
				hash |= 1
			}
		}
	}
	if high-low < 3000 {
		return ""
	}
	return fmt.Sprintf("%016x", hash)
}
