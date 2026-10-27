package library

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Library struct {
	DB       *sql.DB
	Root     string
	UploadMu sync.Mutex
	Wake     chan struct{}
}

type Hints struct {
	Name         string   `json:"name"`
	Hash         string   `json:"hash"`
	Size         int64    `json:"size"`
	CapturedAt   string   `json:"capturedAt,omitempty"`
	ModifiedAt   string   `json:"modifiedAt,omitempty"`
	SourceKey    string   `json:"sourceKey,omitempty"`
	ResourceType string   `json:"resourceType,omitempty"`
	From         string   `json:"from,omitempty"`
	To           string   `json:"to,omitempty"`
	Latitude     *float64 `json:"latitude,omitempty"`
	Longitude    *float64 `json:"longitude,omitempty"`
	Favorite     bool     `json:"favorite,omitempty"`
}

type File struct {
	Hash       string          `json:"hash"`
	AssetID    string          `json:"assetId"`
	Name       string          `json:"name"`
	Size       int64           `json:"size"`
	Mime       string          `json:"mime"`
	Width      int             `json:"width"`
	Height     int             `json:"height"`
	CapturedAt string          `json:"capturedAt"`
	ContentID  string          `json:"contentId,omitempty"`
	PixelHash  string          `json:"pixelHash,omitempty"`
	DHash      string          `json:"dhash,omitempty"`
	Metadata   json.RawMessage `json:"metadata"`
	Score      int64           `json:"score"`
	Status     string          `json:"status"`
	Error      string          `json:"error,omitempty"`
	Hints      Hints           `json:"hints"`
	CreatedAt  string          `json:"createdAt"`
}

