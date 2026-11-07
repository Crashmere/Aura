package library

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"
)

func (l *Library) buildVideoPairs(ctx context.Context) ([]similarPair, error) {
	ignored, err := l.ignoredPairs()
	if err != nil {
		return nil, err
	}
	rows, err := l.DB.QueryContext(ctx, `SELECT f.hash,a.id FROM assets a JOIN files f ON f.hash=a.primary_hash
 WHERE a.kind='video' AND a.trashed_at='' AND f.status='ready'
 AND NOT EXISTS(SELECT 1 FROM deletion_hashes p WHERE p.hash=f.hash)`)
	if err != nil {
		return nil, err
	}
	assets := map[string]string{}
	for rows.Next() {
		var hash, id string
		if err = rows.Scan(&hash, &id); err != nil {
			break
		}
		assets[hash] = id
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, err
	}
	pairs := map[string]similarPair{}
	l.videoMu.RLock()
	for hash, record := range l.videoRecords {
		left := assets[hash]
		if left == "" {
			continue
		}
		for _, match := range record.Matches {
			right := assets[match.Hash]
			target, exists := l.videoRecords[match.Hash]
			if right == "" || left == right || !exists || target.Recipe != videoFeatureRecipe {
				continue
			}
			a, b := orderedDINO(left, right)
			key := pairKey(a, b)
			if ignored[key] {
				continue
			}
			old, exists := pairs[key]
			if exists && (old.Source == "dhash" && match.Source != "dhash" || old.Source == match.Source && old.Score >= match.Score) {
				continue
			}
			samples := append([]videoMatchSample(nil), match.Samples...)
			if a != left {
				for i := range samples {
					samples[i].Left, samples[i].Right = samples[i].Right, samples[i].Left
				}
			}
			pairs[key] = similarPair{Left: a, Right: b, Source: match.Source, Score: match.Score, Media: "video", Coverage: match.Coverage, Samples: samples}
		}
	}
	l.videoMu.RUnlock()
	out := make([]similarPair, 0, len(pairs))
	for _, pair := range pairs {
		out = append(out, pair)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		if out[i].Left != out[j].Left {
			return out[i].Left < out[j].Left
		}
		return out[i].Right < out[j].Right
	})
	return out, nil
}

func (l *Library) addVideoSimilarCounts(ctx context.Context, assets []Asset) error {
	needed := false
	for _, asset := range assets {
		needed = needed || asset.Kind == "video" && asset.TrashedAt == "" && !asset.DeletionPending
	}
	if !needed {
		return nil
	}
	value, err := l.cachedCatalog(ctx, "video-counts", "review", func() (any, error) {
		value, err := l.cachedCatalog(ctx, "video-pairs", "review", func() (any, error) { return l.buildVideoPairs(ctx) })
		if err != nil {
			return nil, err
		}
		counts := map[string]assetSimilarCounts{}
		for _, pair := range value.([]similarPair) {
			for _, id := range []string{pair.Left, pair.Right} {
				count := counts[id]
				if pair.Source == "dhash" {
					count.DHash++
				} else {
					count.DINO++
				}
				counts[id] = count
			}
		}
		return counts, nil
	})
	if err != nil {
		return err
	}
	counts := value.(map[string]assetSimilarCounts)
	for i := range assets {
		if assets[i].Kind == "video" && assets[i].TrashedAt == "" && !assets[i].DeletionPending {
			count := counts[assets[i].ID]
			assets[i].SimilarCounts = &count
		}
	}
	return nil
}

func (l *Library) similarVideo(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	source := q.Get("source")
	if source == "" {
		source = "dhash"
	}
	if source != "dhash" && source != "dino" {
		fail(w, 400, "相似类型无效")
		return
	}
	minimum, maximum := float32(.7), float32(1)
	if source == "dino" {
		var err error
		minimum, maximum, err = similarityScoreRange(q)
		if err != nil {
			fail(w, 400, err)
			return
		}
	}
	var cursor similarPair
	if raw := q.Get("cursor"); raw != "" {
		data, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(data, &cursor) != nil || !validID.MatchString(cursor.Left) || !validID.MatchString(cursor.Right) ||
			cursor.Source != source || cursor.Media != "video" || cursor.Score < .7 || cursor.Score > 1 {
			fail(w, 400, "分页位置无效")
			return
		}
	}
	value, err := l.cachedCatalog(r.Context(), "video-pairs", "review", func() (any, error) { return l.buildVideoPairs(r.Context()) })
	if err != nil {
		fail(w, 500, err)
		return
	}
	counts := map[string]int{"dhash": 0, "dino": 0}
	pairs := []similarPair{}
	for _, pair := range value.([]similarPair) {
		counts[pair.Source]++
		if pair.Source == source && pair.Score >= minimum && pair.Score <= maximum {
			pairs = append(pairs, pair)
		}
	}
	limit := pageLimit(q, 20, 100)
	start, page, err := similarNumberedPage(q, len(pairs), limit)
	if err != nil {
		fail(w, 400, err)
		return
	}
	if cursor.Left != "" {
		start = sort.Search(len(pairs), func(i int) bool {
			p := pairs[i]
			return p.Score < cursor.Score || p.Score == cursor.Score && (p.Left > cursor.Left || p.Left == cursor.Left && p.Right > cursor.Right)
		})
	}
	end := min(len(pairs), start+limit)
	items := pairs[start:end]
	next := ""
	if end < len(pairs) && len(items) > 0 {
		next = base64.RawURLEncoding.EncodeToString([]byte(marshal(items[len(items)-1])))
	}
	ids := map[string]bool{}
	for _, pair := range items {
		ids[pair.Left], ids[pair.Right] = true, true
	}
	cards, err := l.assetCards(r.Context(), ids)
	if err != nil {
		fail(w, 500, err)
		return
	}
	out := map[string]any{"items": items, "assets": cards, "counts": counts, "total": len(pairs), "next": next, "index": l.videoSimilarityStatus()}
	if page > 0 {
		out["page"], out["pageSize"] = page, limit
	}
	writeJSON(w, 200, out)
}
