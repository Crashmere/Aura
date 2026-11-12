package library

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type playbackSource struct {
	URL   string         `json:"url"`
	Mime  string         `json:"mime"`
	Audio *playbackAudio `json:"audio,omitempty"`
}

type playbackAudio struct {
	Start    float64 `json:"start"`
	Duration float64 `json:"duration,omitempty"`
}

type playbackDescriptor struct {
	Source    *playbackSource `json:"source,omitempty"`
	Stream    playbackSource  `json:"stream"`
	Duration  float64         `json:"duration,omitempty"`
	FrameRate float64         `json:"frameRate,omitempty"`
}

type playbackTimeline string

const playbackShortSegments playbackTimeline = "s2"

func requestPlaybackTimeline(r *http.Request) (playbackTimeline, error) {
	values, ok := r.URL.Query()["timeline"]
	if !ok {
		return "", nil
	}
	if len(values) != 1 || values[0] != string(playbackShortSegments) {
		return "", errPlaybackTime
	}
	return playbackShortSegments, nil
}

func (timeline playbackTimeline) seconds() float64 {
	if timeline == playbackShortSegments {
		return playbackSegmentSeconds
	}
	return 4
}

func (timeline playbackTimeline) segment(duration float64, index int) (start, length float64) {
	if index < 0 {
		return 0, 0
	}
	seconds := timeline.seconds()
	start = float64(index) * seconds
	return start, max(0, min(seconds, duration-start))
}

type playbackSpec struct {
	hash, stamp, path          string
	duration, start, frameRate float64
	width, height              int
	nativeRotation             float64
	hdr                        bool
	hdrPeak                    float64
	transfer                   string
	colorPrimaries, colorSpace string
	sourceMime                 string
	sourceAudio                *playbackAudio
}

func (l *Library) playbackOriginal(hash string) (File, os.FileInfo, error) {
	if err := originalDeletion(l.DB, hash, ""); err != nil {
		return File{}, nil, err
	}
	f, err := l.File(hash)
	if err != nil {
		return File{}, nil, err
	}
	stat, err := os.Lstat(l.Object(hash))
	if err != nil {
		return File{}, nil, err
	}
	if !stat.Mode().IsRegular() || stat.Size() != f.Size {
		return File{}, nil, fmt.Errorf("%w: original size or type changed", errOriginalIntegrity)
	}
	return f, stat, nil
}

func (p *playbackCache) specification(ctx context.Context, l *Library, f File, stat os.FileInfo) (*playbackSpec, error) {
	key := fmt.Sprintf("probe:%s:%d:%d", f.Hash, stat.Size(), stat.ModTime().UnixNano())
	p.mu.Lock()
	if cached, ok := p.specs[key]; ok {
		cached.used = time.Now()
		p.specs[key] = cached
		p.mu.Unlock()
		return cached.spec, nil
	}
	if job := p.jobs[key]; job != nil {
		if job.waiters == 0 {
			p.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-job.done:
				return p.specification(ctx, l, f, stat)
			}
		}
		job.waiters++
		p.mu.Unlock()
		if err := p.await(ctx, job); err != nil {
			return nil, err
		}
		return job.spec, nil
	}
	jobCtx, job, err := p.newJobLocked(key, f.Hash, 2<<20, 20*time.Second)
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	go func() {
		spec, err := l.probePlayback(jobCtx, f.Hash, key)
		p.finishJob(jobCtx, key, job, nil, spec, err)
	}()
	if err = p.await(ctx, job); err != nil {
		return nil, err
	}
	return job.spec, nil
}

