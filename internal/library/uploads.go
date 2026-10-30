package library

import (
	"database/sql"
	"encoding/json"
	"net/http"
)

type uploadSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Offset    int64  `json:"offset"`
	CreatedAt string `json:"createdAt"`
	State     string `json:"state"`
	Missing   bool   `json:"missing"`
}

func (l *Library) listUploads(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	date, id, ok := pageCursor(w, q.Get("cursor"))
	if !ok {
		return
	}
	limit := pageLimit(q, 50, 240)
	items := []uploadSummary{}
	for len(items) <= limit {
		batch, e := l.uploadBatch(date, id, limit+1)
		if e != nil {
			fail(w, 500, e)
			return
		}
		for _, item := range batch {
			if r.Context().Err() != nil {
				return
			}
			item, incomplete, err := l.pendingUpload(item)
			if err != nil {
				originalFailure(w, err)
				return
			}
			if incomplete {
				items = append(items, item)
				if len(items) > limit {
					break
				}
			}
		}
		if len(batch) < limit+1 || len(items) > limit {
			break
		}
		// Completed repair rows must not hide older pending uploads behind a page limit.
		last := batch[len(batch)-1]
		date, id = last.CreatedAt, last.ID
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		next = last.CreatedAt + "|" + last.ID
	}
	writeJSON(w, 200, map[string]any{"items": items, "next": next})
}

func (l *Library) uploadBatch(date, id string, limit int) ([]uploadSummary, error) {
	where := "WHERE state='uploading'"
	args := []any{}
	if date != "" {
		where += " AND (created_at<? OR (created_at=? AND id<?))"
		args = append(args, date, date, id)
	}
	args = append(args, limit)
	rows, e := l.DB.Query("SELECT id,hints,created_at,state FROM uploads "+where+" ORDER BY created_at DESC,id DESC LIMIT ?", args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []uploadSummary{}
	for rows.Next() {
		var item uploadSummary
		var raw string
		if e = rows.Scan(&item.ID, &raw, &item.CreatedAt, &item.State); e != nil {
			return nil, e
		}
		var hints Hints
		if e = json.Unmarshal([]byte(raw), &hints); e != nil {
			return nil, e
		}
		item.Name, item.Size = hints.Name, hints.Size
		items = append(items, item)
	}
	return items, rows.Err()
}

func (l *Library) pendingUpload(item uploadSummary) (uploadSummary, bool, error) {
	unlock := l.lockUpload(item.ID)
	defer unlock()
	if file, e := l.File(item.ID); e == nil {
		present, err := l.originalPresent(file)
		if err != nil {
			return item, false, err
		}
		if present && file.Size == item.Size {
			return item, false, nil
		}
		item.Missing = !present
	} else if e != sql.ErrNoRows {
		return item, false, e
	}
	offset, e := l.incomingOffset(item.ID)
	item.Offset = offset
	return item, true, e
}
