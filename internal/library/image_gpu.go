package library

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

//go:embed image_gpu.py
var imageGPUScript string

type imageGPUEvent struct {
	Step   string `json:"step"`
	Status string `json:"status"`
	Engine string `json:"engine"`
	Done   bool   `json:"done"`
	Error  string `json:"error"`
}

type imageGPUWorker struct {
	cmd    *exec.Cmd
	input  io.WriteCloser
	events chan imageGPUEvent
	done   chan struct{}
	error  error
}

func (w *imageGPUWorker) stop() {
	_ = w.input.Close()
	_ = w.cmd.Process.Kill()
	<-w.done
}

func (l *Library) closeImageGPU() {
	l.imageGPUMu.Lock()
	defer l.imageGPUMu.Unlock()
	if l.imageGPU != nil {
		l.imageGPU.stop()
		l.imageGPU = nil
	}
}

func startImageGPU(python string) (*imageGPUWorker, error) {
	cmd := exec.Command(python, "-B", "-u", "-c", imageGPUScript)
	cmd.Env = append(os.Environ(), "PYTHONNOUSERSITE=1", "OPENBLAS_NUM_THREADS=1")
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
	w := &imageGPUWorker{cmd: cmd, input: input, events: make(chan imageGPUEvent, 16), done: make(chan struct{})}
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			var event imageGPUEvent
			if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
				w.error = fmt.Errorf("invalid GPU worker response: %w", err)
				_ = cmd.Process.Kill()
				break
			}
			w.events <- event
		}
		if err := cmd.Wait(); err != nil {
			w.error = fmt.Errorf("GPU image worker: %w: %s", err, strings.TrimSpace(stderr.String()))
		}
		close(w.events)
		close(w.done)
	}()
	return w, nil
}

func imagePython() string {
	if python := os.Getenv("AURA_IMAGE_PYTHON"); python != "" {
		return python
	}
	return "/opt/aura/bin/image-gpu/bin/python"
}

func (l *Library) runImageGPU(ctx context.Context, request map[string]string, p *jobTracker) error {
	l.imageGPUMu.Lock()
	defer l.imageGPUMu.Unlock()
	if l.imageGPU != nil {
		select {
		case <-l.imageGPU.done:
			l.imageGPU = nil
		default:
		}
	}
	if l.imageGPU == nil {
		worker, err := startImageGPU(imagePython())
		if err != nil {
			return err
		}
		l.imageGPU = worker
	}
	w := l.imageGPU
	if err := json.NewEncoder(w.input).Encode(request); err != nil {
		w.stop()
		l.imageGPU = nil
		return err
	}
	for {
		select {
		case <-ctx.Done():
			w.stop()
			l.imageGPU = nil
			return ctx.Err()
		case event, ok := <-w.events:
			if !ok {
				<-w.done
				l.imageGPU = nil
				return fmt.Errorf("GPU worker stopped: %v", w.error)
			}
			if event.Done {
				if event.Error != "" {
					return fmt.Errorf("GPU image processing: %s", event.Error)
				}
				return nil
			}
			if event.Step == "preview" || event.Step == "thumbnail" {
				p.step(event.Step, event.Status, nil)
				p.encoding(event.Step, event.Engine, 0)
			}
		}
	}
}

func (l *Library) imageDerivativesGPU(ctx context.Context, f File, meta map[string]any, input, decoded, work string, p *jobTracker) error {
	if os.Getenv("AURA_GPU") == "cpu" {
		return fmt.Errorf("GPU disabled by configuration")
	}
	if _, err := exec.LookPath(imagePython()); err != nil {
		return err
	}
	// Leave space for the decoder, resampling workspace and other NAS media jobs.
	if int64(f.Width)*int64(f.Height) > 80_000_000 {
		return fmt.Errorf("image exceeds the GPU working-set limit")
	}
	request := map[string]string{"source": input, "preview": filepath.Join(work, "preview.jpg"), "thumbnail": filepath.Join(work, "thumb.jpg")}
	profile := false
	for key := range meta {
		if strings.HasPrefix(key, "ICC-") || strings.HasPrefix(key, "ICC_Profile:") {
			profile = true
			break
		}
	}
	// nvJPEG does not perform arbitrary ICC transforms. libvips supplies normalized
	// full-resolution RGB for profile-bearing JPEGs and other image formats.
	if f.Mime == "image/jpeg" && !profile && number(meta, "ColorComponents") != 4 {
		if err := l.runImageGPU(ctx, request, p); err == nil {
			return nil
		} else if ctx.Err() != nil {
			return ctx.Err()
		} else {
			slog.Info("retry GPU previews with CPU decoding", "error", err)
		}
	}
	width, err := command(ctx, "vipsheader", "-f", "width", decoded)
	if err != nil {
		return err
	}
	w, err := strconv.Atoi(strings.TrimSpace(string(width)))
	if err != nil || w < 1 {
		return fmt.Errorf("invalid decoded image width")
	}
	height, err := command(ctx, "vipsheader", "-f", "height", decoded)
	if err != nil {
		return err
	}
	h, err := strconv.Atoi(strings.TrimSpace(string(height)))
	if err != nil || h < 1 {
		return fmt.Errorf("invalid decoded image height")
	}
	if int64(w)*int64(h) > 80_000_000 {
		return fmt.Errorf("image exceeds the GPU working-set limit")
	}
	rgb := filepath.Join(work, "gpu-source.ppm")
	if _, err = command(ctx, "vips", "thumbnail", decoded, rgb+"[strip,format=ppm]", strconv.Itoa(max(w, h)), "--size", "down"); err != nil {
		return err
	}
	defer os.Remove(rgb)
	request["rgb"] = rgb
	return l.runImageGPU(ctx, request, p)
}