type Asset struct {
	ID         string `json:"id"`
	Primary    string `json:"primary"`
	Motion     string `json:"motion,omitempty"`
	CapturedAt string `json:"capturedAt"`
	Kind       string `json:"kind"`
	Favorite   bool   `json:"favorite"`
	TrashedAt  string `json:"trashedAt,omitempty"`
	Name       string `json:"name"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Size       int64  `json:"size"`
	Status     string `json:"status"`
	Variants   int    `json:"variants"`
}

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=10000;
CREATE TABLE IF NOT EXISTS assets (
 id TEXT PRIMARY KEY, primary_hash TEXT NOT NULL DEFAULT '', motion_hash TEXT NOT NULL DEFAULT '',
 captured_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'photo', favorite INTEGER NOT NULL DEFAULT 0,
 trashed_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
 hash TEXT PRIMARY KEY, asset_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, size INTEGER NOT NULL,
 mime TEXT NOT NULL DEFAULT '', width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
 captured_at TEXT NOT NULL DEFAULT '', content_id TEXT NOT NULL DEFAULT '', pixel_hash TEXT NOT NULL DEFAULT '',
 dhash TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}', score INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '', hints TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_asset ON files(asset_id);
CREATE INDEX IF NOT EXISTS files_status ON files(status,created_at);
CREATE INDEX IF NOT EXISTS files_pixels ON files(pixel_hash) WHERE pixel_hash != '';
CREATE INDEX IF NOT EXISTS assets_time ON assets(trashed_at,captured_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS asset_keys (key TEXT PRIMARY KEY, asset_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS keys_asset ON asset_keys(asset_id);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, hints TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'uploading', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, hints TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
PRAGMA user_version=1;
`

func Open(root string) (*Library, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	for _, d := range []string{"", "assets", "derived", "incoming", "work"} {
		if err = os.MkdirAll(filepath.Join(root, d), 0700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "aura.sqlite"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Library{DB: db, Root: root, Wake: make(chan struct{}, 1)}, nil
}
func ID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func now() string                            { return time.Now().UTC().Format(time.RFC3339Nano) }
func (l *Library) Object(hash string) string { return filepath.Join(l.Root, "assets", hash[:2], hash) }
func (l *Library) Derived(hash, suffix string) string {
	return filepath.Join(l.Root, "derived", hash+suffix)
}
func (l *Library) Notify() {
	select {
	case l.Wake <- struct{}{}:
	default:
	}
}
func marshal(v any) string { b, _ := json.Marshal(v); return string(b) }

const fileColumns = "hash,asset_id,name,size,mime,width,height,captured_at,content_id,pixel_hash,dhash,metadata,score,status,error,hints,created_at"

type scanner interface{ Scan(...any) error }

func scanFile(row scanner) (f File, err error) {
	var meta, hints string
	err = row.Scan(&f.Hash, &f.AssetID, &f.Name, &f.Size, &f.Mime, &f.Width, &f.Height, &f.CapturedAt, &f.ContentID, &f.PixelHash, &f.DHash, &meta, &f.Score, &f.Status, &f.Error, &hints, &f.CreatedAt)
	f.Metadata = json.RawMessage(meta)
	_ = json.Unmarshal([]byte(hints), &f.Hints)
	return
}
func (l *Library) File(hash string) (File, error) {
	return scanFile(l.DB.QueryRow("SELECT "+fileColumns+" FROM files WHERE hash=?", hash))
}
func (l *Library) Files(asset string) ([]File, error) {
	rows, err := l.DB.Query("SELECT "+fileColumns+" FROM files WHERE asset_id=? ORDER BY score DESC,created_at", asset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []File{}
	for rows.Next() {
		f, e := scanFile(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

const assetSelect = `SELECT a.id,a.primary_hash,a.motion_hash,a.captured_at,a.kind,a.favorite,a.trashed_at,
 f.name,f.width,f.height,f.size,f.status,(SELECT count(*) FROM files v WHERE v.asset_id=a.id)
 FROM assets a JOIN files f ON f.hash=a.primary_hash `

func scanAsset(row scanner) (a Asset, err error) {
	err = row.Scan(&a.ID, &a.Primary, &a.Motion, &a.CapturedAt, &a.Kind, &a.Favorite, &a.TrashedAt, &a.Name, &a.Width, &a.Height, &a.Size, &a.Status, &a.Variants)
	return
}
func (l *Library) Asset(id string) (Asset, error) {
	return scanAsset(l.DB.QueryRow(assetSelect+"WHERE a.id=?", id))
}

// Group membership is reversible: originals and observations survive every merge.
func mergeTx(tx *sql.Tx, keep, drop, reason string) error {
	if keep == drop || drop == "" {
		return nil
	}
	rows, e := tx.Query("SELECT hash FROM files WHERE asset_id=?", drop)
	if e != nil {
		return e
	}
	hashes := []string{}
	for rows.Next() {
		var h string
		_ = rows.Scan(&h)
		hashes = append(hashes, h)
	}
	rows.Close()
	if _, e = tx.Exec("UPDATE files SET asset_id=? WHERE asset_id=?", keep, drop); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE asset_keys SET asset_id=? WHERE asset_id=?", keep, drop); e != nil {
		return e
	}
	if _, e = tx.Exec("UPDATE assets SET favorite=MAX(favorite,COALESCE((SELECT favorite FROM assets WHERE id=?),0)) WHERE id=?", drop, keep); e != nil {
		return e
	}
	if _, e = tx.Exec("DELETE FROM assets WHERE id=?", drop); e != nil {
		return e
	}
	_, e = tx.Exec("INSERT INTO decisions(id,action,detail,created_at) VALUES(?,?,?,?)", ID(), "merge", marshal(map[string]any{"keep": keep, "drop": drop, "files": hashes, "reason": reason}), now())
	return e
}
func refreshTx(tx *sql.Tx, id string) error {
	var primary, motion, date, mime string
	e := tx.QueryRow(`SELECT hash,captured_at,mime FROM files WHERE asset_id=? ORDER BY CASE WHEN mime LIKE 'image/%' THEN 0 WHEN mime LIKE 'video/%' THEN 1 ELSE 2 END,score DESC,hash LIMIT 1`, id).Scan(&primary, &date, &mime)
	if e != nil {
		return e
	}
	_ = tx.QueryRow("SELECT hash FROM files WHERE asset_id=? AND mime LIKE 'video/%' ORDER BY score DESC,hash LIMIT 1", id).Scan(&motion)
	kind := "photo"
	if strings.HasPrefix(mime, "video/") {
		kind = "video"
		motion = ""
	} else if motion != "" {
		kind = "live"
	}
	_, e = tx.Exec("UPDATE assets SET primary_hash=?,motion_hash=?,captured_at=?,kind=? WHERE id=?", primary, motion, date, kind, id)
	return e
}
func (l *Library) remember(h Hints) error {
	tx, e := l.DB.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	_, e = tx.Exec("INSERT INTO observations VALUES(?,?,?,?)", ID(), h.Hash, marshal(h), now())
	if e != nil {
		return e
	}
	if h.SourceKey != "" {
		var asset, other string
		_ = tx.QueryRow("SELECT asset_id FROM files WHERE hash=?", h.Hash).Scan(&asset)
		if asset != "" {
			key := "source:" + h.SourceKey
			_ = tx.QueryRow("SELECT asset_id FROM asset_keys WHERE key=?", key).Scan(&other)
			if other != "" && other != asset {
				if e = mergeTx(tx, asset, other, "source resource group"); e != nil {
					return e
				}
				if e = refreshTx(tx, asset); e != nil {
					return e
				}
			}
			if _, e = tx.Exec("INSERT INTO asset_keys VALUES(?,?) ON CONFLICT(key) DO UPDATE SET asset_id=excluded.asset_id", key, asset); e != nil {
				return e
			}
		}
	}
	return tx.Commit()
}
func (l *Library) Check(ctx context.Context) error {
	var result string
	if e := l.DB.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); e != nil {
		return e
	}
	if result != "ok" {
		return fmt.Errorf("database check: %s", result)
	}
	return nil
}
