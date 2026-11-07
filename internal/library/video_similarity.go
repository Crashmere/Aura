package library

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	"log/slog"
	"math"
	"math/bits"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const videoFeatureRecipe = "video-dino-letterbox224-sampling-v1"
const videoFeatureSuffix = "-video-similarity-v1.json"

type videoFeatureFrame struct {
	Time   float64   `json:"time"`
	DHash  uint64    `json:"dhash"`
	Vector []float32 `json:"vector,omitempty"`
}

type videoMatchSample struct {
	Left  float64 `json:"left"`
	Right float64 `json:"right"`
}

type videoFeatureMatch struct {
	Hash     string             `json:"hash"`
	Source   string             `json:"source"`
	Score    float32            `json:"score"`
	Coverage float32            `json:"coverage"`
	Samples  []videoMatchSample `json:"samples"`
}

type videoFeatureRecord struct {
	Recipe     string              `json:"recipe"`
	Hash       string              `json:"hash"`
	Duration   float64             `json:"duration"`
	Ratio      float64             `json:"ratio"`
	Frames     []videoFeatureFrame `json:"frames"`
	Aggregates [][]float32         `json:"aggregates,omitempty"`
	Matches    []videoFeatureMatch `json:"matches"`
	Engine     string              `json:"engine,omitempty"`
	Error      string              `json:"error,omitempty"`
}

func (l *Library) videoSimilarityStatus() dinoStatus {
	l.videoMu.RLock()
	defer l.videoMu.RUnlock()
	status := l.videoStatus
	if status.State == "" {
		status.State = "starting"
	}
	status.BatchSize = 1
	return status
}

func (l *Library) cancelVideoSimilarity(hashes []string) *processingJob {
	l.videoMu.RLock()
	defer l.videoMu.RUnlock()
	for _, hash := range hashes {
		if l.videoHash == hash && l.videoActive != nil {
			l.videoActive.cancel()
			return l.videoActive
		}
	}
	return nil
}

func validVideoRecord(record videoFeatureRecord, hash string) bool {
	if record.Recipe != videoFeatureRecipe || record.Hash != hash || len(record.Frames) > 48 {
		return false
	}
	for _, frame := range record.Frames {
		if math.IsNaN(frame.Time) || math.IsInf(frame.Time, 0) || frame.Time < 0 || len(frame.Vector) != 0 && len(frame.Vector) != 384 {
			return false
		}
		for _, value := range frame.Vector {
			if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
				return false
			}
		}
	}
	return true
}

