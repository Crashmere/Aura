package library

const imageVersionsSQL = `(SELECT count(*) FROM files v WHERE v.asset_id=a.id AND v.mime LIKE 'image/%')`

// Follow the moved originals so later automatic grouping can change the asset ID.
// A split stops counting as manual when the two sides no longer share an item.
const manualGroupingSQL = `EXISTS (
 SELECT 1 FROM decisions d, json_each(d.detail,'$.files') moved
 JOIN files m ON m.hash=moved.value
 WHERE d.action='merge' AND json_extract(d.detail,'$.reason')='user review'
 AND m.asset_id=a.id AND (m.mime LIKE 'image/%' OR m.mime LIKE 'video/%')
 AND EXISTS (SELECT 1 FROM files r WHERE r.asset_id=a.id AND (r.mime LIKE 'image/%' OR r.mime LIKE 'video/%')
 AND NOT EXISTS (SELECT 1 FROM json_each(d.detail,'$.files') dropped WHERE dropped.value=r.hash))
)`

const groupingSQL = `CASE WHEN ` + manualGroupingSQL + ` THEN 'manual'
 WHEN ` + imageVersionsSQL + `>1 THEN 'automatic' ELSE '' END`

func groupingFilterSQL(grouping string) string {
	if grouping == "automatic" {
		return imageVersionsSQL + ">1 AND NOT " + manualGroupingSQL
	}
	return manualGroupingSQL
}
