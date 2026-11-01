package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"math/bits"
	"math/rand"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestIndexesInitializeLegacyCatalogWithoutRewritingRows(t *testing.T) {
	root := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(root, "aura.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(schema); err != nil {
		t.Fatal(err)
	}
	id, hash := fmt.Sprintf("%032x", 1), fmt.Sprintf("%064x", 1)
	if _, err = db.Exec("INSERT INTO assets(id,primary_hash,captured_at,created_at) VALUES(?,?,'2026-11-01','2026-11-01')", id, hash); err != nil {
		t.Fatal(err)
	}
	metadata := `{"IFD0:Model":"Legacy Camera","ExifIFD:LensModel":"Legacy Lens"}`
	if _, err = db.Exec("INSERT INTO files(hash,asset_id,name,size,mime,status,hints,metadata,created_at) VALUES(?,?,'original.jpg',4,'image/jpeg','ready','{}',?,'2026-11-01')", hash, id, metadata); err != nil {
		t.Fatal(err)
	}
	db.Close()
	path := filepath.Join(root, "assets", hash[:2], hash)
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte{1, 2, 3, 4}, 0600); err != nil {
		t.Fatal(err)
	}
	l, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer l.DB.Close()
	file, err := l.File(hash)
	if err != nil || string(file.Metadata) != metadata || file.AssetID != id || file.Status != "ready" {
		t.Fatal(file, err)
	}
	bytes, err := os.ReadFile(path)
	if err != nil || string(bytes) != string([]byte{1, 2, 3, 4}) {
		t.Fatal(bytes, err)
	}
	var camera string
	if err = l.DB.QueryRow("SELECT value FROM file_equipment WHERE hash=? AND dimension='camera'", hash).Scan(&camera); err != nil || camera != "Legacy Camera" {
		t.Fatal(camera, err)
	}
	if err = CheckData(context.Background(), root); err != nil {
		t.Fatal(err)
	}
}

