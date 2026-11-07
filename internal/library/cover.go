package library

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

type CoverSelection struct {
	Motion   string  `json:"motion"`
	Time     float64 `json:"time"`
	Revision string  `json:"revision"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
}

var errCoverConflict = errors.New("封面或实况资源已改变，请刷新后重试")
var errFrameTime = errors.New("请选择视频时长内的有效帧")
var errFramePair = errors.New("请选择该照片准确配对的实况视频")

// A selection follows its owner hash, but a split or deleted motion cannot supply
// a frame to an unrelated item. The decision remains available if the pair rejoins.
func coverSQL(hash string) string {
	return `COALESCE((SELECT json_extract(d.detail,'$.cover') FROM decisions d
 WHERE d.id='cover:'||` + hash + ` AND d.action='cover'
 AND EXISTS(SELECT 1 FROM files m WHERE m.hash=json_extract(d.detail,'$.cover.motion')
 AND m.asset_id=(SELECT o.asset_id FROM files o WHERE o.hash=` + hash + `)
 AND NOT EXISTS(SELECT 1 FROM deletion_hashes p WHERE p.hash=m.hash))),'null')`
}

func coverRevision(file File) string {
	if file.Cover != nil {
		return file.Cover.Revision
	}
	return ""
}

func frameTargets(files []File, hash, motion string) ([]File, error) {
	targets := rotationTargets(files, hash)
	if len(targets) == 0 {
		return nil, sql.ErrNoRows
	}
	if strings.HasPrefix(targets[0].Mime, "video/") {
		if motion != hash {
			return nil, errFramePair
		}
		return targets, nil
	}
	if len(targets) != 2 || targets[1].Hash != motion {
		return nil, errFramePair
	}
	return targets, nil
}

func (l *Library) lockFrameTargets(targets []File) func() {
	hashes := []string{}
	for _, file := range targets {
		hashes = append(hashes, file.Hash)
	}
	sort.Strings(hashes)
	unlocks := []func(){}
	for _, hash := range hashes {
		unlocks = append(unlocks, l.lockUpload(hash))
	}
	return func() {
		for i := len(unlocks) - 1; i >= 0; i-- {
			unlocks[i]()
		}
	}
}

// Register against both originals so confirmed cleanup cancels and drains frame
// extraction before acquiring their locks, just as it does ordinary media jobs.
func (l *Library) beginFrameWork(parent context.Context, targets []File) (context.Context, func(), error) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	l.processingMu.Lock()
	defer l.processingMu.Unlock()
	if l.processing == nil {
		l.processing = map[string]*processingJob{}
	}
	for _, file := range targets {
		if l.processing[file.Hash] != nil {
			cancel()
			return nil, nil, errRotationNotReady
		}
	}
	job := &processingJob{cancel: cancel, done: make(chan struct{})}
	for _, file := range targets {
		l.processing[file.Hash] = job
	}
	return ctx, func() {
		cancel()
		l.processingMu.Lock()
		for _, file := range targets {
			delete(l.processing, file.Hash)
		}
		close(job.done)
		l.processingMu.Unlock()
	}, nil
}

func frameFailure(w http.ResponseWriter, err error) {
	var pending *pendingDeletion
	switch {
	case errors.As(err, &pending):
		assetDeletionFailure(w, pending.request)
	case deletedFailure(w, err):
	case errors.Is(err, sql.ErrNoRows):
		fail(w, 404, "照片或资源不存在")
	case errors.Is(err, errCoverConflict), errors.Is(err, errRotationConflict):
		writeJSON(w, 409, map[string]string{"error": err.Error(), "code": "cover_changed"})
	case errors.Is(err, errRotationNotReady):
		fail(w, 409, "预览尚未就绪，请处理完成后再选帧")
	case errors.Is(err, errFrameTime), errors.Is(err, errFramePair):
		fail(w, 400, err)
	default:
		fail(w, 500, err)
	}
}

func (l *Library) saveCover(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Hash          string          `json:"hash"`
		Motion        string          `json:"motion"`
		Time          json.RawMessage `json:"time"`
		ExpectedCover *string         `json:"expectedCover"`
	}
	if !decode(w, r, &p) {
		return
	}
	id := chi.URLParam(r, "id")
	var at *float64
	if !validID.MatchString(id) || !validHash.MatchString(p.Hash) || len(p.Time) == 0 || json.Unmarshal(p.Time, &at) != nil || p.ExpectedCover == nil || *p.ExpectedCover != "" && !validID.MatchString(*p.ExpectedCover) || at != nil && (!validHash.MatchString(p.Motion) || math.IsNaN(*at) || math.IsInf(*at, 0) || *at < 0) {
		fail(w, 400, "请选择有效视频帧并提供当前封面版本")
		return
	}
	if err := l.setCover(r.Context(), id, p.Hash, p.Motion, at, *p.ExpectedCover); err != nil {
		frameFailure(w, err)
		return
	}
	l.detail(w, r)
}

func (l *Library) setCover(parent context.Context, id, hash, motion string, at *float64, expected string) error {
	files, err := l.Files(id)
	if err != nil {
		return err
	}
	targets, err := frameTargets(files, hash, motion)
	if at == nil {
		targets = rotationTargets(files, hash)
		if len(targets) == 0 {
			return sql.ErrNoRows
		}
	} else if err != nil {
		return err
	}
	unlock := l.lockFrameTargets(targets)
	defer unlock()
	files, err = l.Files(id)
	if err != nil {
		return err
	}
	current := rotationTargets(files, hash)
	if at != nil {
		current, err = frameTargets(files, hash, motion)
		if err != nil {
			return errCoverConflict
		}
	}
	if err = checkRotationTargets(l.DB, id, targets, current); err != nil {
		return err
	}
	if coverRevision(current[0]) != expected {
		return errCoverConflict
	}
	if at == nil && current[0].Cover == nil {
		return nil
	}
	ctx, finish, err := l.beginFrameWork(parent, current)
	if err != nil {
		return err
	}
	defer finish()
	var selection *CoverSelection
	committed := false
	defer func() {
		if !committed && selection != nil {
			if err := l.removeCoverRevision(hash, selection.Revision); err != nil {
				slog.Warn("remove uncommitted cover derivatives", "hash", hash, "error", err)
			}
		}
	}()
	if at != nil {
		video := current[len(current)-1]
		probe, err := l.probeFrameVideo(ctx, video.Hash)
		if err != nil {
			return err
		}
		if *at >= probe.Duration {
			return errFrameTime
		}
		frameTime, err := l.containingFrame(ctx, motion, *at, probe)
		if err != nil {
			return err
		}
		selection = &CoverSelection{Motion: motion, Time: frameTime, Revision: ID(), Width: probe.Width, Height: probe.Height}
		selected := current[0]
		selected.Cover = selection
		if err = l.generateCover(ctx, selected); err != nil {
			return err
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	tx, err := l.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	files, err = filesForAsset(tx, id)
	if err != nil {
		return err
	}
	latest := rotationTargets(files, hash)
	if at != nil {
		latest, err = frameTargets(files, hash, motion)
		if err != nil {
			return errCoverConflict
		}
	}
	if err = checkRotationTargets(tx, id, current, latest); err != nil {
		return err
	}
	if coverRevision(latest[0]) != expected {
		return errCoverConflict
	}
	if _, err = tx.Exec(`INSERT INTO decisions(id,action,detail,created_at) VALUES(?,'cover',?,?)
 ON CONFLICT(id) DO UPDATE SET detail=excluded.detail,created_at=excluded.created_at`, "cover:"+hash, marshal(map[string]any{"hash": hash, "cover": selection}), now()); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	committed = true
	if expected != "" {
		if err = l.removeCoverRevision(hash, expected); err != nil {
			slog.Warn("remove replaced cover derivatives", "hash", hash, "error", err)
		}
	}
	return nil
}

type frameVideo struct {
	Width, Height int
	Duration      float64
	Start         float64
	TimeBase      float64
}

func (l *Library) probeFrameVideo(ctx context.Context, hash string) (frameVideo, error) {
	var result frameVideo
	raw, err := l.command(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration,time_base:stream_side_data=rotation:format=duration,start_time", "-of", "json", l.Object(hash))
	if err != nil {
		return result, err
	}
	var probe struct {
		Streams []struct {
			Width    int    `json:"width"`
			Height   int    `json:"height"`
			Duration string `json:"duration"`
			TimeBase string `json:"time_base"`
			SideData []struct {
				Rotation float64 `json:"rotation"`
			} `json:"side_data_list"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
			Start    string `json:"start_time"`
		} `json:"format"`
	}
	if err = json.Unmarshal(raw, &probe); err != nil {
		return result, err
	}
	if len(probe.Streams) != 1 {
		return result, errFrameTime
	}
	stream := probe.Streams[0]
	result.Width, result.Height = stream.Width, stream.Height
	result.Duration, _ = strconv.ParseFloat(stream.Duration, 64)
	result.Start, _ = strconv.ParseFloat(probe.Format.Start, 64)
	numerator, denominator, ok := strings.Cut(stream.TimeBase, "/")
	n, _ := strconv.ParseFloat(numerator, 64)
	d, _ := strconv.ParseFloat(denominator, 64)
	if ok && n > 0 && d > 0 {
		result.TimeBase = n / d
	}
	if result.Duration <= 0 || math.IsNaN(result.Duration) || math.IsInf(result.Duration, 0) {
		result.Duration, _ = strconv.ParseFloat(probe.Format.Duration, 64)
	}
	if result.Width <= 0 || result.Height <= 0 || result.Duration <= 0 || math.IsNaN(result.Duration) || math.IsInf(result.Duration, 0) || result.TimeBase <= 0 || math.IsInf(result.TimeBase, 0) || math.IsNaN(result.Start) || math.IsInf(result.Start, 0) {
		return result, errFrameTime
	}
	for _, data := range stream.SideData {
		if int(math.Round(math.Abs(data.Rotation)))%180 == 90 {
			result.Width, result.Height = result.Height, result.Width
			break
		}
	}
	return result, nil
}

