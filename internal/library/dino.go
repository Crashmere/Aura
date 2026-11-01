package library

import (
	"bufio"
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

//go:embed dino.py
var dinoScript string

const dinoModel = "dinov2-vits14-224-v1"
const dinoSuffix = "-dino-vits14-224-v1.json"
const dinoBatchSize = 16
const dinoBatchWait = 10 * time.Second

type dinoMatch struct {
	Hash  string  `json:"hash"`
	Score float32 `json:"score"`
}

type dinoRecord struct {
	Model     string      `json:"model"`
	Hash      string      `json:"hash"`
	Thumbnail string      `json:"thumbnail"`
	CreatedAt string      `json:"createdAt"`
	Matches   []dinoMatch `json:"matches"`
	Error     string      `json:"error,omitempty"`
}

type dinoOutput struct {
	Hash    string      `json:"hash"`
	Vector  []float32   `json:"vector,omitempty"`
	Matches []dinoMatch `json:"matches"`
	Error   string      `json:"error,omitempty"`
}

type dinoItem struct {
	Hash      string `json:"hash"`
	Thumbnail string `json:"thumbnail"`
	Path      string `json:"path,omitempty"`
}

type dinoStatus struct {
	State     string `json:"state"`
	Total     int    `json:"total"`
	Ready     int    `json:"ready"`
	Pending   int    `json:"pending"`
	Errors    int    `json:"errors"`
	Engine    string `json:"engine,omitempty"`
	BatchSize int    `json:"batchSize"`
	WaitSecs  int    `json:"waitSeconds"`
}

type dinoResponse struct {
	Items  []dinoOutput `json:"items"`
	Engine string       `json:"engine"`
	Error  string       `json:"error"`
	Note   string       `json:"note"`
}

type dinoProcess struct {
	cmd      *exec.Cmd
	input    io.WriteCloser
	response chan dinoResponse
	done     chan struct{}
	err      error
}

func dinoRuntime() string {
	if path := os.Getenv("AURA_DINO_RUNTIME"); path != "" {
		return path
	}
	return "/opt/aura/bin/dino"
}

func (l *Library) dinoSnapshot() dinoStatus {
	l.dinoMu.RLock()
	defer l.dinoMu.RUnlock()
	status := l.dinoStatus
	if status.State == "" {
		status.State = "starting"
	}
	status.BatchSize, status.WaitSecs = dinoBatchSize, int(dinoBatchWait.Seconds())
	return status
}

func (l *Library) dinoRecordSnapshot() map[string]dinoRecord {
	l.dinoMu.RLock()
	defer l.dinoMu.RUnlock()
	records := make(map[string]dinoRecord, len(l.dinoRecords))
	for hash, record := range l.dinoRecords {
		records[hash] = record
	}
	return records
}

func (l *Library) dinoCatalog(ctx context.Context) ([]dinoItem, error) {
	rows, err := l.DB.QueryContext(ctx, `SELECT f.hash FROM assets a JOIN files f ON f.hash=a.primary_hash
 WHERE a.trashed_at='' AND f.status='ready' AND f.mime LIKE 'image/%' AND NOT EXISTS
 (SELECT 1 FROM decisions d,json_each(d.detail,'$.hashes') h WHERE d.action='purge-request' AND h.value=f.hash)
 ORDER BY f.created_at,f.hash`)
	if err != nil {
		return nil, err
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
		return nil, err
	}
	items := []dinoItem{}
	for _, hash := range hashes {
		path := l.Derived(hash, "-thumb.jpg")
		stat, err := os.Stat(path)
		if err == nil && stat.Mode().IsRegular() {
			items = append(items, dinoItem{hash, fmt.Sprintf("%d:%d", stat.Size(), stat.ModTime().UnixNano()), path})
		}
	}
	return items, nil
}

// Missing or outdated records form the persistent queue, independent of media jobs.
func (l *Library) refreshDINO(ctx context.Context) ([]dinoItem, []dinoItem, error) {
	catalog, err := l.dinoCatalog(ctx)
	if err != nil {
		return nil, nil, err
	}
	old := l.dinoRecordSnapshot()
	records := make(map[string]dinoRecord, len(catalog))
	pending := []dinoItem{}
	ready, failed := 0, 0
	for _, item := range catalog {
		record, cached := old[item.Hash]
		if !cached || record.Thumbnail != item.Thumbnail {
			if data, e := os.ReadFile(l.Derived(item.Hash, dinoSuffix)); e == nil {
				_ = json.Unmarshal(data, &record)
			}
		}
		valid := record.Model == dinoModel && record.Hash == item.Hash && record.Thumbnail == item.Thumbnail
		if valid {
			records[item.Hash] = record
			if record.Error == "" {
				ready++
				continue
			}
			failed++
			at, _ := time.Parse(time.RFC3339Nano, record.CreatedAt)
			if time.Since(at) < 5*time.Minute {
				continue
			}
		}
		pending = append(pending, item)
	}
	l.dinoMu.Lock()
	l.dinoRecords = records
	l.dinoStatus.Total, l.dinoStatus.Ready = len(catalog), ready
	l.dinoStatus.Pending, l.dinoStatus.Errors = len(catalog)-ready, failed
	l.dinoMu.Unlock()
	return catalog, pending, nil
}

func startDINO() (*dinoProcess, error) {
	runtime := dinoRuntime()
	mode := os.Getenv("AURA_GPU")
	cmd := exec.Command(filepath.Join(runtime, ".venv/bin/python"), "-B", "-u", "-c", dinoScript, runtime, mode)
	cmd.Env = append(os.Environ(), "PYTHONNOUSERSITE=1", "OPENBLAS_NUM_THREADS=4", "OMP_NUM_THREADS=4", "XFORMERS_DISABLED=1")
	stderr := &limitedBuffer{max: 4096}
	cmd.Stderr = stderr
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		input.Close()
		return nil, err
	}
	w := &dinoProcess{cmd: cmd, input: input, response: make(chan dinoResponse, 1), done: make(chan struct{})}
	go func() {
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 64<<10), 4<<20)
		for scanner.Scan() {
			var response dinoResponse
			if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
				w.err = fmt.Errorf("invalid DINO response: %w", err)
				_ = cmd.Process.Kill()
				break
			}
			w.response <- response
		}
		if err := scanner.Err(); err != nil {
			w.err = err
			_ = cmd.Process.Kill()
		}
		if err := cmd.Wait(); err != nil {
			w.err = fmt.Errorf("DINO worker: %w: %s", err, strings.TrimSpace(stderr.String()))
		}
		close(w.response)
		close(w.done)
	}()
	return w, nil
}

