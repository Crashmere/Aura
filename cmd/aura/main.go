package main

import (
	"context"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Crashmere/Aura/internal/library"
	"github.com/Crashmere/Aura/web"
)

func main() {
	if e := run(); e != nil {
		slog.Error("Aura", "error", e)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: aura init|serve|check|backup|verify-backup|restore|daily")
	}
	cmd := os.Args[1]
	flags := flag.NewFlagSet(cmd, flag.ContinueOnError)
	data := flags.String("data", "data", "library data directory")
	addr := flags.String("listen", "127.0.0.1:18087", "loopback listener")
	out := flags.String("out", "", "snapshot or restore destination")
	source := flags.String("source", "", "snapshot source")
	full := flags.Bool("full", false, "verify every original checksum")
	if e := flags.Parse(os.Args[2:]); e != nil {
		return e
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if cmd == "restore" {
		if *source == "" || *out == "" {
			return fmt.Errorf("--source and --out required")
		}
		return library.Restore(ctx, *source, *out)
	}
	if cmd == "verify-backup" {
		if *source == "" {
			return fmt.Errorf("--source required")
		}
		return library.VerifySnapshot(ctx, *source, *full)
	}
	if cmd != "init" {
		if _, e := os.Stat(filepath.Join(*data, "aura.sqlite")); e != nil {
			return fmt.Errorf("existing database required; initialize explicitly with aura init: %w", e)
		}
	} else if _, e := os.Stat(filepath.Join(*data, "aura.sqlite")); e == nil {
		return fmt.Errorf("database already exists")
	}
	l, e := library.Open(*data)
	if e != nil {
		return e
	}
	defer l.DB.Close()
	switch cmd {
	case "init", "check":
		return l.Check(ctx)
	case "backup":
		if *out == "" {
			return fmt.Errorf("--out required")
		}
		return l.Backup(ctx, *out)
	case "daily":
		if *out == "" {
			return fmt.Errorf("--out required")
		}
		return l.Daily(ctx, *out)
	case "serve":
		assets, e := fs.Sub(web.Files, "dist")
		if e != nil {
			return e
		}
		go l.Worker(ctx)
		srv := &http.Server{Addr: *addr, Handler: l.Handler(assets), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 << 10}
		stopped := make(chan struct{})
		go func() {
			<-ctx.Done()
			shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			_ = srv.Shutdown(shutdown)
			close(stopped)
		}()
		slog.Info("Aura listening", "address", *addr)
		e = srv.ListenAndServe()
		if e == http.ErrServerClosed {
			<-stopped
			return nil
		}
		return e
	default:
		return fmt.Errorf("unknown command: %s", cmd)
	}
}
