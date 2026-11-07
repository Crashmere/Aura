package library

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

type catalogCache struct {
	revision int64
	value    any
}

// These projections are disposable. Original catalog rows remain authoritative.
const indexSchema = `
CREATE TABLE IF NOT EXISTS catalog_versions(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
INSERT OR IGNORE INTO catalog_versions VALUES('library',0),('equipment',0),('review',0),('jobs',0),('uploads',0);
CREATE TABLE IF NOT EXISTS facet_dirty(hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS file_facets(hash TEXT PRIMARY KEY REFERENCES files(hash) ON DELETE CASCADE,has_location INTEGER NOT NULL,search_rowid INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS facets_search_rowid ON file_facets(search_rowid) WHERE search_rowid IS NOT NULL;
CREATE TABLE IF NOT EXISTS file_equipment(hash TEXT NOT NULL REFERENCES files(hash) ON DELETE CASCADE,dimension TEXT NOT NULL,value TEXT NOT NULL,preferred INTEGER NOT NULL,PRIMARY KEY(hash,dimension,value));
CREATE INDEX IF NOT EXISTS equipment_value ON file_equipment(dimension,value COLLATE NOCASE,hash);
CREATE INDEX IF NOT EXISTS equipment_options ON file_equipment(preferred,dimension,value COLLATE NOCASE,hash);
CREATE VIRTUAL TABLE IF NOT EXISTS file_search USING fts5(hash UNINDEXED,name,metadata,tokenize='trigram');
CREATE INDEX IF NOT EXISTS facets_location ON file_facets(has_location,hash);
CREATE TABLE IF NOT EXISTS deletion_hashes(hash TEXT PRIMARY KEY,request_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deletion_sources(source_key TEXT PRIMARY KEY,request_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deletion_pending(asset_id TEXT PRIMARY KEY,request_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS deletion_pending_request ON deletion_pending(request_id);
CREATE TRIGGER IF NOT EXISTS index_purge_request AFTER INSERT ON decisions WHEN new.action='purge-request' BEGIN
 INSERT OR IGNORE INTO deletion_hashes SELECT value,new.id FROM json_each(new.detail,'$.hashes');
 INSERT OR IGNORE INTO deletion_sources SELECT value,new.id FROM json_each(new.detail,'$.sourceKeys');
 INSERT OR IGNORE INTO deletion_pending SELECT value,new.id FROM json_each(new.detail,'$.ids'); END;
CREATE TRIGGER IF NOT EXISTS index_purge_complete AFTER INSERT ON decisions WHEN new.action='purge-complete' BEGIN
 DELETE FROM deletion_pending WHERE request_id=json_extract(new.detail,'$.requestId'); END;
CREATE TABLE IF NOT EXISTS dino_dirty(hash TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS dino_tasks(hash TEXT PRIMARY KEY,thumbnail TEXT NOT NULL,queued_at TEXT NOT NULL,retry_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS dino_tasks_due ON dino_tasks(retry_at,queued_at,hash);
CREATE TABLE IF NOT EXISTS video_tasks(hash TEXT PRIMARY KEY REFERENCES files(hash) ON DELETE CASCADE,queued_at TEXT NOT NULL,retry_at TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS video_tasks_due ON video_tasks(retry_at,queued_at,hash);
CREATE TABLE IF NOT EXISTS job_activity(hash TEXT PRIMARY KEY REFERENCES files(hash) ON DELETE CASCADE,activity_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS job_activity_time ON job_activity(activity_at DESC,hash DESC);
`

