package library

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"time"
)

type ProcessingLimits struct {
	Workers       int `json:"workers"`
	GPUOperations int `json:"gpuOperations"`
	CPUOperations int `json:"cpuOperations"`
}

func DefaultProcessingLimits() ProcessingLimits {
	// Decoder libraries can create their own pools beyond VIPS_CONCURRENCY.
	workers := max(1, min(4, runtime.GOMAXPROCS(0)/4))
	return ProcessingLimits{Workers: workers, GPUOperations: min(2, workers), CPUOperations: min(4, workers)}
}

// ConfigureProcessing sets immutable limits before starting the worker and HTTP server.
func (l *Library) ConfigureProcessing(workers, gpuOperations int) error {
	if workers < 1 || gpuOperations < 1 || gpuOperations > workers {
		return fmt.Errorf("processing workers and GPU operations must be positive; GPU operations cannot exceed workers")
	}
	l.ProcessingLimits = ProcessingLimits{Workers: workers, GPUOperations: gpuOperations}
	l.ProcessingLimits.CPUOperations = min(4, workers)
	l.gpuSlots = make(chan struct{}, gpuOperations)
	l.cpuSlots = make(chan struct{}, l.ProcessingLimits.CPUOperations)
	// Keep foreground playback from waiting behind every background media job.
	l.backgroundGPU = make(chan struct{}, max(1, gpuOperations-1))
	l.backgroundCPU = make(chan struct{}, max(1, l.ProcessingLimits.CPUOperations-1))
	return nil
}

func (l *Library) acquireCPU(ctx context.Context) (func(), error) {
	background, err := acquireMediaSlot(ctx, l.backgroundCPU)
	if err != nil {
		return nil, err
	}
	foreground, err := l.acquirePlaybackCPU(ctx)
	if err != nil {
		background()
		return nil, err
	}
	return func() { foreground(); background() }, nil
}

func (l *Library) acquirePlaybackCPU(ctx context.Context) (func(), error) {
	return acquireMediaSlot(ctx, l.cpuSlots)
}

func (l *Library) acquireGPU(ctx context.Context) (func(), error) {
	background, err := acquireMediaSlot(ctx, l.backgroundGPU)
	if err != nil {
		return nil, err
	}
	foreground, err := l.acquirePlaybackGPU(ctx)
	if err != nil {
		background()
		return nil, err
	}
	return func() { foreground(); background() }, nil
}

func (l *Library) acquirePlaybackGPU(ctx context.Context) (func(), error) {
	return acquireMediaSlot(ctx, l.gpuSlots)
}

func acquireMediaSlot(ctx context.Context, slots chan struct{}) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (l *Library) Worker(ctx context.Context) {
	defer l.closeImageGPU()
	if e := l.RecoverDeletions(ctx); e != nil && ctx.Err() == nil {
		slog.Error("recover permanent deletion", "error", e)
	}
	if _, e := l.DB.Exec("UPDATE files SET status='queued' WHERE status='processing'"); e != nil {
		slog.Error("recover processing jobs", "error", e)
		return
	}
	facetStopped := make(chan struct{})
	go func() { defer close(facetStopped); l.facetLoop(ctx) }()
	defer func() { <-facetStopped }()
	dinoStopped := make(chan struct{})
	reviewStopped := make(chan struct{})
	go func() { defer close(reviewStopped); l.reviewIndexLoop(ctx) }()
	defer func() { <-reviewStopped }()
	go func() {
		defer close(dinoStopped)
		l.dinoLoop(ctx)
	}()
	defer func() { <-dinoStopped }()
	videoStopped := make(chan struct{})
	go func() { defer close(videoStopped); l.videoSimilarityLoop(ctx) }()
	defer func() { <-videoStopped }()
	slog.Info("media processing concurrency", "workers", l.ProcessingLimits.Workers, "gpuOperations", l.ProcessingLimits.GPUOperations, "cpuOperations", l.ProcessingLimits.CPUOperations)
	var running sync.WaitGroup
	// Drain jobs before shutting down their GPU contexts or the catalog connection.
	defer running.Wait()
	completed := make(chan string, l.ProcessingLimits.Workers)
	assigned := map[string]bool{}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		_ = l.recoverDeletions(ctx, false)
		if len(assigned) < l.ProcessingLimits.Workers {
			rows, err := l.DB.Query(`SELECT hash FROM files WHERE status='queued' AND NOT EXISTS(SELECT 1 FROM deletion_hashes p WHERE p.hash=files.hash)
 ORDER BY created_at,hash LIMIT ?`, l.ProcessingLimits.Workers)
			hashes := []string{}
			if err == nil {
				for rows.Next() {
					var hash string
					if err = rows.Scan(&hash); err != nil {
						break
					}
					if !assigned[hash] {
						hashes = append(hashes, hash)
					}
				}
				if err == nil {
					err = rows.Err()
				}
				rows.Close()
			}
			if err != nil {
				slog.Error("job lookup", "error", err)
			} else {
				for _, hash := range hashes {
					if ctx.Err() != nil || len(assigned) == l.ProcessingLimits.Workers {
						break
					}
					assigned[hash] = true
					running.Add(1)
					go func() {
						defer running.Done()
						l.runQueued(ctx, hash)
						completed <- hash
					}()
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case hash := <-completed:
			delete(assigned, hash)
		case <-l.Wake:
		case <-ticker.C:
		}
	}
}

func (l *Library) runQueued(ctx context.Context, hash string) {
	err := l.processQueued(ctx, hash)
	if err == nil {
		return
	}
	var deleted *deletedOriginal
	if errors.As(err, &deleted) || errors.Is(err, sql.ErrNoRows) {
		return
	}
	if ctx.Err() != nil {
		_, _ = l.DB.Exec("UPDATE files SET status='queued' WHERE hash=? AND status='processing'", hash)
		return
	}
	slog.Error("media processing", "hash", hash, "error", err)
	_, _ = l.DB.Exec("UPDATE files SET status='error',error=? WHERE hash=? AND status='processing'", err.Error(), hash)
}
