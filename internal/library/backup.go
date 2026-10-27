package library

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type BackupEntry struct {
	Hash string `json:"sha256"`
	Path string `json:"path"`
	Size int64  `json:"size"`
}
type BackupManifest struct {
	Version   int               `json:"version"`
	Format    string            `json:"format"`
	CreatedAt string            `json:"createdAt"`
	Files     map[string]string `json:"files"`
	Objects   []BackupEntry     `json:"objects"`
}

func copyImmutable(src, dst string) error {
	if e := os.MkdirAll(filepath.Dir(dst), 0700); e != nil {
		return e
	}
	if e := os.Link(src, dst); e == nil {
		return nil
	}
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	out, e := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = io.Copy(out, in)
	if e == nil {
		e = out.Sync()
	}
	ce := out.Close()
	if e == nil {
		e = ce
	}
	return e
}
func (l *Library) Backup(ctx context.Context, out string) error {
	out, e := filepath.Abs(out)
	if e != nil {
		return e
	}
	if out == l.Root || strings.HasPrefix(out, l.Root+string(os.PathSeparator)) {
		return fmt.Errorf("snapshot must be outside the live data directory")
	}
	if _, e = os.Stat(out); e == nil {
		return fmt.Errorf("snapshot destination already exists")
	}
	stage := out + ".part-" + ID()
	if e = os.MkdirAll(stage, 0700); e != nil {
		return e
	}
	done := false
	defer func() {
		if !done {
			os.RemoveAll(stage)
		}
	}()
	snapshot := filepath.Join(stage, "aura.sqlite")
	if _, e = l.DB.ExecContext(ctx, "VACUUM INTO ?", snapshot); e != nil {
		return e
	}
	db, e := sql.Open("sqlite", snapshot)
	if e != nil {
		return e
	}
	defer db.Close()
	rows, e := db.QueryContext(ctx, "SELECT hash,size FROM files ORDER BY hash")
	if e != nil {
		return e
	}
	manifest := BackupManifest{Version: 1, Format: "aura-snapshot-v1", CreatedAt: now(), Files: map[string]string{}, Objects: []BackupEntry{}}
	for rows.Next() {
		var hash string
		var size int64
		if e = rows.Scan(&hash, &size); e != nil {
			rows.Close()
			return e
		}
		rel := filepath.Join("assets", hash[:2], hash)
		if e = copyImmutable(l.Object(hash), filepath.Join(stage, rel)); e != nil {
			rows.Close()
			return e
		}
		manifest.Objects = append(manifest.Objects, BackupEntry{hash, filepath.ToSlash(rel), size})
		manifest.Files[filepath.ToSlash(rel)] = hash
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	// Snapshot upload offsets cannot resurrect incomplete streams after recovery.
	if _, e = db.Exec("DELETE FROM uploads WHERE state='uploading'"); e != nil {
		return e
	}
	if _, e = db.Exec("PRAGMA journal_mode=DELETE"); e != nil {
		return e
	}
	db.Close()
	dbf, e := os.Open(snapshot)
	if e != nil {
		return e
	}
	sum := sha256.New()
	_, e = io.Copy(sum, dbf)
	dbf.Close()
	if e != nil {
		return e
	}
	manifest.Files["aura.sqlite"] = hex.EncodeToString(sum.Sum(nil))
	if e = os.Chmod(snapshot, 0600); e != nil {
		return e
	}
	raw, e := json.MarshalIndent(manifest, "", "  ")
	if e != nil {
		return e
	}
	if e = os.WriteFile(filepath.Join(stage, "manifest.json"), raw, 0600); e != nil {
		return e
	}
	if e = os.Rename(stage, out); e != nil {
		return e
	}
	done = true
	return nil
}
func VerifySnapshot(ctx context.Context, source string, full bool) error {
	b, e := os.ReadFile(filepath.Join(source, "manifest.json"))
	if e != nil {
		return e
	}
	var m BackupManifest
	if e = json.Unmarshal(b, &m); e != nil {
		return e
	}
	if m.Format != "aura-snapshot-v1" {
		return fmt.Errorf("unsupported backup format")
	}
	db, e := sql.Open("sqlite", "file:"+filepath.Join(source, "aura.sqlite")+"?mode=ro")
	if e != nil {
		return e
	}
	defer db.Close()
	var result string
	if e = db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&result); e != nil {
		return e
	}
	if result != "ok" {
		return fmt.Errorf("database integrity: %s", result)
	}
	var count int
	if e = db.QueryRowContext(ctx, "SELECT count(*) FROM files").Scan(&count); e != nil {
		return e
	}
	if count != len(m.Objects) || len(m.Files) != count+1 {
		return fmt.Errorf("snapshot manifest count mismatch")
	}
	dbf, e := os.Open(filepath.Join(source, "aura.sqlite"))
	if e != nil {
		return e
	}
	sum := sha256.New()
	_, e = io.Copy(sum, dbf)
	dbf.Close()
	if e != nil {
		return e
	}
	if hex.EncodeToString(sum.Sum(nil)) != m.Files["aura.sqlite"] {
		return fmt.Errorf("snapshot database checksum mismatch")
	}
	for _, entry := range m.Objects {
		if !validHash.MatchString(entry.Hash) || entry.Path != filepath.ToSlash(filepath.Join("assets", entry.Hash[:2], entry.Hash)) || m.Files[entry.Path] != entry.Hash {
			return fmt.Errorf("invalid snapshot member")
		}
		var size int64
		if e = db.QueryRowContext(ctx, "SELECT size FROM files WHERE hash=?", entry.Hash).Scan(&size); e != nil || size != entry.Size {
			return fmt.Errorf("snapshot database/manifest mismatch")
		}
		f, e := os.Open(filepath.Join(source, entry.Path))
		if e != nil {
			return e
		}
		st, e := f.Stat()
		if e != nil || st.Size() != entry.Size {
			f.Close()
			return fmt.Errorf("snapshot object size mismatch: %s", entry.Hash)
		}
		if full {
			h := sha256.New()
			_, e = io.Copy(h, f)
			if e != nil {
				f.Close()
				return e
			}
			if hex.EncodeToString(h.Sum(nil)) != entry.Hash {
				f.Close()
				return fmt.Errorf("snapshot checksum mismatch: %s", entry.Hash)
			}
		}
		f.Close()
	}
	return nil
}
func Restore(ctx context.Context, source, out string) error {
	if _, e := os.Stat(out); !os.IsNotExist(e) {
		return fmt.Errorf("restore destination must not exist")
	}
	if e := VerifySnapshot(ctx, source, true); e != nil {
		return e
	}
	stage := out + ".part-" + ID()
	if e := os.MkdirAll(stage, 0700); e != nil {
		return e
	}
	done := false
	defer func() {
		if !done {
			os.RemoveAll(stage)
		}
	}()
	b, _ := os.ReadFile(filepath.Join(source, "manifest.json"))
	var m BackupManifest
	_ = json.Unmarshal(b, &m)
	// Copy the database, never hard-link it to a recovery point.
	src, e := os.Open(filepath.Join(source, "aura.sqlite"))
	if e != nil {
		return e
	}
	defer src.Close()
	dst, e := os.OpenFile(filepath.Join(stage, "aura.sqlite"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = io.Copy(dst, src)
	if e == nil {
		e = dst.Sync()
	}
	dst.Close()
	if e != nil {
		return e
	}
	for _, entry := range m.Objects {
		if e = copyImmutable(filepath.Join(source, entry.Path), filepath.Join(stage, entry.Path)); e != nil {
			return e
		}
	}
	if e = os.Rename(stage, out); e != nil {
		return e
	}
	done = true
	return nil
}
func (l *Library) Daily(ctx context.Context, parent string) error {
	if e := os.MkdirAll(parent, 0700); e != nil {
		return e
	}
	out := filepath.Join(parent, "daily-"+time.Now().Format("20060102-150405"))
	if e := l.Backup(ctx, out); e != nil {
		return e
	}
	entries, e := os.ReadDir(parent)
	if e != nil {
		return e
	}
	names := []string{}
	for _, d := range entries {
		if !d.IsDir() || !strings.HasPrefix(d.Name(), "daily-") {
			continue
		}
		if _, e = time.Parse("20060102-150405", strings.TrimPrefix(d.Name(), "daily-")); e != nil {
			continue
		}
		if _, e = os.Stat(filepath.Join(parent, d.Name(), "manifest.json")); e == nil {
			names = append(names, d.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	for _, name := range names[min(14, len(names)):] {
		if e = os.RemoveAll(filepath.Join(parent, name)); e != nil {
			return e
		}
	}
	return nil
}
