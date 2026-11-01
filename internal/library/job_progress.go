package library

import (
	"encoding/json"
	"log/slog"
	"strings"
	"time"
)

type jobStep struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	Status     string  `json:"status"`
	StartedAt  string  `json:"startedAt,omitempty"`
	FinishedAt string  `json:"finishedAt,omitempty"`
	Percent    float64 `json:"percent,omitempty"`
	Engine     string  `json:"engine,omitempty"`
	Error      string  `json:"error,omitempty"`
}

type jobProgress struct {
	StartedAt  string    `json:"startedAt,omitempty"`
	FinishedAt string    `json:"finishedAt,omitempty"`
	Steps      []jobStep `json:"steps"`
}

type jobTracker struct {
	library *Library
	hash    string
	jobProgress
	lastSave time.Time
}

func processingSteps(mime string) []jobStep {
	steps := []jobStep{{ID: "metadata", Label: "读取元数据", Status: "queued"}}
	if strings.HasPrefix(mime, "image/") {
		steps = append(steps, jobStep{ID: "decode", Label: "解码与校正方向", Status: "queued"}, jobStep{ID: "preview", Label: "生成高清预览", Status: "queued"}, jobStep{ID: "thumbnail", Label: "生成缩略图", Status: "queued"}, jobStep{ID: "fingerprint", Label: "计算图像指纹", Status: "queued"})
	} else if strings.HasPrefix(mime, "video/") {
		steps = append(steps, jobStep{ID: "thumbnail", Label: "生成视频封面", Status: "queued"}, jobStep{ID: "playback", Label: "生成播放版本", Status: "queued"})
	}
	return append(steps, jobStep{ID: "catalog", Label: "归并与更新照片库", Status: "queued"})
}

func (p *jobTracker) save() {
	_, err := p.library.DB.Exec(`INSERT INTO decisions(id,action,detail,created_at) VALUES(?,'media-job',?,?)
 ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,created_at=excluded.created_at`, "media-job:"+p.hash, marshal(p.jobProgress), now())
	if err != nil {
		slog.Error("save media progress", "hash", p.hash, "error", err)
	}
	p.lastSave = time.Now()
}

func (p *jobTracker) configure(mime string) {
	steps := processingSteps(mime)
	for i := range steps {
		for _, old := range p.Steps {
			if old.ID == steps[i].ID {
				steps[i] = old
			}
		}
	}
	p.Steps = steps
	p.save()
}

func (p *jobTracker) step(id, status string, err error) {
	for i := range p.Steps {
		s := &p.Steps[i]
		if s.ID != id {
			continue
		}
		s.Status = status
		if status == "processing" {
			s.StartedAt = now()
		} else {
			s.FinishedAt = now()
		}
		if err != nil {
			s.Error = err.Error()
		}
		p.save()
		return
	}
}

func (p *jobTracker) result(id string, err error) {
	status := "ready"
	if err != nil {
		status = "error"
	}
	p.step(id, status, err)
}

func (p *jobTracker) encoding(id, engine string, percent float64) {
	for i := range p.Steps {
		s := &p.Steps[i]
		if s.ID == id {
			changed := s.Engine != engine
			s.Engine, s.Percent = engine, percent
			if changed || time.Since(p.lastSave) >= time.Second {
				p.save()
			}
			return
		}
	}
}

func (p *jobTracker) finish(err error) {
	p.FinishedAt = now()
	for i := range p.Steps {
		s := &p.Steps[i]
		if s.Status == "processing" {
			s.Status = "error"
			s.FinishedAt = p.FinishedAt
			if err != nil {
				s.Error = err.Error()
			}
		}
	}
	p.save()
}

func progressFromJSON(raw string) *jobProgress {
	var p jobProgress
	if json.Unmarshal([]byte(raw), &p) != nil || len(p.Steps) == 0 {
		return nil
	}
	return &p
}
