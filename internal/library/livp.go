package library

import (
	"encoding/json"
	"errors"
	"strings"
)

var errLIVPIdentifier = errors.New("LIVP 照片与视频的 Apple 内容标识不一致，无法配对")

func livpSource(source string) bool {
	return strings.HasPrefix(source, "livp:") && validHash.MatchString(strings.TrimPrefix(source, "livp:"))
}

func livpMotionRole(role string) string {
	switch role {
	case "originalPhoto":
		return "originalPairedVideo"
	case "originalPairedVideo":
		return "originalPhoto"
	}
	return ""
}

// Previously uploaded originals retain their first hints; later archive groups live in observations.
func loadLIVPGroups(q queryer, asset string, files []File) error {
	rows, err := q.Query(`SELECT o.hash,o.hints FROM observations o JOIN files f ON f.hash=o.hash
 WHERE f.asset_id=? AND json_extract(o.hints,'$.sourceKey') LIKE 'livp:%'`, asset)
	if err != nil {
		return err
	}
	defer rows.Close()
	byHash := map[string]int{}
	for i := range files {
		byHash[files[i].Hash] = i
	}
	for rows.Next() {
		var hash, raw string
		var hints Hints
		if err = rows.Scan(&hash, &raw); err != nil {
			return err
		}
		if err = json.Unmarshal([]byte(raw), &hints); err != nil {
			return err
		}
		if i, ok := byHash[hash]; ok && livpSource(hints.SourceKey) {
			files[i].livpGroups = append(files[i].livpGroups, hints)
		}
	}
	return rows.Err()
}

func livpPaired(still, motion File) bool {
	if still.ContentID != "" && motion.ContentID != "" && still.ContentID != motion.ContentID {
		return false
	}
	for _, photo := range append(still.livpGroups, still.Hints) {
		if !livpSource(photo.SourceKey) || photo.ResourceType != "originalPhoto" {
			continue
		}
		for _, video := range append(motion.livpGroups, motion.Hints) {
			if video.SourceKey == photo.SourceKey && video.ResourceType == "originalPairedVideo" {
				return true
			}
		}
	}
	return false
}

func validateLIVPIdentifier(q queryer, hints Hints, contentID string) error {
	role := livpMotionRole(hints.ResourceType)
	if !livpSource(hints.SourceKey) || contentID == "" || role == "" {
		return nil
	}
	var conflict bool
	err := q.QueryRow(`SELECT EXISTS(SELECT 1 FROM files f WHERE f.asset_id=(SELECT asset_id FROM asset_keys WHERE key=?)
 AND f.hash<>? AND f.content_id<>'' AND f.content_id<>?
 AND ((json_extract(f.hints,'$.sourceKey')=? AND json_extract(f.hints,'$.resourceType')=?)
 OR EXISTS(SELECT 1 FROM observations o WHERE o.hash=f.hash
 AND json_extract(o.hints,'$.sourceKey')=? AND json_extract(o.hints,'$.resourceType')=?)))`,
		"source:"+hints.SourceKey, hints.Hash, contentID, hints.SourceKey, role, hints.SourceKey, role).Scan(&conflict)
	if err != nil {
		return err
	}
	if conflict {
		return errLIVPIdentifier
	}
	return nil
}