func (l *Library) reconcileVideoSimilarity(ctx context.Context) error {
	rows, err := l.DB.QueryContext(ctx, `SELECT f.hash FROM assets a JOIN files f ON f.hash=a.primary_hash
 WHERE a.kind='video' AND a.trashed_at='' AND f.mime LIKE 'video/%' AND f.status='ready'
 AND NOT EXISTS(SELECT 1 FROM deletion_hashes p WHERE p.hash=f.hash)`)
	if err != nil {
		return err
	}
	hashes := []string{}
	for rows.Next() {
		var hash string
		if err = rows.Scan(&hash); err != nil {
			break
		}
		hashes = append(hashes, hash)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	l.videoMu.Lock()
	if l.videoRecords == nil {
		l.videoRecords = map[string]videoFeatureRecord{}
	}
	eligible := map[string]bool{}
	pending := []string{}
	ready, failed := 0, 0
	for _, hash := range hashes {
		eligible[hash] = true
		record, exists := l.videoRecords[hash]
		if !exists {
			if data, e := os.ReadFile(l.Derived(hash, videoFeatureSuffix)); e == nil {
				_ = json.Unmarshal(data, &record)
			}
			if validVideoRecord(record, hash) {
				l.videoRecords[hash] = record
			}
		}
		if validVideoRecord(record, hash) && record.Error == "" {
			ready++
		} else {
			pending = append(pending, hash)
			if record.Error != "" {
				failed++
			}
		}
	}
	for hash := range l.videoRecords {
		if !eligible[hash] {
			delete(l.videoRecords, hash)
		}
	}
	l.videoStatus.Total, l.videoStatus.Ready = len(hashes), ready
	l.videoStatus.Pending, l.videoStatus.Errors = len(pending), failed
	l.videoMu.Unlock()
	for _, hash := range pending {
		if _, err = l.DB.ExecContext(ctx, "INSERT OR IGNORE INTO video_tasks VALUES(?,?,'')", hash, now()); err != nil {
			return err
		}
	}
	_, err = l.DB.ExecContext(ctx, `DELETE FROM video_tasks WHERE hash NOT IN (
 SELECT f.hash FROM assets a JOIN files f ON f.hash=a.primary_hash WHERE a.kind='video'
 AND a.trashed_at='' AND f.status='ready' AND NOT EXISTS(SELECT 1 FROM deletion_hashes p WHERE p.hash=f.hash))`)
	return err
}

func videoSampleCount(duration float64) int {
	switch {
	case duration <= 15:
		return 8
	case duration <= 60:
		return 12
	case duration <= 600:
		return 24
	default:
		return 48
	}
}

var videoSampleTime = regexp.MustCompile(`\bpts_time:([0-9.eE+\-]+)`)

// Area averaging avoids the point-sampling aliasing of a thumbnail dHash when
// the same footage arrives at another resolution. Photo fingerprints stay unchanged.
func videoPerceptual(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	im, _, err := image.Decode(file)
	if err != nil {
		return ""
	}
	b := im.Bounds()
	if b.Dx() < 9 || b.Dy() < 8 {
		return ""
	}
	var cells [8][9]uint64
	low, high := uint64(65535), uint64(0)
	for y := 0; y < 8; y++ {
		for x := 0; x < 9; x++ {
			x0, x1 := b.Min.X+x*b.Dx()/9, b.Min.X+(x+1)*b.Dx()/9
			y0, y1 := b.Min.Y+y*b.Dy()/8, b.Min.Y+(y+1)*b.Dy()/8
			var sum uint64
			for py := y0; py < y1; py++ {
				for px := x0; px < x1; px++ {
					r, g, blue, _ := im.At(px, py).RGBA()
					sum += (uint64(r)*299 + uint64(g)*587 + uint64(blue)*114) / 1000
				}
			}
			cells[y][x] = sum / uint64((x1-x0)*(y1-y0))
			low, high = min(low, cells[y][x]), max(high, cells[y][x])
		}
	}
	if high-low < 3000 {
		return ""
	}
	var hash uint64
	for _, row := range cells {
		for x := 0; x < 8; x++ {
			hash <<= 1
			if row[x] > row[x+1] {
				hash |= 1
			}
		}
	}
	return fmt.Sprintf("%016x", hash)
}

// A single decoder samples the complete timeline; showinfo retains actual frame
// timestamps, rather than the rounded timestamps of an fps conversion.
func (l *Library) extractVideoFrames(ctx context.Context, hash, work string) (videoFeatureRecord, []string, error) {
	record := videoFeatureRecord{Recipe: videoFeatureRecipe, Hash: hash, Matches: []videoFeatureMatch{}}
	spec, err := l.probePlayback(ctx, hash, hash)
	if err != nil {
		return record, nil, err
	}
	record.Duration = spec.duration
	width, height := spec.width, spec.height
	if math.Abs(math.Remainder(spec.nativeRotation, 180)) > 1 {
		width, height = height, width
	}
	record.Ratio = float64(width) / float64(height)
	hdr, err := l.videoFrameHDRFilters(ctx, spec.path, 384)
	if err != nil {
		return record, nil, err
	}
	count := videoSampleCount(spec.duration)
	step := spec.duration / float64(count)
	selectFrames := fmt.Sprintf("setpts=PTS-STARTPTS,select='isnan(prev_selected_t)+gte(t-prev_selected_t,%.9f)'", step)
	scale := "scale=w='min(384,iw)':h='min(384,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
	modes := []string{"CPU"}
	if len(hdr) == 0 && l.nvidiaAvailable(ctx) {
		modes = []string{"NVIDIA GPU · 软件解码", "CPU"}
		if math.Abs(math.Remainder(spec.nativeRotation, 360)) < .001 {
			modes = append([]string{"NVIDIA GPU · CUDA 解码"}, modes...)
		}
	}
	var output string
	for _, mode := range modes {
		args := []string{"-nostdin", "-v", "info", "-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "1", "-filter_complex_threads", "1"}
		gpu := mode != "CPU"
		if gpu {
			args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
		}
		if mode == "NVIDIA GPU · CUDA 解码" {
			args = append(args, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda")
		}
		args = append(args, "-i", spec.path, "-map", "0:v:0", "-an")
		filter := selectFrames + "," + scale
		if len(hdr) > 0 {
			filter = selectFrames + "," + strings.Join(hdr, ",")
		} else if gpu {
			filter = selectFrames + ","
			if mode != "NVIDIA GPU · CUDA 解码" {
				filter += "format=nv12,hwupload,"
			}
			filter += strings.Replace(scale, "scale=", "scale_cuda=", 1) + ":format=yuv420p,hwdownload,format=yuv420p"
		}
		args = append(args, "-vf", filter+",showinfo", "-fps_mode", "vfr", "-frames:v", strconv.Itoa(count),
			"-map_metadata", "-1", "-q:v", "3", "-threads", "2", "-y", filepath.Join(work, "frame-%03d.jpg"))
		var release func()
		if gpu {
			release, err = l.acquireGPU(ctx)
		} else {
			release, err = l.acquireCPU(ctx)
		}
		if err != nil {
			return record, nil, err
		}
		logs := &limitedBuffer{max: 256 << 10}
		cmd := mediaCommand(ctx, "ffmpeg", args...)
		cmd.Stderr = logs
		err = cmd.Run()
		release()
		output = logs.String()
		if err == nil {
			record.Engine = mode
			break
		}
		if ctx.Err() != nil {
			return record, nil, ctx.Err()
		}
		slog.Warn("video similarity frame fallback", "hash", hash, "engine", mode, "error", err)
	}
	if err != nil {
		return record, nil, fmt.Errorf("video frame sampling: %w: %s", err, output[max(0, len(output)-2000):])
	}
	times := videoSampleTime.FindAllStringSubmatch(output, -1)
	paths := []string{}
	for index := 0; index < min(count, len(times)); index++ {
		path := filepath.Join(work, fmt.Sprintf("frame-%03d.jpg", index+1))
		value := videoPerceptual(path)
		if value == "" {
			continue
		}
		stamp, _ := strconv.ParseFloat(times[index][1], 64)
		dhash, _ := strconv.ParseUint(value, 16, 64)
		record.Frames = append(record.Frames, videoFeatureFrame{Time: stamp, DHash: dhash})
		paths = append(paths, path)
	}
	return record, paths, nil
}

func (l *Library) inferVideoFrames(ctx context.Context, worker **dinoProcess, record *videoFeatureRecord, paths []string) error {
	for start := 0; start < len(paths); start += dinoBatchSize {
		end := min(len(paths), start+dinoBatchSize)
		batchCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		err := l.inferVideoBatch(batchCtx, worker, record, paths, start, end)
		cancel()
		if err != nil {
			return err
		}
	}
	record.Aggregates = videoAggregates(record.Frames, record.Duration)
	return nil
}

func (l *Library) inferVideoBatch(ctx context.Context, worker **dinoProcess, record *videoFeatureRecord, paths []string, start, end int) error {
	if os.Getenv("AURA_DINO") == "off" {
		return fmt.Errorf("DINO inference is paused")
	}
	var release func()
	var err error
	if os.Getenv("AURA_GPU") != "cpu" {
		release, err = l.acquireGPU(ctx)
	} else {
		release, err = l.acquireCPU(ctx)
	}
	if err != nil {
		return err
	}
	defer release()
	if *worker != nil {
		select {
		case <-(*worker).done:
			*worker = nil
		default:
		}
	}
	if *worker == nil {
		*worker, err = startDINO()
		if err != nil {
			return err
		}
	}
	items := []map[string]string{}
	for i := start; i < end; i++ {
		items = append(items, map[string]string{"hash": strconv.Itoa(i), "path": paths[i]})
	}
	active := *worker
	interrupt := interruptWorker(ctx, active.cmd, active.input)
	defer func() {
		interrupt()
		if ctx.Err() != nil {
			active.stop()
			*worker = nil
		}
	}()
	if err = json.NewEncoder(active.input).Encode(map[string]any{"featuresOnly": true, "items": items}); err != nil {
		active.stop()
		*worker = nil
		return err
	}
	var response dinoResponse
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-active.done:
		return fmt.Errorf("video feature worker stopped: %v", active.err)
	case response = <-active.response:
	}
	if response.Error != "" || len(response.Items) != len(items) {
		return fmt.Errorf("video feature batch: %s", response.Error)
	}
	seen := map[int]bool{}
	for _, item := range response.Items {
		i, err := strconv.Atoi(item.Hash)
		if err != nil || i < start || i >= end || seen[i] || len(item.Vector) != 384 || item.Error != "" {
			return fmt.Errorf("invalid video feature: %s", item.Error)
		}
		for _, value := range item.Vector {
			if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
				return fmt.Errorf("invalid video vector")
			}
		}
		seen[i] = true
		record.Frames[i].Vector = item.Vector
	}
	record.Engine += " · " + response.Engine + " 特征"
	return nil
}

func normalizedVideoVector(vector []float32) []float32 {
	var norm float64
	for _, value := range vector {
		norm += float64(value) * float64(value)
	}
	if norm == 0 {
		return nil
	}
	norm = math.Sqrt(norm)
	for i := range vector {
		vector[i] /= float32(norm)
	}
	return vector
}

func videoAggregates(frames []videoFeatureFrame, duration float64) [][]float32 {
	vectors := make([][]float32, 5)
	for i := range vectors {
		vectors[i] = make([]float32, 384)
	}
	for _, frame := range frames {
		if len(frame.Vector) != 384 || duration <= 0 {
			continue
		}
		bin := min(3, int(frame.Time/duration*4)) + 1
		for i, value := range frame.Vector {
			vectors[0][i] += value
			vectors[bin][i] += value
		}
	}
	for i := range vectors {
		vectors[i] = normalizedVideoVector(vectors[i])
	}
	return vectors
}

func videoCosine(left, right []float32) float32 {
	if len(left) != 384 || len(right) != 384 {
		return 0
	}
	var score float32
	for i, value := range left {
		score += value * right[i]
	}
	return min(1, max(-1, score))
}

func videoCoarseScore(left, right videoFeatureRecord) float32 {
	var score float32
	for _, a := range left.Aggregates {
		for _, b := range right.Aggregates {
			score = max(score, videoCosine(a, b))
		}
	}
	return score
}

func videoFrameEvidence(left, right videoFeatureRecord, temporal bool) (float32, float32, []videoMatchSample) {
	if len(left.Frames) < 3 || len(right.Frames) < 3 || left.Duration <= 0 || right.Duration <= 0 {
		return 0, 0, nil
	}
	type evidence struct {
		score  float32
		sample videoMatchSample
	}
	all := []evidence{}
	directed := func(a, b videoFeatureRecord, reverse bool) (float32, float32) {
		var sum float32
		matched := 0
		last := -1
		for _, frame := range a.Frames {
			best, position := float32(0), -1
			for j, target := range b.Frames {
				if temporal && (j < last || math.Abs(frame.Time/a.Duration-target.Time/b.Duration) > .16) {
					continue
				}
				var score float32
				if temporal {
					distance := bits.OnesCount64(frame.DHash ^ target.DHash)
					score = 1 - float32(distance)/64
				} else {
					score = videoCosine(frame.Vector, target.Vector)
				}
				closer := temporal && position >= 0 &&
					math.Abs(frame.Time/a.Duration-target.Time/b.Duration) <
						math.Abs(frame.Time/a.Duration-b.Frames[position].Time/b.Duration)
				if score > best || score == best && closer {
					best, position = score, j
				}
			}
			sum += best
			threshold := float32(.80)
			if temporal {
				threshold = .875 // At most eight differing dHash bits.
			}
			if position >= 0 && best >= threshold {
				matched++
				if temporal {
					last = position
				}
				if !reverse {
					all = append(all, evidence{best, videoMatchSample{frame.Time, b.Frames[position].Time}})
				}
			}
		}
		return sum / float32(len(a.Frames)), float32(matched) / float32(len(a.Frames))
	}
	leftScore, leftCoverage := directed(left, right, false)
	rightScore, rightCoverage := directed(right, left, true)
	sort.SliceStable(all, func(i, j int) bool { return all[i].score > all[j].score })
	samples := []videoMatchSample{}
	for _, item := range all {
		distinct := true
		for _, previous := range samples {
			distinct = distinct && math.Abs(previous.Left-item.sample.Left) >= left.Duration*.15
		}
		if distinct {
			samples = append(samples, item.sample)
		}
		if len(samples) == 3 {
			break
		}
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i].Left < samples[j].Left })
	return min(leftScore, rightScore), min(leftCoverage, rightCoverage), samples
}

