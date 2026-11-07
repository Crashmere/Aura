package library

import (
	"context"
	"math"
	"math/bits"
	"strconv"
	"strings"
)

type dhashIndex struct {
	items  []similarItem
	byID   map[string]int
	blocks [5]map[uint64][]int
}

func hashBlock(value uint64, block int) uint64 {
	if block == 4 {
		return value >> 52
	}
	return (value >> uint(block*13)) & 8191
}

func (l *Library) buildDHashIndex(ctx context.Context) (*dhashIndex, error) {
	rows, err := l.DB.QueryContext(ctx, `SELECT a.id,a.captured_at,f.dhash,f.width,f.height FROM assets a JOIN files f ON f.hash=a.primary_hash WHERE a.trashed_at='' AND f.dhash!='' AND NOT EXISTS(SELECT 1 FROM deletion_hashes p WHERE p.hash=f.hash) ORDER BY a.captured_at DESC,a.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	index := &dhashIndex{byID: map[string]int{}}
	for i := range index.blocks {
		index.blocks[i] = map[uint64][]int{}
	}
	for rows.Next() {
		var item similarItem
		var hash string
		var width, height int
		if err = rows.Scan(&item.ID, &item.Date, &hash, &width, &height); err != nil {
			return nil, err
		}
		if height == 0 {
			continue
		}
		item.Value, err = strconv.ParseUint(hash, 16, 64)
		if err != nil {
			continue
		}
		item.Ratio = float64(width) / float64(height)
		i := len(index.items)
		index.items = append(index.items, item)
		index.byID[item.ID] = i
		for b := range index.blocks {
			key := hashBlock(item.Value, b)
			index.blocks[b][key] = append(index.blocks[b][key], i)
		}
	}
	return index, rows.Err()
}

func (index *dhashIndex) matches(i int) []similarMatch {
	return index.findMatches(i, true)
}

func (index *dhashIndex) findMatches(i int, precedingOnly bool) []similarMatch {
	item := index.items[i]
	seen := map[int]bool{}
	out := []similarMatch{}
	// At distance <=4, one of five disjoint bit blocks must be identical.
	for b := range index.blocks {
		for _, j := range index.blocks[b][hashBlock(item.Value, b)] {
			if precedingOnly && j >= i {
				break
			}
			if j == i || seen[j] {
				continue
			}
			seen[j] = true
			target := index.items[j]
			d := bits.OnesCount64(item.Value ^ target.Value)
			if d <= 4 && math.Abs(item.Ratio-target.Ratio) < .03 {
				out = append(out, similarMatch{target, d})
			}
		}
	}
	return out
}

func (l *Library) assetCards(ctx context.Context, ids map[string]bool) (map[string]Asset, error) {
	out := map[string]Asset{}
	if len(ids) == 0 {
		return out, nil
	}
	args := []any{}
	for id := range ids {
		args = append(args, id)
	}
	rows, err := l.DB.QueryContext(ctx, assetSelect+"WHERE a.id IN ("+strings.TrimSuffix(strings.Repeat("?,", len(args)), ",")+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		asset, err := scanAsset(rows)
		if err != nil {
			return nil, err
		}
		out[asset.ID] = asset
	}
	return out, rows.Err()
}