func TestOptimizedCatalogContracts(t *testing.T) {
	l, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer l.DB.Close()
	ctx := context.Background()
	id := fmt.Sprintf("%032x", 1)
	hash := fmt.Sprintf("%064x", 1)
	_, err = l.DB.Exec("INSERT INTO assets(id,primary_hash,captured_at,created_at) VALUES(?,?,'2026-11-01','2026-11-01')", id, hash)
	if err != nil {
		t.Fatal(err)
	}
	_, err = l.DB.Exec(`INSERT INTO files(hash,asset_id,name,size,mime,width,height,status,hints,metadata,created_at) VALUES(?,?,'Café_100%.jpg',1,'image/jpeg',100,100,'ready','{"latitude":0,"longitude":0}','{"IFD0:Model":" Camera A ","ExifIFD:Model":"Camera B","IFD0:Make":"Fallback","ExifIFD:LensModel":"Lens","GPS:GPSLatitude":0,"GPS:GPSLongitude":0}','2026-11-01')`, hash, id)
	if err != nil {
		t.Fatal(err)
	}
	handler := l.Handler(os.DirFS(l.Root))
	get := func(path string) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	options := get("/api/filter-options")
	if len(options["cameras"].([]any)) != 2 {
		t.Fatal(options)
	}
	for _, path := range []string{"/api/assets?camera=Camera%20A&cameraMatch=exact", "/api/assets?camera=Fallback&cameraMatch=exact", "/api/assets?location=with", "/api/assets?q=Caf", "/api/assets?q=100%25", "/api/assets?q=100%25.jpg", "/api/assets?q=Lens"} {
		if len(get(path)["items"].([]any)) != 1 {
			t.Fatal(path)
		}
	}
	if len(get("/api/assets?location=without")["items"].([]any)) != 0 {
		t.Fatal("negated location filter")
	}
	if len(get("/api/assets?q=unmatched")["items"].([]any)) != 0 {
		t.Fatal("search miss")
	}
	if _, err = l.DB.Exec("UPDATE files SET metadata='{\"IFD0:Model\":\"New Camera\"}' WHERE hash=?", hash); err != nil {
		t.Fatal(err)
	}
	options = get("/api/filter-options")
	if len(options["cameras"].([]any)) != 1 || options["cameras"].([]any)[0] != "New Camera" {
		t.Fatal(options)
	}
	// The outer UPSERT must not turn the progress-index update into a uniqueness failure.
	for _, at := range []string{"2026-11-01T00:00:00Z", "2026-11-01T01:00:00Z"} {
		_, err = l.DB.Exec(`INSERT INTO decisions(id,action,detail,created_at) VALUES(?,'media-job',?,'2026-11-01') ON CONFLICT(id) DO UPDATE SET detail=excluded.detail`, "media-job:"+hash, `{"finishedAt":"`+at+`"}`)
		if err != nil {
			t.Fatal(err)
		}
	}
	var activity string
	l.DB.QueryRow("SELECT activity_at FROM job_activity WHERE hash=?", hash).Scan(&activity)
	if activity != "2026-11-01T01:00:00Z" {
		t.Fatal(activity)
	}
	before, _ := l.revision(ctx, "library")
	_, err = l.DB.Exec("UPDATE assets SET favorite=1 WHERE id=?", id)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := l.revision(ctx, "library")
	if after <= before {
		t.Fatal("stale revision")
	}
	request := ID()
	detail := marshal(map[string]any{"ids": []string{id}, "hashes": []string{hash}, "sourceKeys": []string{"source"}})
	if _, err = l.DB.Exec("INSERT INTO decisions VALUES(?,'purge-request',?,'2026-11-01')", request, detail); err != nil {
		t.Fatal(err)
	}
	if originalDeletion(l.DB, hash, "") == nil || originalDeletion(l.DB, fmt.Sprintf("%064x", 2), "source") == nil {
		t.Fatal("missing deletion guards")
	}
	pending, err := assetDeletion(l.DB, id)
	if err != nil || pending != request {
		t.Fatal(pending, err)
	}
	if _, err = l.DB.Exec("INSERT INTO decisions VALUES(?,'purge-complete',?,'2026-11-01')", ID(), marshal(map[string]string{"requestId": request})); err != nil {
		t.Fatal(err)
	}
	pending, err = assetDeletion(l.DB, id)
	if err != nil || pending != "" {
		t.Fatal(pending, err)
	}
	if originalDeletion(l.DB, hash, "") == nil {
		t.Fatal("completion lost deletion guard")
	}
	if _, err = l.DB.Exec("DELETE FROM files WHERE hash=?", hash); err != nil {
		t.Fatal(err)
	}
	var count int
	l.DB.QueryRow("SELECT count(*) FROM file_search").Scan(&count)
	if count != 0 {
		t.Fatal("deleted search row remains")
	}
}

func TestDHashBlocksPreserveEveryMatch(t *testing.T) {
	rng := rand.New(rand.NewSource(44))
	index := &dhashIndex{}
	for b := range index.blocks {
		index.blocks[b] = map[uint64][]int{}
	}
	for i := 0; i < 300; i++ {
		value := rng.Uint64()
		if i%3 != 0 {
			value = index.items[i-1].Value
			for j := 0; j < i%6; j++ {
				value ^= 1 << uint(rng.Intn(64))
			}
		}
		item := similarItem{ID: fmt.Sprint(i), Value: value, Ratio: 1 + float64(i%4)/100}
		index.items = append(index.items, item)
		for b := range index.blocks {
			key := hashBlock(value, b)
			index.blocks[b][key] = append(index.blocks[b][key], i)
		}
	}
	for i, item := range index.items {
		actual := map[string]int{}
		for _, match := range index.matches(i) {
			actual[match.Item.ID] = match.Distance
		}
		expected := 0
		for j := 0; j < i; j++ {
			other := index.items[j]
			distance := bits.OnesCount64(item.Value ^ other.Value)
			if distance <= 4 && math.Abs(item.Ratio-other.Ratio) < .03 {
				expected++
				if actual[other.ID] != distance {
					t.Fatalf("lost %d %d", i, j)
				}
			}
		}
		if len(actual) != expected {
			t.Fatalf("unexpected matches %d", i)
		}
	}
}