func videoNearEligible(left, right videoFeatureRecord) bool {
	if math.Abs(left.Duration-right.Duration) > max(.5, max(left.Duration, right.Duration)*.03) ||
		left.Ratio <= 0 || right.Ratio <= 0 || math.Abs(math.Log(left.Ratio/right.Ratio)) > .05 {
		return false
	}
	for _, record := range []videoFeatureRecord{left, right} {
		if len(record.Frames) < 3 || record.Frames[len(record.Frames)-1].Time-record.Frames[0].Time < record.Duration*.65 {
			return false
		}
	}
	// Requiring variation rejects matching static slates and shared title screens.
	var varied bool
	for _, frame := range left.Frames {
		if len(left.Frames) > 0 && frame.DHash != left.Frames[0].DHash {
			varied = true
			break
		}
	}
	return varied
}

func (l *Library) findVideoMatches(record videoFeatureRecord) []videoFeatureMatch {
	l.videoMu.RLock()
	records := make([]videoFeatureRecord, 0, len(l.videoRecords))
	for hash, target := range l.videoRecords {
		if hash != record.Hash {
			records = append(records, target)
		}
	}
	l.videoMu.RUnlock()
	type candidate struct {
		record videoFeatureRecord
		score  float32
	}
	coarse := []candidate{}
	out := []videoFeatureMatch{}
	near := map[string]bool{}
	for _, target := range records {
		if videoNearEligible(record, target) {
			score, coverage, samples := videoFrameEvidence(record, target, true)
			if coverage >= .8 && score >= .90 && len(samples) >= 2 {
				near[target.Hash] = true
				out = append(out, videoFeatureMatch{target.Hash, "dhash", score, coverage, samples})
			}
		}
		if !near[target.Hash] {
			score := videoCoarseScore(record, target)
			if score >= .75 {
				coarse = append(coarse, candidate{target, score})
			}
		}
	}
	sort.Slice(coarse, func(i, j int) bool {
		if coarse[i].score != coarse[j].score {
			return coarse[i].score > coarse[j].score
		}
		return coarse[i].record.Hash < coarse[j].record.Hash
	})
	for _, candidate := range coarse[:min(60, len(coarse))] {
		score, coverage, samples := videoFrameEvidence(record, candidate.record, false)
		rightStart, rightEnd := candidate.record.Duration, float64(0)
		for _, sample := range samples {
			rightStart, rightEnd = min(rightStart, sample.Right), max(rightEnd, sample.Right)
		}
		if score >= .80 && coverage >= .5 && len(samples) >= 2 &&
			samples[len(samples)-1].Left-samples[0].Left >= record.Duration*.3 &&
			rightEnd-rightStart >= candidate.record.Duration*.3 {
			out = append(out, videoFeatureMatch{candidate.record.Hash, "dino", score, coverage, samples})
		}
	}
	return out
}

