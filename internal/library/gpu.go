package library

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

func (l *Library) nvidiaAvailable(ctx context.Context) bool {
	l.gpuOnce.Do(func() {
		if os.Getenv("AURA_GPU") == "cpu" {
			return
		}
		probe, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		_, err := command(probe, "ffmpeg", "-nostdin", "-v", "error", "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu", "-f", "lavfi", "-i", "color=size=640x480:rate=1", "-vf", "format=nv12,hwupload,scale_cuda=320:240", "-c:v", "h264_nvenc", "-frames:v", "1", "-f", "null", "-")
		l.gpuAvailable = err == nil
		if err != nil {
			slog.Info("NVIDIA acceleration unavailable; using CPU", "error", err)
		}
	})
	return l.gpuAvailable
}

// Progress uses encoded media time, not elapsed wall time or a synthetic timer.
func ffmpegProgress(ctx context.Context, args []string, duration float64, update func(float64)) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", append([]string{"-nostdin", "-v", "error", "-progress", "pipe:1", "-nostats"}, args...)...)
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
		return fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if err = scanner.Err(); err != nil {
		return err
	}
	update(100)
	return nil
}

func (l *Library) videoDerivative(ctx context.Context, input, output, step string, duration float64, p *jobTracker) error {
	const dimensions = "w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
	thumbnail := step == "thumbnail"
	modes := []string{"CPU"}
	if l.nvidiaAvailable(ctx) {
		modes = []string{"NVIDIA GPU", "NVIDIA GPU · 软件解码", "CPU"}
	}
	var err error
	for _, mode := range modes {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		p.encoding(step, mode, 0)
		args := []string{"-protocol_whitelist", "file,pipe"}
		gpu := mode != "CPU"
		if gpu {
			args = append(args, "-init_hw_device", "cuda=gpu:0", "-filter_hw_device", "gpu")
			if mode == "NVIDIA GPU" {
				args = append(args, "-hwaccel", "cuda", "-hwaccel_output_format", "cuda")
			}
		}
		args = append(args, "-i", input, "-map", "0:v:0")
		filter := "scale=" + dimensions
		if thumbnail {
			filter = "scale=640:640:force_original_aspect_ratio=decrease"
		}
		if gpu {
			filter = strings.Replace(filter, "scale=", "scale_cuda=", 1)
			if mode != "NVIDIA GPU" {
				filter = "format=nv12,hwupload," + filter
			}
			if thumbnail {
				filter += ":format=yuv420p,hwdownload,format=yuv420p"
			} else {
				filter += ":format=nv12"
			}
		}
		args = append(args, "-vf", filter)
		if thumbnail {
			args = append(args, "-frames:v", "1")
		} else {
			args = append(args, "-map", "0:a?")
			if gpu {
				args = append(args, "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "20", "-b:v", "0")
			} else {
				args = append(args, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p")
			}
			args = append(args, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart")
		}
		args = append(args, "-threads", "2", "-y", output)
		err = ffmpegProgress(ctx, args, duration, func(percent float64) { p.encoding(step, mode, percent) })
		if err == nil {
			return nil
		}
		if gpu {
			slog.Info("retry media with fallback engine", "step", step, "engine", mode, "error", err)
		}
	}
	return err
}