// Input -ss alone rounds an interior time forward to the next decoded frame.
// Resolve the containing frame from original PTS, decoding only the preceding
// keyframe interval and its reorder tail. Integer PTS also preserves VFR timing.
func (l *Library) containingFrame(parent context.Context, hash string, at float64, probe frameVideo) (float64, error) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	release, err := l.acquireCPU(ctx)
	if err != nil {
		return 0, err
	}
	defer release()
	target := probe.Start + at
	seek := strconv.FormatFloat(math.Floor(target*1e6)/1e6, 'f', 6, 64)
	cmd := mediaCommand(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-select_streams", "v:0", "-read_intervals", seek+"%", "-show_entries", "frame=best_effort_timestamp", "-of", "csv=p=0", l.Object(hash))
	stderr := &limitedBuffer{max: 4096}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 0, err
	}
	if err = cmd.Start(); err != nil {
		return 0, err
	}
	scanner := bufio.NewScanner(stdout)
	selected, found, stopped := 0.0, false, false
	for scanner.Scan() {
		value, _, _ := strings.Cut(scanner.Text(), ",")
		pts, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil {
			continue
		}
		seconds := float64(pts) * probe.TimeBase
		if seconds > target+1e-7 {
			if !found {
				selected, found = seconds, true
			}
			stopped = true
			cancel()
			break
		}
		selected, found = seconds, true
	}
	waitErr := cmd.Wait()
	if parent.Err() != nil {
		return 0, parent.Err()
	}
	if !stopped && waitErr != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, fmt.Errorf("ffprobe frame timing: %w: %s", waitErr, strings.TrimSpace(stderr.String()))
	}
	if err = scanner.Err(); err != nil {
		return 0, err
	}
	if !found {
		return 0, errFrameTime
	}
	return max(0, selected-probe.Start), nil
}

