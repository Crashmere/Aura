package library

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func (l *Library) assetFilter(w http.ResponseWriter, q url.Values) (string, []any, bool) {
	where := "WHERE a.trashed_at=''"
	args := []any{}
	switch q.Get("view") {
	case "favorites":
		where += " AND a.favorite=1"
	case "live":
		where += " AND a.kind='live'"
	case "videos":
		where += " AND a.kind='video'"
	case "trash":
		where = "WHERE a.trashed_at!=''"
	case "grouped":
		where += " AND (SELECT count(*) FROM files v WHERE v.asset_id=a.id AND v.mime LIKE 'image/%')>1"
	}
	if album := q.Get("album"); album != "" {
		var exists bool
		if e := l.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM albums WHERE id=?)", album).Scan(&exists); e != nil {
			fail(w, 500, e)
			return "", nil, false
		}
		if !exists {
			fail(w, 404, "相片集不存在")
			return "", nil, false
		}
		where += " AND EXISTS (SELECT 1 FROM album_assets aa WHERE aa.album_id=? AND aa.asset_id=a.id)"
		args = append(args, album)
	}
	if album := q.Get("excludeAlbum"); album != "" {
		where += " AND NOT EXISTS (SELECT 1 FROM album_assets aa WHERE aa.album_id=? AND aa.asset_id=a.id)"
		args = append(args, album)
	}
	if q.Get("excludeAlbums") == "true" {
		where += " AND NOT EXISTS (SELECT 1 FROM album_assets aa WHERE aa.asset_id=a.id)"
	}
	if search := strings.TrimSpace(q.Get("q")); search != "" {
		where += ` AND EXISTS (SELECT 1 FROM files s WHERE s.asset_id=a.id AND (s.name LIKE ? ESCAPE '\' OR s.metadata LIKE ? ESCAPE '\'))`
		search = strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(search)
		args = append(args, "%"+search+"%", "%"+search+"%")
	}
	for _, bound := range []struct{ name, comparison string }{{"from", ">="}, {"to", "<="}} {
		if date := q.Get(bound.name); date != "" {
			if _, e := time.Parse("2006-01-02", date); e != nil {
				fail(w, 400, "日期格式应为 YYYY-MM-DD")
				return "", nil, false
			}
			where += " AND substr(a.captured_at,1,10)" + bound.comparison + "?"
			args = append(args, date)
		}
	}
	if q.Get("from") != "" && q.Get("to") != "" && q.Get("from") > q.Get("to") {
		fail(w, 400, "开始日期不能晚于结束日期")
		return "", nil, false
	}
	return where, args, true
}

func pageLimit(q url.Values, fallback, maximum int) int {
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit < 1 || limit > maximum {
		return fallback
	}
	return limit
}

func pageCursor(w http.ResponseWriter, cursor string) (string, string, bool) {
	if cursor == "" {
		return "", "", true
	}
	parts := strings.SplitN(cursor, "|", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		fail(w, 400, "分页位置无效")
		return "", "", false
	}
	return parts[0], parts[1], true
}

func (l *Library) timeline(w http.ResponseWriter, r *http.Request) {
	where, args, ok := l.assetFilter(w, r.URL.Query())
	if !ok {
		return
	}
	rows, e := l.DB.Query("SELECT substr(a.captured_at,1,7),count(*) FROM assets a JOIN files f ON f.hash=a.primary_hash "+where+" GROUP BY substr(a.captured_at,1,7) ORDER BY substr(a.captured_at,1,7) DESC", args...)
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer rows.Close()
	type monthCount struct {
		Month string `json:"month"`
		Count int    `json:"count"`
	}
	months := []monthCount{}
	for rows.Next() {
		var month monthCount
		if e = rows.Scan(&month.Month, &month.Count); e != nil {
			fail(w, 500, e)
			return
		}
		months = append(months, month)
	}
	if e = rows.Err(); e != nil {
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, map[string]any{"months": months})
}
