package library

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"
)

type assetSimilarCursor struct {
	ID       string  `json:"id"`
	Distance int     `json:"distance"`
	Score    float32 `json:"score"`
}

func (l *Library) assetSimilar(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	q := r.URL.Query()
	source := q.Get("source")
	if source == "" {
		source = "dhash"
	}
	if !validID.MatchString(id) || source != "dhash" && source != "dino" {
		fail(w, 400, "照片或相似类型无效")
		return
	}
	if album := q.Get("album"); album != "" && !validID.MatchString(album) {
		fail(w, 400, "相片集无效")
		return
	}
	selected, err := l.assetCards(r.Context(), map[string]bool{id: true})
	if err != nil {
		fail(w, 500, err)
		return
	}
	asset, exists := selected[id]
	if !exists || asset.TrashedAt != "" || asset.DeletionPending {
		fail(w, 404, "照片不存在或已移入最近删除")
		return
	}
	excluded := map[string]bool{}
	if q.Get("outsideAlbums") == "true" {
		album := q.Get("album")
		if album != "" {
			member := false
			for _, item := range asset.Albums {
				member = member || item.ID == album
			}
			if !member {
				fail(w, 400, "照片不在所选相片集中")
				return
			}
		}
		excluded, err = l.similarAlbumExclusions(r.Context(), id, album)
		if err != nil {
			fail(w, 500, err)
			return
		}
	}
	pairs, err := l.assetSimilarPairs(r.Context(), id, source, excluded)
	if err != nil {
		fail(w, 500, err)
		return
	}
	position := func(pair similarPair) assetSimilarCursor {
		target := pair.Right
		if target == id {
			target = pair.Left
		}
		return assetSimilarCursor{ID: target, Distance: pair.Distance, Score: pair.Score}
	}
	less := func(a, b assetSimilarCursor) bool {
		if source == "dhash" && a.Distance != b.Distance {
			return a.Distance < b.Distance
		}
		if source == "dino" && a.Score != b.Score {
			return a.Score > b.Score
		}
		return a.ID < b.ID
	}
	sort.Slice(pairs, func(i, j int) bool { return less(position(pairs[i]), position(pairs[j])) })
	start := 0
	if rawCursor := q.Get("cursor"); rawCursor != "" {
		var cursor assetSimilarCursor
		raw, err := base64.RawURLEncoding.DecodeString(rawCursor)
		if err != nil || json.Unmarshal(raw, &cursor) != nil || !validID.MatchString(cursor.ID) || cursor.Distance < 0 || cursor.Distance > 4 || source == "dino" && (cursor.Score < .7 || cursor.Score > 1.001) {
			fail(w, 400, "分页位置无效")
			return
		}
		start = sort.Search(len(pairs), func(i int) bool { return less(cursor, position(pairs[i])) })
	}
	end := min(len(pairs), start+pageLimit(q, 24, 100))
	items := pairs[start:end]
	next := ""
	if end < len(pairs) && len(items) > 0 {
		next = base64.RawURLEncoding.EncodeToString([]byte(marshal(position(items[len(items)-1]))))
	}
	ids := map[string]bool{}
	for _, pair := range items {
		ids[position(pair).ID] = true
	}
	cards, err := l.assetCards(r.Context(), ids)
	if err != nil {
		fail(w, 500, err)
		return
	}
	out := map[string]any{"items": items, "assets": cards, "next": next, "total": len(pairs)}
	if source == "dino" {
		out["index"] = l.dinoSnapshot()
	}
	writeJSON(w, 200, out)
}

func (l *Library) assetSimilarPairs(ctx context.Context, id, source string, excluded map[string]bool) ([]similarPair, error) {
	pairs := []similarPair{}
	if source == "dino" {
		value, err := l.cachedCatalog(ctx, "dino-pairs", "review", func() (any, error) { return l.buildDINOPairs(ctx) })
		if err != nil {
			return nil, err
		}
		for _, pair := range value.([]similarPair) {
			if (pair.Left == id || pair.Right == id) && !excluded[pair.Left] && !excluded[pair.Right] {
				pairs = append(pairs, pair)
			}
		}
		return pairs, nil
	}
	value, err := l.cachedCatalog(ctx, "dhash-index", "library", func() (any, error) { return l.buildDHashIndex(ctx) })
	if err != nil {
		return nil, err
	}
	index := value.(*dhashIndex)
	position, exists := index.byID[id]
	if !exists {
		return pairs, nil
	}
	ignored, err := l.ignoredPairs()
	if err != nil {
		return nil, err
	}
	for _, match := range index.findMatches(position, false) {
		if !excluded[match.Item.ID] && !ignored[pairKey(id, match.Item.ID)] {
			pairs = append(pairs, similarPair{Left: id, Right: match.Item.ID, Distance: match.Distance, Source: source})
		}
	}
	return pairs, nil
}

func (l *Library) similarAlbumExclusions(ctx context.Context, id, album string) (map[string]bool, error) {
	query := `SELECT DISTINCT candidate.asset_id FROM album_assets candidate
 JOIN album_assets current ON current.album_id=candidate.album_id WHERE current.asset_id=?`
	args := []any{id}
	if album != "" {
		query = "SELECT asset_id FROM album_assets WHERE album_id=?"
		args = []any{album}
	}
	rows, err := l.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	excluded := map[string]bool{}
	for rows.Next() {
		var target string
		if err = rows.Scan(&target); err != nil {
			return nil, err
		}
		if target != id {
			excluded[target] = true
		}
	}
	return excluded, rows.Err()
}