func (l *Library) initializeIndexes() error {
	if _, err := l.DB.Exec(indexSchema); err != nil {
		return err
	}
	// A revision invalidates only the projections that depend on the changed data.
	for table, versions := range map[string]string{
		"assets": "'library','equipment','review'", "files": "'library','review','jobs'",
		"album_assets": "'library'", "albums": "'library'", "uploads": "'uploads'",
	} {
		for _, event := range []string{"INSERT", "UPDATE", "DELETE"} {
			q := fmt.Sprintf(`CREATE TRIGGER IF NOT EXISTS version_%s_%s AFTER %s ON %s BEGIN UPDATE catalog_versions SET value=value+1 WHERE name IN (%s); END;`, table, strings.ToLower(event), event, table, versions)
			if _, err := l.DB.Exec(q); err != nil {
				return err
			}
		}
	}
	triggers := []string{
		`CREATE TRIGGER IF NOT EXISTS index_search_delete BEFORE DELETE ON files BEGIN DELETE FROM file_search WHERE rowid=(SELECT search_rowid FROM file_facets WHERE hash=old.hash); END`,
		`CREATE TRIGGER IF NOT EXISTS index_file_insert AFTER INSERT ON files BEGIN
 INSERT OR IGNORE INTO facet_dirty VALUES(new.hash); INSERT OR IGNORE INTO dino_dirty VALUES(new.hash);
 INSERT INTO job_activity VALUES(new.hash,new.created_at) ON CONFLICT(hash) DO UPDATE SET activity_at=excluded.activity_at; END`,
		`CREATE TRIGGER IF NOT EXISTS index_file_update AFTER UPDATE OF metadata,hints,name ON files
 WHEN old.metadata!=new.metadata OR old.hints!=new.hints OR old.name!=new.name BEGIN INSERT OR IGNORE INTO facet_dirty VALUES(new.hash); END`,
		`CREATE TRIGGER IF NOT EXISTS index_file_dino AFTER UPDATE OF asset_id,status,dhash,width,height ON files BEGIN
 INSERT OR IGNORE INTO dino_dirty VALUES(new.hash); END`,
		`CREATE TRIGGER IF NOT EXISTS index_file_delete AFTER DELETE ON files BEGIN
 INSERT OR IGNORE INTO dino_dirty VALUES(old.hash); DELETE FROM facet_dirty WHERE hash=old.hash;
 DELETE FROM dino_tasks WHERE hash=old.hash; UPDATE catalog_versions SET value=value+1 WHERE name='equipment'; END`,
		`CREATE TRIGGER IF NOT EXISTS index_asset_insert AFTER INSERT ON assets BEGIN INSERT OR IGNORE INTO dino_dirty VALUES(new.primary_hash); END`,
		`CREATE TRIGGER IF NOT EXISTS index_asset_update AFTER UPDATE OF primary_hash,trashed_at ON assets BEGIN
 INSERT OR IGNORE INTO dino_dirty VALUES(old.primary_hash); INSERT OR IGNORE INTO dino_dirty VALUES(new.primary_hash); END`,
		`CREATE TRIGGER IF NOT EXISTS index_asset_delete AFTER DELETE ON assets BEGIN INSERT OR IGNORE INTO dino_dirty VALUES(old.primary_hash); END`,
	}
	for _, q := range triggers {
		if _, err := l.DB.Exec(q); err != nil {
			return err
		}
	}
	for _, event := range []string{"INSERT", "UPDATE"} {
		q := fmt.Sprintf(`CREATE TRIGGER IF NOT EXISTS index_decision_%s AFTER %s ON decisions BEGIN
 UPDATE catalog_versions SET value=value+1 WHERE name IN ('library','review') AND new.action!='media-job';
 UPDATE catalog_versions SET value=value+1 WHERE name='jobs' AND new.action='media-job';
 INSERT INTO job_activity SELECT substr(new.id,11),COALESCE(json_extract(new.detail,'$.finishedAt'),json_extract(new.detail,'$.startedAt'),new.created_at)
 WHERE new.action='media-job' AND EXISTS(SELECT 1 FROM files WHERE hash=substr(new.id,11)) ON CONFLICT(hash) DO UPDATE SET activity_at=excluded.activity_at;
 INSERT OR IGNORE INTO dino_dirty SELECT value FROM json_each(new.detail,'$.hashes') WHERE new.action='purge-request'; END`, strings.ToLower(event), event)
		if _, err := l.DB.Exec(q); err != nil {
			return err
		}
	}
	if _, err := l.DB.Exec(`INSERT OR IGNORE INTO facet_dirty SELECT hash FROM files WHERE NOT EXISTS(SELECT 1 FROM file_facets p WHERE p.hash=files.hash);
INSERT INTO job_activity SELECT f.hash,COALESCE(json_extract(d.detail,'$.finishedAt'),json_extract(d.detail,'$.startedAt'),f.created_at) FROM files f LEFT JOIN decisions d ON d.id='media-job:'||f.hash AND d.action='media-job' WHERE 1 ON CONFLICT(hash) DO UPDATE SET activity_at=excluded.activity_at;`); err != nil {
		return err
	}
	if _, err := l.DB.Exec(`INSERT OR IGNORE INTO deletion_hashes SELECT h.value,d.id FROM decisions d,json_each(d.detail,'$.hashes') h WHERE d.action='purge-request';
INSERT OR IGNORE INTO deletion_sources SELECT h.value,d.id FROM decisions d,json_each(d.detail,'$.sourceKeys') h WHERE d.action='purge-request';
INSERT OR IGNORE INTO deletion_pending SELECT h.value,d.id FROM decisions d,json_each(d.detail,'$.ids') h WHERE d.action='purge-request' AND NOT EXISTS(SELECT 1 FROM decisions c WHERE c.action='purge-complete' AND json_extract(c.detail,'$.requestId')=d.id);`); err != nil {
		return err
	}
	return l.syncFacets(context.Background())
}