func (l *Library) probePlayback(ctx context.Context, hash, stamp string) (*playbackSpec, error) {
	f, _, err := l.playbackOriginal(hash)
	if err != nil {
		return nil, err
	}
	release, err := l.acquirePlaybackCPU(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	output := &limitedBuffer{max: 256 << 10}
	err = l.commandOutput(ctx, "ffprobe", output, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration,start_time:stream=codec_type,width,height,duration,start_time,avg_frame_rate,color_transfer,color_primaries,color_space:stream_side_data=rotation", "-of", "json", l.Object(hash))
	if err != nil {
		return nil, err
	}
	var raw struct {
		Streams []struct {
			Type      string `json:"codec_type"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			Duration  string `json:"duration"`
			Start     string `json:"start_time"`
			Rate      string `json:"avg_frame_rate"`
			Transfer  string `json:"color_transfer"`
			Primaries string `json:"color_primaries"`
			Space     string `json:"color_space"`
			SideData  []struct {
				Rotation *float64 `json:"rotation"`
			} `json:"side_data_list"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
			Start    string `json:"start_time"`
		} `json:"format"`
	}
	if err = json.Unmarshal(output.Bytes(), &raw); err != nil {
		return nil, err
	}
	spec := &playbackSpec{hash: hash, stamp: stamp, path: l.Object(hash)}
	video := false
	for _, stream := range raw.Streams {
		if stream.Type == "audio" && spec.sourceAudio == nil {
			start, _ := strconv.ParseFloat(stream.Start, 64)
			if math.IsNaN(start) || math.IsInf(start, 0) {
				start = 0
			}
			spec.sourceAudio = &playbackAudio{Start: start, Duration: playbackNumber(stream.Duration)}
		}
		if stream.Type != "video" || video {
			continue
		}
		video = true
		spec.width, spec.height = stream.Width, stream.Height
		spec.duration = playbackNumber(stream.Duration)
		spec.start, _ = strconv.ParseFloat(stream.Start, 64)
		if stream.Start == "" || stream.Start == "N/A" {
			spec.start, _ = strconv.ParseFloat(raw.Format.Start, 64)
		}
		parts := strings.Split(stream.Rate, "/")
		if len(parts) == 2 {
			denominator := playbackNumber(parts[1])
			if denominator > 0 {
				spec.frameRate = playbackNumber(parts[0]) / denominator
			}
		}
		spec.transfer = stream.Transfer
		spec.colorPrimaries, spec.colorSpace = stream.Primaries, stream.Space
		spec.hdr = stream.Transfer == "smpte2084" || stream.Transfer == "arib-std-b67"
		for _, data := range stream.SideData {
			if data.Rotation != nil {
				spec.nativeRotation = *data.Rotation
			}
		}
	}
	if spec.duration <= 0 {
		spec.duration = playbackNumber(raw.Format.Duration)
	}
	if !video || spec.width <= 0 || spec.height <= 0 || spec.duration <= 0 || math.IsNaN(spec.start) || math.IsInf(spec.start, 0) {
		return nil, errPlaybackTime
	}
	// Native playback exposes the original PTS, while frame APIs use time from the first frame.
	if math.Abs(spec.start) <= 0.001 {
		spec.sourceMime = playbackSourceMime(f.Mime)
	}
	if spec.sourceAudio != nil {
		spec.sourceAudio.Start -= spec.start
	}
	if spec.hdr {
		spec.hdrPeak = l.probePlaybackHDRPeak(ctx, spec.path, spec.transfer)
	}
	if err = originalDeletion(l.DB, hash, ""); err != nil {
		return nil, err
	}
	return spec, nil
}

func playbackSourceMime(mime string) string {
	if !strings.HasPrefix(mime, "video/") {
		return ""
	}
	if mime == "video/quicktime" {
		return "video/mp4"
	}
	return mime
}

func playbackNumber(text string) float64 {
	v, err := strconv.ParseFloat(text, 64)
	if err != nil || v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

func (l *Library) playbackRequest(r *http.Request) (*playbackCache, *playbackSpec, int, error) {
	hash := chi.URLParam(r, "hash")
	if !validHash.MatchString(hash) {
		return nil, nil, 0, sql.ErrNoRows
	}
	f, stat, err := l.playbackOriginal(hash)
	if err != nil {
		return nil, nil, 0, err
	}
	rotation := f.Rotation
	if values, ok := r.URL.Query()["rotation"]; ok {
		if len(values) != 1 {
			return nil, nil, 0, errPlaybackTime
		}
		rotation, err = strconv.Atoi(values[0])
		if err != nil || !validRotation(rotation) {
			return nil, nil, 0, errPlaybackTime
		}
	}
	p, err := l.playbackManager()
	if err != nil {
		return nil, nil, 0, err
	}
	spec, err := p.specification(r.Context(), l, f, stat)
	return p, spec, rotation, err
}

func playbackFailure(w http.ResponseWriter, err error) {
	if deletedFailure(w, err) {
		return
	}
	switch {
	case errors.Is(err, sql.ErrNoRows):
		fail(w, 404, "视频或资源不存在")
	case errors.Is(err, errOriginalIntegrity):
		originalFailure(w, err)
	case os.IsNotExist(err):
		writeJSON(w, 503, map[string]string{"error": "原件暂不可读，请检查存储", "code": "original_missing"})
	case errors.Is(err, errPlaybackTime):
		fail(w, 400, err)
	default:
		writeJSON(w, 503, map[string]string{"error": "视频播放暂不可用，请稍后重试", "code": "playback_unavailable"})
	}
}

func (l *Library) playbackInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	_, spec, rotation, err := l.playbackRequest(r)
	if err != nil {
		playbackFailure(w, err)
		return
	}
	result := playbackDescriptor{Stream: playbackSource{URL: fmt.Sprintf("/aura/media/%s/stream/index.m3u8?rotation=%d&timeline=%s", spec.hash, rotation, playbackShortSegments), Mime: "application/vnd.apple.mpegurl"}, Duration: spec.duration, FrameRate: spec.frameRate}
	if rotation == 0 && spec.sourceMime != "" {
		result.Source = &playbackSource{URL: "/aura/media/" + spec.hash + "/source?rotation=0", Mime: spec.sourceMime, Audio: spec.sourceAudio}
	}
	if err = originalDeletion(l.DB, spec.hash, ""); err != nil {
		playbackFailure(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (l *Library) streamPlaylist(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	_, spec, rotation, err := l.playbackRequest(r)
	timeline, timelineErr := requestPlaybackTimeline(r)
	if err == nil {
		err = timelineErr
	}
	if err != nil {
		playbackFailure(w, err)
		return
	}
	var playlist strings.Builder
	fmt.Fprintf(&playlist, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%.0f\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n", timeline.seconds())
	for index := 0; ; index++ {
		_, duration := timeline.segment(spec.duration, index)
		if duration <= 0 {
			break
		}
		fmt.Fprintf(&playlist, "#EXTINF:%.6f,\n%d.ts?rotation=%d", duration, index, rotation)
		// Keep unversioned URLs on the old four-second timeline for cached playlists.
		if timeline != "" {
			fmt.Fprintf(&playlist, "&timeline=%s", timeline)
		}
		playlist.WriteByte('\n')
	}
	playlist.WriteString("#EXT-X-ENDLIST\n")
	if err = originalDeletion(l.DB, spec.hash, ""); err != nil {
		playbackFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeContent(w, r, "index.m3u8", time.Time{}, strings.NewReader(playlist.String()))
}

func (l *Library) streamSegment(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p, spec, rotation, err := l.playbackRequest(r)
	timeline, timelineErr := requestPlaybackTimeline(r)
	index, parseErr := strconv.Atoi(chi.URLParam(r, "segment"))
	if err == nil {
		_, duration := timeline.segment(spec.duration, index)
		if timelineErr != nil || parseErr != nil || duration <= 0 {
			err = errPlaybackTime
		}
	}
	if err != nil {
		playbackFailure(w, err)
		return
	}
	var entry *playbackEntry
	if r.Method == http.MethodHead {
		p.mu.Lock()
		p.expireLocked(time.Now())
		entry = p.entries[playbackSegmentKey(spec, rotation, index, timeline)]
		if entry != nil {
			entry.refs++
			entry.used = time.Now()
		}
		p.mu.Unlock()
	} else {
		entry, err = p.segment(r.Context(), l, spec, rotation, index, timeline)
	}
	if err != nil {
		playbackFailure(w, err)
		return
	}
	if entry != nil {
		defer p.release(entry)
	}
	if err = originalDeletion(l.DB, spec.hash, ""); err != nil {
		playbackFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "video/mp2t")
	if entry == nil {
		w.WriteHeader(http.StatusOK)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.Header().Set("ETag", entry.etag)
	w.Header().Set("X-Aura-Playback-Engine", entry.engine)
	http.ServeContent(w, r, fmt.Sprintf("%d.ts", index), time.Time{}, bytes.NewReader(entry.data))
}
