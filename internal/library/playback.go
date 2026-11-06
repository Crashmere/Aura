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
	URL    string `json:"url"`
	Mime   string `json:"mime"`
	Codecs string `json:"codecs,omitempty"`
}

type playbackDescriptor struct {
	Source    *playbackSource `json:"source,omitempty"`
	Stream    playbackSource  `json:"stream"`
	Duration  float64         `json:"duration,omitempty"`
	FrameRate float64         `json:"frameRate,omitempty"`
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
	sourceCodecs               string
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
	if _, _, err := l.playbackOriginal(hash); err != nil {
		return nil, err
	}
	release, err := l.acquirePlaybackCPU(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	output := &limitedBuffer{max: 256 << 10}
	err = l.commandOutput(ctx, "ffprobe", output, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=format_name,duration,start_time:stream=codec_type,codec_name,codec_tag_string,profile,width,height,pix_fmt,duration,start_time,avg_frame_rate,color_transfer,color_primaries,color_space:stream_side_data=rotation", "-of", "json", l.Object(hash))
	if err != nil {
		return nil, err
	}
	var raw struct {
		Streams []struct {
			Type      string `json:"codec_type"`
			Codec     string `json:"codec_name"`
			Tag       string `json:"codec_tag_string"`
			Profile   string `json:"profile"`
			Pixels    string `json:"pix_fmt"`
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
			Name     string `json:"format_name"`
			Duration string `json:"duration"`
			Start    string `json:"start_time"`
		} `json:"format"`
	}
	if err = json.Unmarshal(output.Bytes(), &raw); err != nil {
		return nil, err
	}
	spec := &playbackSpec{hash: hash, stamp: stamp, path: l.Object(hash)}
	video, audio, audioCompatible, audioAAC := false, false, true, false
	for _, stream := range raw.Streams {
		if stream.Type == "audio" && !audio {
			audioAAC = stream.Codec == "aac" && stream.Profile == "LC"
			// PCM16 QuickTime Live Photos can play without converting the video.
			audio, audioCompatible = true, audioAAC || stream.Codec == "pcm_s16le"
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
		if stream.Codec == "h264" && (stream.Tag == "avc1" || stream.Tag == "avc3") && (stream.Profile == "Constrained Baseline" || stream.Profile == "Baseline" || stream.Profile == "Main" || stream.Profile == "High") && (stream.Pixels == "yuv420p" || stream.Pixels == "yuvj420p") {
			spec.sourceCodecs = stream.Tag
		}
		if stream.Codec == "hevc" && (stream.Tag == "hvc1" || stream.Tag == "hev1") && (stream.Profile == "Main" || stream.Profile == "Main 10") {
			spec.sourceCodecs = stream.Tag
		}
	}
	if spec.duration <= 0 {
		spec.duration = playbackNumber(raw.Format.Duration)
	}
	if !video || spec.width <= 0 || spec.height <= 0 || spec.duration <= 0 || math.IsNaN(spec.start) || math.IsInf(spec.start, 0) {
		return nil, errPlaybackTime
	}
	container := strings.Split(raw.Format.Name, ",")
	iso := false
	for _, name := range container {
		iso = iso || name == "mov" || name == "mp4"
	}
	// Native playback exposes the original PTS, while frame APIs use time from the first frame.
	if !iso || !audioCompatible || math.Abs(spec.start) > 0.001 {
		spec.sourceCodecs = ""
	} else if audioAAC && spec.sourceCodecs != "" {
		spec.sourceCodecs += ", mp4a.40.2"
	}
	if spec.hdr {
		spec.hdrPeak = l.probePlaybackHDRPeak(ctx, spec.path, spec.transfer)
	}
	if err = originalDeletion(l.DB, hash, ""); err != nil {
		return nil, err
	}
	return spec, nil
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
	result := playbackDescriptor{Stream: playbackSource{URL: fmt.Sprintf("/aura/media/%s/stream/index.m3u8?rotation=%d", spec.hash, rotation), Mime: "application/vnd.apple.mpegurl"}, Duration: spec.duration, FrameRate: spec.frameRate}
	if rotation == 0 && spec.sourceCodecs != "" {
		result.Source = &playbackSource{URL: "/aura/media/" + spec.hash + "/source?rotation=0", Mime: "video/mp4", Codecs: spec.sourceCodecs}
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
	if err != nil {
		playbackFailure(w, err)
		return
	}
	var playlist strings.Builder
	playlist.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n")
	for index, count := 0, int(math.Ceil(spec.duration/playbackSegmentSeconds)); index < count; index++ {
		duration := min(playbackSegmentSeconds, spec.duration-float64(index)*playbackSegmentSeconds)
		fmt.Fprintf(&playlist, "#EXTINF:%.6f,\n%d.ts?rotation=%d\n", duration, index, rotation)
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
	index, parseErr := strconv.Atoi(chi.URLParam(r, "segment"))
	if err == nil && (parseErr != nil || index < 0 || float64(index)*playbackSegmentSeconds >= spec.duration) {
		err = errPlaybackTime
	}
	if err != nil {
		playbackFailure(w, err)
		return
	}
	var entry *playbackEntry
	if r.Method == http.MethodHead {
		p.mu.Lock()
		p.expireLocked(time.Now())
		entry = p.entries[playbackSegmentKey(spec, rotation, index)]
		if entry != nil {
			entry.refs++
			entry.used = time.Now()
		}
		p.mu.Unlock()
	} else {
		entry, err = p.segment(r.Context(), l, spec, rotation, index)
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