func (l *Library) revision(ctx context.Context, name string) (int64, error) {
	var value int64
	err := l.DB.QueryRowContext(ctx, "SELECT value FROM catalog_versions WHERE name=?", name).Scan(&value)
	return value, err
}

func (l *Library) cachedCatalog(ctx context.Context, key, version string, build func() (any, error)) (any, error) {
	lock, _ := l.cacheBuilds.LoadOrStore(key, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()
	rev, err := l.revision(ctx, version)
	if err != nil {
		return nil, err
	}
	l.cacheMu.Lock()
	cached, ok := l.cache[key]
	l.cacheMu.Unlock()
	if ok && cached.revision == rev {
		return cached.value, nil
	}
	value, err := build()
	if err != nil {
		return nil, err
	}
	l.cacheMu.Lock()
	if len(l.cache) > 128 {
		l.cache = map[string]catalogCache{}
	}
	l.cache[key] = catalogCache{rev, value}
	l.cacheMu.Unlock()
	return value, nil
}

func (l *Library) reviewIndexLoop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if l.dinoSnapshot().Pending == 0 {
			_, err := l.cachedCatalog(ctx, "dino-pairs", "review", func() (any, error) { return l.buildDINOPairs(ctx) })
			if err != nil && ctx.Err() == nil {
				slog.Error("similarity index", "error", err)
			}
		}
		_, err := l.cachedCatalog(ctx, "dhash-index", "library", func() (any, error) { return l.buildDHashIndex(ctx) })
		if err != nil && ctx.Err() == nil {
			slog.Error("fingerprint index", "error", err)
		}
	}
}

func metadataScalar(v any) (string, bool) {
	switch x := v.(type) {
	case string:
		return x, true
	case json.Number:
		return x.String(), true
	}
	return "", false
}

func metadataKey(key, wanted string) bool {
	if strings.Contains(key, ":") {
		return strings.EqualFold(key[strings.LastIndex(key, ":")+1:], wanted)
	}
	return key == wanted
}