func (l *Library) frame(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	q := r.URL.Query()
	id, hash, motion := chi.URLParam(r, "id"), q.Get("hash"), q.Get("motion")
	dimension := 2560
	if q.Get("size") == "thumb" {
		dimension = 640
	}
	at, err := strconv.ParseFloat(q.Get("time"), 64)
	rotation, rotationErr := 0, error(nil)
	if q.Has("rotation") {
		rotation, rotationErr = strconv.Atoi(q.Get("rotation"))
	}
	if !validID.MatchString(id) || !validHash.MatchString(hash) || !validHash.MatchString(motion) || err != nil || rotationErr != nil || math.IsNaN(at) || math.IsInf(at, 0) || at < 0 || !validRotation(rotation) || len(q["hash"]) != 1 || len(q["motion"]) != 1 || len(q["time"]) != 1 || len(q["rotation"]) > 1 || len(q["size"]) > 1 || q.Has("size") && q.Get("size") != "thumb" && q.Get("size") != "preview" {
		fail(w, 400, "请选择有效视频帧和旋转方向")
		return
	}
	files, err := l.Files(id)
	if err != nil {
		frameFailure(w, err)
		return
	}
	targets, err := frameTargets(files, hash, motion)
	if err != nil {
		frameFailure(w, err)
		return
	}
	unlock := l.lockFrameTargets(targets)
	defer unlock()
	files, err = l.Files(id)
	if err != nil {
		frameFailure(w, err)
		return
	}
	current, err := frameTargets(files, hash, motion)
	if err == nil {
		err = checkRotationTargets(l.DB, id, targets, current)
	}
	if err != nil {
		frameFailure(w, err)
		return
	}
	if !q.Has("rotation") {
		rotation = current[0].Rotation
	}
	ctx, finish, err := l.beginFrameWork(r.Context(), current)
	if err != nil {
		frameFailure(w, err)
		return
	}
	defer finish()
	probe, err := l.probeFrameVideo(ctx, motion)
	if err != nil || at >= probe.Duration {
		if err == nil {
			err = errFrameTime
		}
		frameFailure(w, err)
		return
	}
	at, err = l.containingFrame(ctx, motion, at, probe)
	if err != nil {
		frameFailure(w, err)
		return
	}
	work, err := os.MkdirTemp(filepath.Join(l.Root, "work"), hash+"-frame-")
	if err != nil {
		frameFailure(w, err)
		return
	}
	defer os.RemoveAll(work)
	output := filepath.Join(work, "frame.jpg")
	err = l.videoFrame(ctx, l.Object(motion), output, at, dimension)
	if err == nil && rotation != 0 {
		orientation := map[int]string{90: "6", 180: "3", 270: "8"}[rotation]
		_, err = l.command(ctx, "exiftool", "-n", "-EXIF:Orientation="+orientation, "-overwrite_original", output)
	}
	for _, target := range current {
		if err == nil {
			err = originalDeletion(l.DB, target.Hash, "")
		}
	}
	if err != nil {
		frameFailure(w, err)
		return
	}
	file, err := os.Open(output)
	if err != nil {
		frameFailure(w, err)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		frameFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeContent(w, r, "frame.jpg", stat.ModTime(), file)
}

func (l *Library) coverPath(file File, kind string) string {
	return l.Derived(file.Hash, "-cover-"+file.Cover.Revision+derivativeSuffix(kind))
}

func readyDerivative(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && stat.Mode().IsRegular() && stat.Size() > 0
}

// Independent files never replace canonical still/video derivatives. A lost
// derivative can be regenerated from the durable selection and original motion.
func (l *Library) generateCover(ctx context.Context, file File) error {
	if readyDerivative(l.coverPath(file, "preview")) && readyDerivative(l.coverPath(file, "thumb")) {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	work, err := os.MkdirTemp(filepath.Join(l.Root, "work"), file.Hash+"-cover-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	preview, thumb := filepath.Join(work, "preview.jpg"), filepath.Join(work, "thumb.jpg")
	if err = l.videoFrame(ctx, l.Object(file.Cover.Motion), preview, file.Cover.Time, 2560); err != nil {
		return err
	}
	if err = l.videoFrame(ctx, preview, thumb, 0, 640); err != nil {
		return err
	}
	for _, hash := range []string{file.Hash, file.Cover.Motion} {
		if err = originalDeletion(l.DB, hash, ""); err != nil {
			return err
		}
	}
	for _, kind := range []string{"preview", "thumb"} {
		path := filepath.Join(work, kind+".jpg")
		output, err := os.OpenFile(path, os.O_RDWR, 0600)
		if err != nil {
			return err
		}
		if _, _, err = image.DecodeConfig(output); err == nil {
			err = output.Chmod(0600)
		}
		if err == nil {
			err = output.Sync()
		}
		closeErr := output.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = os.Rename(path, l.coverPath(file, kind)); err != nil {
			return err
		}
	}
	return syncDirectory(filepath.Join(l.Root, "derived"))
}

func (l *Library) removeCoverRevision(hash, revision string) error {
	if !validHash.MatchString(hash) || !validID.MatchString(revision) {
		return fmt.Errorf("invalid cover derivative identity")
	}
	for _, kind := range []string{"thumb", "preview"} {
		if err := removeDurably(l.Derived(hash, "-cover-"+revision+derivativeSuffix(kind))); err != nil {
			return err
		}
		for _, rotation := range []int{90, 180, 270} {
			path := l.Derived(hash, fmt.Sprintf("-cover-%s-rotation%d%s", revision, rotation, derivativeSuffix(kind)))
			for _, derivative := range []string{path, path + ".source"} {
				if err := removeDurably(derivative); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (l *Library) videoFrame(ctx context.Context, input, output string, at float64, dimension int) error {
	hdrFilters, err := l.videoFrameHDRFilters(ctx, input, dimension)
	if err != nil {
		return err
	}
	modes := []string{"CPU"}
	if len(hdrFilters) == 0 && l.nvidiaAvailable(ctx) {
		// Software decode applies the source display matrix before CUDA resizing;
		// JPEG has no video display matrix and cannot defer native orientation.
		modes = []string{"NVIDIA GPU · 软件解码", "CPU"}
	}
	for _, mode := range modes {
		if err = ctx.Err(); err != nil {
			return err
		}
		args := []string{"-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "1", "-filter_complex_threads", "1"}
		gpu := mode != "CPU"
		if gpu {
			args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
		}
		if at > 0 {
			args = append(args, "-ss", strconv.FormatFloat(math.Floor(at*1e6)/1e6, 'f', 6, 64))
		}
		args = append(args, "-i", input, "-map", "0:v:0")
		filter := fmt.Sprintf("scale=w='min(%d,iw)':h='min(%d,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", dimension, dimension)
		if len(hdrFilters) > 0 {
			filter = strings.Join(hdrFilters, ",")
		} else if gpu {
			filter = "format=nv12,hwupload," + strings.Replace(filter, "scale=", "scale_cuda=", 1) + ":format=yuv420p,hwdownload,format=yuv420p"
		}
		args = append(args, "-vf", filter, "-frames:v", "1", "-map_metadata", "-1", "-q:v", "2", "-threads", "2", "-y", output)
		var release func()
		if gpu {
			release, err = l.acquireGPU(ctx)
		} else {
			release, err = l.acquireCPU(ctx)
		}
		if err != nil {
			return err
		}
		_, err = l.command(ctx, "ffmpeg", args...)
		release()
		if err == nil && readyDerivative(output) {
			return nil
		}
		if err == nil {
			err = errFrameTime
		}
		if gpu {
			slog.Info("retry cover frame with CPU", "engine", mode, "error", err)
		}
	}
	return err
}
