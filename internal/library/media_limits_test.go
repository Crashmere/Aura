package library

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNativeMediaConcurrencyAndCancellation(t *testing.T) {
	dir := t.TempDir()
	started := filepath.Join(dir, "started")
	t.Setenv("AURA_TEST_STARTED", started)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	for _, name := range []string{"vips", "vipsheader", "exiftool"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\nprintf x >> \"$AURA_TEST_STARTED\"\nexec sleep 60\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	l := &Library{}
	if err := l.ConfigureProcessing(8, 4); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 8)
	for i := range 8 {
		go func() {
			name := []string{"vips", "vipsheader", "exiftool"}[i%3]
			done <- l.commandOutput(ctx, name, io.Discard, "blocked-decoder")
		}()
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		data, _ := os.ReadFile(started)
		if len(data) >= 4 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d native commands started", len(data))
		}
		time.Sleep(10 * time.Millisecond)
	}
	// All eight callers are active while the four running decoders are blocked.
	time.Sleep(100 * time.Millisecond)
	if data, _ := os.ReadFile(started); len(data) != 4 {
		t.Fatalf("native commands exceeded the shared bound: %d", len(data))
	}
	cancel()
	for range 8 {
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("canceled native command: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("cancellation did not drain active and waiting native commands")
		}
	}
	probe, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer stop()
	if _, err := l.command(probe, "vips", "unused"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked decoder deadline: %v", err)
	}
	if data, _ := os.ReadFile(started); len(data) != 5 {
		t.Fatal("cancellation did not release the native command slots")
	}
}

func TestImageWorkerBlockedRequestCancellation(t *testing.T) {
	dir := t.TempDir()
	python := filepath.Join(dir, "python")
	if err := os.WriteFile(python, []byte("#!/bin/sh\nexec sleep 60\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AURA_IMAGE_PYTHON", python)
	l := &Library{}
	if err := l.ConfigureProcessing(8, 4); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- l.runImageGPU(ctx, map[string]string{"source": strings.Repeat("x", 256<<10)}, nil) }()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("blocked worker request: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("blocked worker stdin ignored its deadline")
	}
	if len(l.imageGPUIdle) != 0 {
		t.Fatal("canceled worker returned to the reusable pool")
	}
}
