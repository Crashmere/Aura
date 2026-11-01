package library

import (
	"bytes"
	"compress/flate"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"io"
	"os"
	"strings"
)

type EditRecord struct {
	Hash        string           `json:"hash"`
	SourceKey   string           `json:"sourceKey,omitempty"`
	Editor      string           `json:"editor,omitempty"`
	Format      string           `json:"format,omitempty"`
	Version     string           `json:"version,omitempty"`
	Timestamp   string           `json:"timestamp,omitempty"`
	State       string           `json:"state"`
	Metadata    map[string]any   `json:"metadata,omitempty"`
	Adjustments []map[string]any `json:"adjustments"`
}

// Apple stores the complete adjustment array as raw DEFLATE JSON in an XML plist.
// Read the immutable record: flattened ExifTool metadata can omit repeated edits.
func (l *Library) editRecord(f File) EditRecord {
	r := EditRecord{Hash: f.Hash, SourceKey: f.Hints.SourceKey, State: "unsupported", Adjustments: []map[string]any{}}
	var stored map[string]any
	_ = json.Unmarshal(f.Metadata, &stored)
	r.Editor, r.Format, r.Version, r.Timestamp = tag(stored, "AdjustmentEditorBundleID"), tag(stored, "AdjustmentFormatIdentifier"), tag(stored, "AdjustmentFormatVersion"), tag(stored, "AdjustmentTimestamp")
	file, err := os.Open(l.Object(f.Hash))
	if err != nil {
		r.State = "unavailable"
		return r
	}
	defer file.Close()
	decoder := xml.NewDecoder(io.LimitReader(file, 4<<20))
	values := map[string]string{}
	var key string
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return r
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		switch start.Name.Local {
		case "key":
			if err := decoder.DecodeElement(&key, &start); err != nil {
				return r
			}
		case "string", "data", "date", "integer", "real":
			var value string
			if err := decoder.DecodeElement(&value, &start); err != nil {
				return r
			}
			if key != "" {
				values[key] = value
				key = ""
			}
		}
	}
	if v := values["adjustmentEditorBundleID"]; v != "" {
		r.Editor = v
	}
	if v := values["adjustmentFormatIdentifier"]; v != "" {
		r.Format = v
	}
	if v := values["adjustmentFormatVersion"]; v != "" {
		r.Version = v
	}
	if v := values["adjustmentTimestamp"]; v != "" {
		r.Timestamp = v
	}
	encoded := strings.Join(strings.Fields(values["adjustmentData"]), "")
	payload, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(payload) == 0 || bytes.HasPrefix(payload, []byte("bplist")) {
		return r
	}
	if !json.Valid(payload) {
		stream := flate.NewReader(bytes.NewReader(payload))
		defer stream.Close()
		payload, err = io.ReadAll(io.LimitReader(stream, (4<<20)+1))
		if err != nil || len(payload) > 4<<20 {
			return r
		}
	}
	var document struct {
		Metadata    map[string]any   `json:"metadata"`
		Adjustments []map[string]any `json:"adjustments"`
	}
	if err = json.Unmarshal(payload, &document); err != nil || document.Adjustments == nil {
		return r
	}
	r.State, r.Metadata, r.Adjustments = "parsed", document.Metadata, document.Adjustments
	return r
}

func (l *Library) editRecords(files []File) []EditRecord {
	out := []EditRecord{}
	for _, f := range files {
		if f.Hints.ResourceType == "adjustmentData" {
			out = append(out, l.editRecord(f))
		}
	}
	return out
}
