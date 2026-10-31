package library

import (
	"math"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Each entry is one priority tier; grouped variants in the same tier all qualify.
var assetEquipmentFields = []struct {
	name, option string
	keys         []string
}{
	{"camera", "cameras", []string{"Model", "Make"}},
	{"lens", "lenses", []string{"LensModel", "LensID", "Lens", "LensType", "LensInfo LensSpec LensSpecification", "LensMake"}},
}

// Match strings.TrimSpace for both dropdown values and exact comparisons.
const assetMetadataText = `trim(CAST(m.value AS TEXT), char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))`

func (l *Library) filterOptions(w http.ResponseWriter, r *http.Request) {
	queries := []string{}
	options := map[string][]string{}
	for _, field := range assetEquipmentFields {
		options[field.option] = []string{}
		priority := "CASE"
		for i, keys := range field.keys {
			priority += " WHEN " + assetMetadataKeys(keys) + " THEN " + strconv.Itoa(i)
		}
		priority += " END"
		// Rank only nonempty scalar tags, retaining ties between EXIF groups.
		queries = append(queries, `SELECT '`+field.option+`' AS dimension, `+assetMetadataText+` AS value,
 DENSE_RANK() OVER (PARTITION BY r.hash ORDER BY `+priority+`) AS priority
 FROM files r JOIN assets a ON a.id=r.asset_id, json_each(r.metadata) m
 WHERE `+assetMetadataKeys(strings.Join(field.keys, " "))+`
 AND m.type IN ('text','integer','real') AND `+assetMetadataText+`!=''`)
	}
	rows, e := l.DB.QueryContext(r.Context(), `WITH options AS (`+strings.Join(queries, " UNION ALL ")+`)
 SELECT dimension, min(value) AS value FROM options WHERE priority=1
 GROUP BY dimension, value COLLATE NOCASE ORDER BY dimension, value COLLATE NOCASE, value`)
	if e != nil {
		fail(w, 500, e)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var dimension, value string
		if e = rows.Scan(&dimension, &value); e != nil {
			fail(w, 500, e)
			return
		}
		options[dimension] = append(options[dimension], value)
	}
	if e = rows.Err(); e != nil {
		fail(w, 500, e)
		return
	}
	writeJSON(w, 200, options)
}

func (l *Library) assetFilter(w http.ResponseWriter, q url.Values) (string, []any, bool) {
	for _, name := range strings.Fields("view album excludeAlbum excludeAlbums q from to kind format orientation status location versions albumState camera cameraMatch lens lensMatch minSize maxSize minMP maxMP addedFrom addedTo") {
		if len(q[name]) > 1 {
			fail(w, 400, name+" 只能指定一个值")
			return "", nil, false
		}
	}
	for _, enum := range []struct{ name, values string }{
		{"view", "all albums favorites live videos grouped trash"},
		{"kind", "photo live video"},
		{"format", "jpeg heic png gif webp tiff raw avif mov mp4"},
		{"orientation", "landscape portrait square panorama"},
		{"status", "ready queued processing error"},
		{"location", "with without"},
		{"versions", "single multiple"},
		{"albumState", "in none"},
		{"cameraMatch", "exact contains"},
		{"lensMatch", "exact contains"},
	} {
		if value := q.Get(enum.name); value != "" && !slices.Contains(strings.Fields(enum.values), value) {
			fail(w, 400, enum.name+" 筛选值无效")
			return "", nil, false
		}
	}
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
	for _, field := range []struct{ name, column string }{{"kind", "a.kind"}, {"status", "f.status"}} {
		if value := q.Get(field.name); value != "" {
			where += " AND " + field.column + "=?"
			args = append(args, value)
		}
	}
	if orientation := q.Get("orientation"); orientation != "" {
		where += " AND f.width>0 AND f.height>0 AND "
		switch orientation {
		case "landscape":
			where += "f.width>f.height"
		case "portrait":
			where += "f.width<f.height"
		case "square":
			where += "f.width=f.height"
		case "panorama":
			where += "f.width>=2.0*f.height"
		}
	}
	if format := q.Get("format"); format != "" {
		where += " AND EXISTS (SELECT 1 FROM files r WHERE r.asset_id=a.id AND (" + assetFormatSQL(format) + "))"
	}
	if versions := q.Get("versions"); versions != "" {
		where += " AND (SELECT count(*) FROM files v WHERE v.asset_id=a.id AND v.mime LIKE 'image/%')"
		if versions == "single" {
			where += "=1"
		} else {
			where += ">1"
		}
	}
	// Scalar bounds use the primary file already joined by both callers.
	for _, bounds := range []struct{ min, max, column string }{
		{"minSize", "maxSize", "f.size"},
		{"minMP", "maxMP", "(1.0*f.width*f.height/1000000.0)"},
	} {
		var lower, upper float64
		for i, name := range []string{bounds.min, bounds.max} {
			value := q.Get(name)
			if value == "" {
				continue
			}
			var number any
			var n float64
			var e error
			if bounds.min == "minSize" {
				var size int64
				size, e = strconv.ParseInt(value, 10, 64)
				number, n = size, float64(size)
			} else {
				n, e = strconv.ParseFloat(value, 64)
				number = n
			}
			if e != nil || n < 0 || math.IsNaN(n) || math.IsInf(n, 0) {
				fail(w, 400, name+" 必须是有效的非负数，字节数必须为整数")
				return "", nil, false
			}
			comparison := ">="
			if i == 0 {
				lower = n
			} else {
				upper = n
				comparison = "<="
			}
			where += " AND " + bounds.column + comparison + "?"
			args = append(args, number)
		}
		if q.Get(bounds.min) != "" && q.Get(bounds.max) != "" {
			inverted := lower > upper
			if bounds.min == "minSize" {
				// Keep comparisons exact even above float64's integer precision.
				minSize, _ := strconv.ParseInt(q.Get(bounds.min), 10, 64)
				maxSize, _ := strconv.ParseInt(q.Get(bounds.max), 10, 64)
				inverted = minSize > maxSize
			}
			if inverted {
				fail(w, 400, bounds.min+" 不能大于 "+bounds.max)
				return "", nil, false
			}
		}
		if bounds.min == "minMP" && (q.Get(bounds.min) != "" || q.Get(bounds.max) != "") {
			where += " AND f.width>0 AND f.height>0"
		}
	}
	for _, dates := range []struct{ from, to, column string }{
		{"from", "to", "a.captured_at"},
		{"addedFrom", "addedTo", "a.created_at"},
	} {
		for i, name := range []string{dates.from, dates.to} {
			if date := q.Get(name); date != "" {
				parsed, e := time.ParseInLocation("2006-01-02", date, time.Local)
				if e != nil || parsed.Year() < 1 {
					fail(w, 400, name+" 日期格式应为 YYYY-MM-DD")
					return "", nil, false
				}
				comparison := ">="
				if i == 1 {
					comparison = "<="
				}
				column := "substr(" + dates.column + ",1,10)"
				if dates.column == "a.created_at" {
					if i == 1 {
						parsed = parsed.AddDate(0, 0, 1)
						comparison = "<"
					}
					column = dates.column
					// created_at is UTC RFC3339Nano. A bare second prefix sorts
					// before both '.fractionZ' and 'Z', giving exact [start, end)
					// local-day bounds without rounding fractional timestamps.
					date = parsed.UTC().Format("2006-01-02T15:04:05")
				}
				where += " AND " + column + comparison + "?"
				args = append(args, date)
			}
		}
		if q.Get(dates.from) != "" && q.Get(dates.to) != "" && q.Get(dates.from) > q.Get(dates.to) {
			fail(w, 400, dates.from+" 不能晚于 "+dates.to)
			return "", nil, false
		}
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
	if q.Get("excludeAlbums") == "true" || q.Get("albumState") == "none" {
		where += " AND NOT EXISTS (SELECT 1 FROM album_assets aa WHERE aa.asset_id=a.id)"
	}
	if q.Get("albumState") == "in" {
		where += " AND EXISTS (SELECT 1 FROM album_assets aa WHERE aa.asset_id=a.id)"
	}
	if search := strings.TrimSpace(q.Get("q")); search != "" {
		where += ` AND EXISTS (SELECT 1 FROM files s WHERE s.asset_id=a.id AND (s.name LIKE ? ESCAPE '\' OR s.metadata LIKE ? ESCAPE '\'))`
		args = append(args, assetTextPattern(search), assetTextPattern(search))
	}
	// Inspect metadata only for requested dimensions, after locating each asset's
	// originals through files_asset. ExifTool -G1 stores group-prefixed keys.
	for _, field := range assetEquipmentFields {
		if value := strings.TrimSpace(q.Get(field.name)); value != "" {
			comparison := `CAST(m.value AS TEXT) LIKE ? ESCAPE '\'`
			argument := assetTextPattern(value)
			if q.Get(field.name+"Match") == "exact" {
				comparison = assetMetadataText + " = ? COLLATE NOCASE"
				argument = value
			}
			where += ` AND EXISTS (SELECT 1 FROM files r WHERE r.asset_id=a.id AND EXISTS
 (SELECT 1 FROM json_each(r.metadata) m WHERE ` + assetMetadataKeys(strings.Join(field.keys, " ")) + `
 AND m.type IN ('text','integer','real') AND ` + comparison + `))`
			args = append(args, argument)
		}
	}
	if location := q.Get("location"); location != "" {
		where += " AND "
		if location == "without" {
			where += "NOT "
		}
		// CASE skips EXIF parsing when native hints already contain both coordinates.
		// Presence checks retain numeric zero, including (0, 0).
		where += `EXISTS (SELECT 1 FROM files r WHERE r.asset_id=a.id AND CASE
 WHEN json_type(r.hints,'$.latitude') IN ('integer','real')
  AND json_type(r.hints,'$.longitude') IN ('integer','real') THEN 1
 ELSE (SELECT COALESCE(max(CASE WHEN ` + assetMetadataKeys("GPSPosition GPSCoordinates") + ` THEN 1 ELSE 0 END),0)
  OR count(DISTINCT CASE WHEN ` + assetMetadataKeys("GPSLatitude") + ` THEN 'lat'
                        WHEN ` + assetMetadataKeys("GPSLongitude") + ` THEN 'lon' END)=2
 FROM json_each(r.metadata) m WHERE m.type IN ('text','integer','real') AND trim(CAST(m.value AS TEXT))!='') END)`
	}
	return where, args, true
}

func assetTextPattern(value string) string {
	return "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(value) + "%"
}

// Keys come only from the fixed tag lists above, never from query parameters.
func assetMetadataKeys(keys string) string {
	conditions := []string{}
	for _, key := range strings.Fields(keys) {
		conditions = append(conditions, "m.key='"+key+"' OR m.key LIKE '%:"+key+"'")
	}
	return "(" + strings.Join(conditions, " OR ") + ")"
}

func assetFormatSQL(format string) string {
	var mimes, extensions string
	switch format {
	case "jpeg":
		mimes, extensions = "image/jpeg image/jpg image/pjpeg", "jpg jpeg"
	case "heic":
		mimes, extensions = "image/heic image/heif image/heic-sequence image/heif-sequence", "heic heif"
	case "png":
		mimes, extensions = "image/png", "png"
	case "gif":
		mimes, extensions = "image/gif", "gif"
	case "webp":
		mimes, extensions = "image/webp", "webp"
	case "tiff":
		mimes, extensions = "image/tiff image/x-tiff", "tif tiff"
	case "raw":
		mimes = "image/x-raw image/dng image/x-adobe-dng image/x-canon-cr2 image/x-canon-cr3 image/x-nikon-nef image/x-sony-arw image/x-fuji-raf image/x-fujifilm-raf image/x-panasonic-rw2 image/x-olympus-orf image/x-pentax-pef image/x-samsung-srw"
		extensions = "dng cr2 cr3 nef arw raf rw2 orf pef srw"
	case "avif":
		mimes, extensions = "image/avif image/avif-sequence", "avif"
	case "mov":
		mimes, extensions = "video/quicktime", "mov"
	case "mp4":
		mimes, extensions = "video/mp4 application/mp4 video/x-m4v", "mp4 m4v"
	}
	conditions := []string{}
	for _, mime := range strings.Fields(mimes) {
		conditions = append(conditions, "lower(r.mime)='"+mime+"'")
	}
	fallback := []string{}
	for _, extension := range strings.Fields(extensions) {
		fallback = append(fallback, "lower(r.name) LIKE '%."+extension+"'")
	}
	suffixes := "(" + strings.Join(fallback, " OR ") + ")"
	if format != "raw" && format != "heic" {
		suffixes = "(lower(r.mime) IN ('','application/octet-stream') AND " + suffixes + ")"
	}
	return strings.Join(append(conditions, suffixes), " OR ")
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