func (w *dinoProcess) stop() {
	_ = w.input.Close()
	_ = w.cmd.Process.Kill()
	<-w.done
}

func (l *Library) persistDINO(ctx context.Context, item dinoItem, output dinoOutput) error {
	unlock := l.lockUpload(item.Hash)
	defer unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := originalDeletion(l.DB, item.Hash, ""); err != nil {
		return err
	}
	var status string
	if err := l.DB.QueryRowContext(ctx, "SELECT status FROM files WHERE hash=?", item.Hash).Scan(&status); err != nil || status != "ready" {
		return sql.ErrNoRows
	}
	stat, err := os.Stat(item.Path)
	if err != nil || fmt.Sprintf("%d:%d", stat.Size(), stat.ModTime().UnixNano()) != item.Thumbnail {
		return fmt.Errorf("thumbnail changed during DINO extraction")
	}
	record := dinoRecord{dinoModel, item.Hash, item.Thumbnail, now(), output.Matches, output.Error}
	data, err := json.Marshal(struct {
		dinoRecord
		Vector []float32 `json:"vector,omitempty"`
	}{record, output.Vector})
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Join(l.Root, "derived"), item.Hash+dinoSuffix+".part-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(file.Name(), l.Derived(item.Hash, dinoSuffix))
	}
	if err == nil {
		err = syncDirectory(filepath.Join(l.Root, "derived"))
	}
	if err == nil {
		l.dinoMu.Lock()
		if l.dinoRecords == nil {
			l.dinoRecords = map[string]dinoRecord{}
		}
		l.dinoRecords[item.Hash] = record
		l.dinoMu.Unlock()
	}
	return err
}