func (l *Library) persistVideoRecord(ctx context.Context, record videoFeatureRecord) error {
	unlock := l.lockUpload(record.Hash)
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := originalDeletion(l.DB, record.Hash, ""); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Join(l.Root, "derived"), record.Hash+videoFeatureSuffix+".part-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	err = json.NewEncoder(file).Encode(record)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(file.Name(), l.Derived(record.Hash, videoFeatureSuffix))
	}
	if err == nil {
		err = syncDirectory(filepath.Join(l.Root, "derived"))
	}
	if err != nil {
		return err
	}
	l.videoMu.Lock()
	l.videoRecords[record.Hash] = record
	l.videoStatus.Engine = record.Engine
	l.videoMu.Unlock()
	if record.Error == "" {
		_, err = l.DB.ExecContext(ctx, "DELETE FROM video_tasks WHERE hash=?", record.Hash)
	} else {
		_, err = l.DB.ExecContext(ctx, "UPDATE video_tasks SET retry_at=? WHERE hash=?", time.Now().Add(5*time.Minute).Format(time.RFC3339Nano), record.Hash)
	}
	if err == nil {
		_, err = l.DB.ExecContext(ctx, "UPDATE catalog_versions SET value=value+1 WHERE name='review'")
	}
	return err
}

func (l *Library) analyzeVideo(ctx context.Context, hash string, worker **dinoProcess) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	job := &processingJob{cancel: cancel, done: make(chan struct{})}
	l.videoMu.Lock()
	l.videoActive, l.videoHash, l.videoStatus.State = job, hash, "processing"
	l.videoMu.Unlock()
	defer func() {
		cancel()
		l.videoMu.Lock()
		l.videoActive, l.videoHash = nil, ""
		close(job.done)
		l.videoMu.Unlock()
	}()
	if err := originalDeletion(l.DB, hash, ""); err != nil {
		return err
	}
	work, err := os.MkdirTemp(filepath.Join(l.Root, "work"), hash+"-video-similarity-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	record, paths, err := l.extractVideoFrames(ctx, hash, work)
	if err == nil && len(paths) >= 3 {
		err = l.inferVideoFrames(ctx, worker, &record, paths)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		record.Error = err.Error()
	}
	record.Matches = l.findVideoMatches(record)
	return l.persistVideoRecord(ctx, record)
}

