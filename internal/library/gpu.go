package library

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

func (l *Library) nvidiaAvailable(_ context.Context) bool {
	l.gpuOnce.Do(func() {
		if os.Getenv("AURA_GPU") == "cpu" {
			return
		}
		ctx := l.runtimeCtx
		if ctx == nil {
			ctx = context.Background()
		}
		probe, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		release, err := l.acquirePlaybackGPU(probe)
		if err != nil {
			return
		}
		defer release()
		_, err = l.command(probe, "ffmpeg", "-nostdin", "-v", "error", "-filter_threads", "1", "-threads", "2", "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu", "-f", "lavfi", "-i", "color=size=640x480:rate=1", "-vf", "format=nv12,hwupload,scale_cuda=320:240", "-c:v", "h264_nvenc", "-frames:v", "1", "-f", "null", "-")
		l.gpuAvailable = err == nil
		if err != nil {
			slog.Info("NVIDIA acceleration unavailable; using CPU", "error", err)
		}
	})
	return l.gpuAvailable
}

// Progress uses encoded media time, not elapsed wall time or a synthetic timer.
func ffmpegProgress(ctx context.Context, args []string, duration float64, update func(float64)) error {
	cmd := mediaCommand(ctx, "ffmpeg", append([]string{"-nostdin", "-v", "error", "-progress", "pipe:1", "-nostats"}, args...)...)
	stderr := &limitedBuffer{max: 4096}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		if value, ok := strings.CutPrefix(scanner.Text(), "out_time_us="); ok && duration > 0 {
			micros, e := strconv.ParseFloat(value, 64)
			if e == nil {
				update(max(0, min(99.9, micros/(duration*10000))))
			}
		}
	}
	if err = cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if err = scanner.Err(); err != nil {
		return err
	}
	update(100)
	return nil
}

func (l *Library) videoThumbnail(ctx context.Context, input, output string, duration float64, p *jobTracker) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	hdrFilters, err := l.videoFrameHDRFilters(ctx, input, 640)
	if err != nil {
		return err
	}
	modes := []string{"CPU"}
	// NAS has no GPU float tone mapper or JPEG encoder; HDR color conversion
	// stays on CPU rather than reducing HDR to 8-bit before tone mapping.
	if len(hdrFilters) == 0 && l.nvidiaAvailable(ctx) {
		// CUDA frames retain the display matrix without applying it. JPEG
		// cannot retain that matrix, so orient decoded pixels before upload.
		modes = []string{"NVIDIA GPU · 软件解码", "CPU"}
	}
	for _, mode := range modes {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		engine := mode
		if len(hdrFilters) > 0 {
			engine = "CPU · HDR 色调映射"
		}
		p.encoding("thumbnail", engine, 0)
		args := []string{"-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "1", "-filter_complex_threads", "1"}
		gpu := mode != "CPU"
		if gpu {
			args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
		}
		args = append(args, "-i", input, "-map", "0:v:0")
		filter := "scale=640:640:force_original_aspect_ratio=decrease"
		if len(hdrFilters) > 0 {
			filter = strings.Join(hdrFilters, ",")
		} else if gpu {
			filter = strings.Replace(filter, "scale=", "scale_cuda=", 1)
			filter = "format=nv12,hwupload," + filter + ":format=yuv420p,hwdownload,format=yuv420p"
		}
		args = append(args, "-vf", filter, "-frames:v", "1", "-map_metadata", "-1")
		args = append(args, "-threads", "2", "-y", output)
		var release func()
		if gpu {
			release, err = l.acquireGPU(ctx)
			if err != nil {
				return err
			}
		} else {
			release, err = l.acquireCPU(ctx)
			if err != nil {
				return err
			}
		}
		err = ffmpegProgress(ctx, args, duration, func(percent float64) { p.encoding("thumbnail", engine, percent) })
		if release != nil {
			release()
		}
		if err == nil {
			return nil
		}
		if gpu {
			slog.Info("retry video cover with fallback engine", "engine", mode, "error", err)
		}
	}
	return err
}