func (l *Library) runDINOBatch(parent context.Context, worker **dinoProcess, catalog, batch []dinoItem) error {
	ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
	defer cancel()
	job := &processingJob{cancel: cancel, done: make(chan struct{})}
	l.dinoMu.Lock()
	l.dinoActive = job
	l.dinoHashes = map[string]bool{}
	for _, item := range batch {
		l.dinoHashes[item.Hash] = true
	}
	l.dinoStatus.State = "processing"
	l.dinoMu.Unlock()
	defer func() {
		l.dinoMu.Lock()
		l.dinoActive = nil
		l.dinoHashes = nil
		close(job.done)
		l.dinoMu.Unlock()
	}()
	items := []dinoItem{}
	for _, item := range batch {
		if err := originalDeletion(l.DB, item.Hash, ""); err == nil {
			items = append(items, item)
		}
	}
	if len(items) == 0 {
		return nil
	}
	if os.Getenv("AURA_GPU") != "cpu" {
		release, err := l.acquireGPU(ctx)
		if err != nil {
			return err
		}
		defer release()
	}
	if *worker != nil {
		select {
		case <-(*worker).done:
			_ = (*worker).input.Close()
			*worker = nil
		default:
		}
	}
	if *worker == nil {
		var err error
		*worker, err = startDINO()
		if err != nil {
			return err
		}
	}
	request := map[string]any{"records": filepath.Join(l.Root, "derived"), "catalog": catalog, "items": items}
	if err := json.NewEncoder((*worker).input).Encode(request); err != nil {
		(*worker).stop()
		*worker = nil
		return err
	}
	var response dinoResponse
	select {
	case <-ctx.Done():
		(*worker).stop()
		*worker = nil
		return ctx.Err()
	case result, ok := <-(*worker).response:
		if !ok {
			<-(*worker).done
			err := (*worker).err
			_ = (*worker).input.Close()
			*worker = nil
			return fmt.Errorf("DINO stopped: %v", err)
		}
		response = result
	}
	if response.Error != "" {
		return fmt.Errorf("DINO: %s", response.Error)
	}
	if len(response.Items) != len(items) {
		return fmt.Errorf("DINO returned an incomplete batch")
	}
	byHash := map[string]dinoItem{}
	for _, item := range items {
		byHash[item.Hash] = item
	}
	for _, output := range response.Items {
		item, ok := byHash[output.Hash]
		if !ok {
			return fmt.Errorf("DINO returned an unexpected resource")
		}
		delete(byHash, output.Hash)
		if output.Error == "" {
			if len(output.Vector) != 384 {
				return fmt.Errorf("invalid DINO vector dimensions")
			}
			for _, value := range output.Vector {
				if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
					return fmt.Errorf("invalid DINO vector")
				}
			}
		}
		if err := l.persistDINO(ctx, item, output); err != nil && ctx.Err() == nil {
			slog.Warn("persist DINO feature", "hash", item.Hash, "error", err)
		}
	}
	l.dinoMu.Lock()
	l.dinoStatus.Engine = response.Engine
	l.dinoMu.Unlock()
	if response.Note != "" {
		slog.Warn("DINO CPU fallback", "reason", response.Note)
	}
	slog.Info("DINO batch completed", "images", len(items), "engine", response.Engine)
	return ctx.Err()
}

func (l *Library) dinoLoop(ctx context.Context) {
	var worker *dinoProcess
	defer func() {
		if worker != nil {
			worker.stop()
		}
	}()
	l.dinoMu.Lock()
	l.dinoStatus.State = "idle"
	if os.Getenv("AURA_DINO") == "off" {
		l.dinoStatus.State = "disabled"
	}
	l.dinoMu.Unlock()
	if os.Getenv("AURA_DINO") == "off" {
		_, _, _ = l.refreshDINO(ctx)
		return
	}
	firstPending := time.Time{}
	retry := time.Time{}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		catalog, pending, err := l.refreshDINO(ctx)
		state := "idle"
		if err != nil {
			slog.Error("DINO queue lookup", "error", err)
			state = "unavailable"
		} else if len(pending) > 0 {
			state = "waiting"
			if firstPending.IsZero() {
				firstPending = time.Now()
			}
			if time.Now().Before(retry) {
				state = "unavailable"
			} else if len(pending) >= dinoBatchSize || time.Since(firstPending) >= dinoBatchWait {
				batch := pending[:min(len(pending), dinoBatchSize)]
				err = l.runDINOBatch(ctx, &worker, catalog, batch)
				if errors.Is(err, context.Canceled) {
					firstPending = time.Time{}
					continue
				}
				if err != nil && ctx.Err() == nil {
					slog.Error("DINO batch", "error", err)
					retry = time.Now().Add(time.Minute)
					state = "unavailable"
				} else {
					firstPending = time.Time{}
					continue
				}
			}
		} else {
			firstPending = time.Time{}
		}
		l.dinoMu.Lock()
		l.dinoStatus.State = state
		l.dinoMu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (l *Library) cancelDINO(hashes []string) *processingJob {
	l.dinoMu.RLock()
	defer l.dinoMu.RUnlock()
	for _, hash := range hashes {
		if l.dinoHashes[hash] && l.dinoActive != nil {
			l.dinoActive.cancel()
			return l.dinoActive
		}
	}
	return nil
}

// Hash order gives each pair one stable key across incremental batches.
func orderedDINO(left, right string) (string, string) {
	if left > right {
		return right, left
	}
	return left, right
}