func (l *Library) videoSimilarityLoop(ctx context.Context) {
	var worker *dinoProcess
	defer func() {
		if worker != nil {
			worker.stop()
		}
	}()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	var revision int64 = -1
	var reconciled time.Time
	for ctx.Err() == nil {
		current, err := l.revision(ctx, "library")
		if err == nil && (revision != current || time.Since(reconciled) >= 5*time.Minute) {
			err = l.reconcileVideoSimilarity(ctx)
			if err == nil {
				revision, reconciled = current, time.Now()
			}
		}
		var hash string
		if err == nil {
			err = l.DB.QueryRowContext(ctx, "SELECT hash FROM video_tasks WHERE retry_at<=? ORDER BY queued_at,hash LIMIT 1", now()).Scan(&hash)
		}
		if hash != "" && err == nil {
			err = l.analyzeVideo(ctx, hash, &worker)
			if err != nil && ctx.Err() == nil {
				slog.Warn("video similarity analysis", "hash", hash, "error", err)
				_, _ = l.DB.ExecContext(ctx, "UPDATE video_tasks SET retry_at=? WHERE hash=?", time.Now().Add(time.Minute).Format(time.RFC3339Nano), hash)
			}
			revision = -1
			continue
		}
		l.videoMu.Lock()
		l.videoStatus.State = "idle"
		if l.videoStatus.Pending > 0 {
			l.videoStatus.State = "waiting"
		}
		l.videoMu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-l.videoWake:
		case <-ticker.C:
		}
	}
}