func (l *Library) syncFacets(ctx context.Context) error {
	l.facetMu.Lock()
	defer l.facetMu.Unlock()
	for {
		rows, err := l.DB.QueryContext(ctx, `SELECT f.hash,f.metadata,f.hints,f.name FROM facet_dirty p JOIN files f ON f.hash=p.hash LIMIT 128`)
		if err != nil {
			return err
		}
		type entry struct{ hash, meta, hints, name string }
		items := []entry{}
		for rows.Next() {
			var e entry
			if err = rows.Scan(&e.hash, &e.meta, &e.hints, &e.name); err != nil {
				break
			}
			items = append(items, e)
		}
		if err == nil {
			err = rows.Err()
		}
		rows.Close()
		if err != nil {
			return err
		}
		if len(items) == 0 {
			return nil
		}
		tx, err := l.DB.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		for _, item := range items {
			meta := map[string]any{}
			decoder := json.NewDecoder(strings.NewReader(item.meta))
			decoder.UseNumber()
			_ = decoder.Decode(&meta)
			var hints Hints
			_ = json.Unmarshal([]byte(item.hints), &hints)
			location := hints.Latitude != nil && hints.Longitude != nil
			lat, lon := false, false
			for key, v := range meta {
				value, ok := metadataScalar(v)
				if !ok || strings.TrimSpace(value) == "" {
					continue
				}
				if metadataKey(key, "GPSPosition") || metadataKey(key, "GPSCoordinates") {
					location = true
				}
				lat = lat || metadataKey(key, "GPSLatitude")
				lon = lon || metadataKey(key, "GPSLongitude")
			}
			_, err = tx.Exec(`INSERT INTO file_facets(hash,has_location) VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET has_location=excluded.has_location`, item.hash, location || lat && lon)
			if err != nil {
				break
			}
			if _, err = tx.Exec("DELETE FROM file_search WHERE rowid=(SELECT search_rowid FROM file_facets WHERE hash=?)", item.hash); err != nil {
				break
			}
			result, e := tx.Exec("INSERT INTO file_search(hash,name,metadata) VALUES(?,?,?)", item.hash, item.name, item.meta)
			if e != nil {
				err = e
				break
			}
			searchID, e := result.LastInsertId()
			if e != nil {
				err = e
				break
			}
			if _, err = tx.Exec("UPDATE file_facets SET search_rowid=? WHERE hash=?", searchID, item.hash); err != nil {
				break
			}
			if _, err = tx.Exec("DELETE FROM file_equipment WHERE hash=?", item.hash); err != nil {
				break
			}
			for _, field := range assetEquipmentFields {
				values := map[string]int{}
				best := len(field.keys)
				for key, v := range meta {
					value, ok := metadataScalar(v)
					value = strings.TrimSpace(value)
					if !ok || value == "" {
						continue
					}
					for tier, keys := range field.keys {
						matched := false
						for _, wanted := range strings.Fields(keys) {
							matched = matched || metadataKey(key, wanted)
						}
						if !matched {
							continue
						}
						if old, ok := values[value]; !ok || tier < old {
							values[value] = tier
						}
						best = min(best, tier)
						break
					}
				}
				for value, tier := range values {
					if _, err = tx.Exec("INSERT INTO file_equipment VALUES(?,?,?,?)", item.hash, field.name, value, tier == best); err != nil {
						break
					}
				}
				if err != nil {
					break
				}
			}
			if err != nil {
				break
			}
			// Leave a new invalidation queued if metadata changed after the read.
			_, err = tx.Exec(`DELETE FROM facet_dirty WHERE hash=? AND EXISTS(SELECT 1 FROM files f WHERE f.hash=? AND f.metadata=? AND f.hints=? AND f.name=?)`, item.hash, item.hash, item.meta, item.hints, item.name)
			if err != nil {
				break
			}
		}
		if err == nil {
			_, err = tx.Exec("UPDATE catalog_versions SET value=value+1 WHERE name='equipment'")
		}
		if err == nil {
			err = tx.Commit()
		} else {
			tx.Rollback()
		}
		if err != nil {
			return err
		}
	}
}

func (l *Library) facetLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := l.syncFacets(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("metadata index", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Readers of a metadata filter synchronize only changed originals, never the full catalog.
func (l *Library) ensureFacets(ctx context.Context) error { return l.syncFacets(ctx) }
