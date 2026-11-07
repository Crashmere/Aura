package library

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type playbackHDRSideData struct {
	Type         string  `json:"side_data_type"`
	MaxContent   float64 `json:"max_content"`
	MaxLuminance string  `json:"max_luminance"`
}

func playbackHDRDefaultPeak(transfer string) float64 {
	// Match FFmpeg's source-side defaults in units of 100 nits. Linearization
	// strips HDR side data and would otherwise hide PQ's 10,000-nit fallback.
	if transfer == "smpte2084" {
		return 100
	}
	return 10
}

func playbackHDRSignalPeak(transfer string, data []playbackHDRSideData) float64 {
	for _, item := range data {
		if item.Type == "Content light level metadata" && item.MaxContent > 0 && !math.IsInf(item.MaxContent, 0) && !math.IsNaN(item.MaxContent) {
			return item.MaxContent / 100
		}
	}
	for _, item := range data {
		if item.Type != "Mastering display metadata" {
			continue
		}
		parts := strings.SplitN(item.MaxLuminance, "/", 2)
		value := playbackNumber(parts[0])
		if len(parts) == 2 {
			denominator := playbackNumber(parts[1])
			if denominator == 0 {
				continue
			}
			value /= denominator
		}
		if value > 0 && !math.IsInf(value, 0) && !math.IsNaN(value) {
			return value / 100
		}
	}
	return playbackHDRDefaultPeak(transfer)
}

func (l *Library) probePlaybackHDRPeak(ctx context.Context, path, transfer string) float64 {
	// The caller already holds CPU admission. One selected video
	// packet plus decoder flushing exposes first-frame metadata without a scan.
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	output := &limitedBuffer{max: 256 << 10}
	err := l.commandOutput(probeCtx, "ffprobe", output, "-v", "error", "-threads", "2", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_frames", "-show_entries", "frame_side_data=side_data_type,max_content,max_luminance", "-of", "json", path)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("HDR playback peak probe failed", "source", filepath.Base(path), "error", err)
		}
		return playbackHDRDefaultPeak(transfer)
	}
	var raw struct {
		Frames []struct {
			SideData []playbackHDRSideData `json:"side_data_list"`
		} `json:"frames"`
	}
	if err = json.Unmarshal(output.Bytes(), &raw); err != nil {
		slog.Warn("HDR playback peak metadata invalid", "source", filepath.Base(path), "error", err)
		return playbackHDRDefaultPeak(transfer)
	}
	if len(raw.Frames) == 0 {
		return playbackHDRDefaultPeak(transfer)
	}
	return playbackHDRSignalPeak(transfer, raw.Frames[0].SideData)
}

func (l *Library) videoFrameHDRFilters(ctx context.Context, path string, dimension int) ([]string, error) {
	release, err := l.acquireCPU(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	raw, err := l.command(ctx, "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-show_entries", "stream=color_transfer", "-of", "json", path)
	if err != nil {
		return nil, err
	}
	var probe struct {
		Streams []struct {
			Transfer string `json:"color_transfer"`
		} `json:"streams"`
	}
	if err = json.Unmarshal(raw, &probe); err != nil {
		return nil, err
	}
	if len(probe.Streams) == 0 {
		return nil, errFrameTime
	}
	transfer := probe.Streams[0].Transfer
	if transfer != "smpte2084" && transfer != "arib-std-b67" {
		return nil, nil
	}
	peak := l.probePlaybackHDRPeak(ctx, path, transfer)
	if transfer == "arib-std-b67" {
		return videoHLGCoverFilters(peak, dimension), nil
	}
	return videoHDRFilters(transfer, peak, dimension), nil
}

func videoHDRScale(dimension int) string {
	// Keep conversion and resize separate: zimg otherwise downsizes HDR samples
	// before linearization. Resizing here bounds the later float tone mapper.
	fit := "min(1," + strconv.Itoa(dimension) + "/max(iw,ih))"
	return "zscale=w='max(2,trunc(round(iw*" + fit + ")/2)*2)'" +
		":h='max(2,trunc(round(ih*" + fit + ")/2)*2)'"
}

func videoHLGCoverFilters(peak float64, dimension int) []string {
	// HLG's 1,000-nit display EOTF is normalized to the BT.2408 203-nit
	// reference white. A filmic shoulder retains highlights in an SDR JPEG;
	// sRGB encoding avoids treating video transfer codes as image samples.
	peak = max(1, peak*100/203)
	return []string{
		"zscale=t=linear:npl=203",
		"format=gbrpf32le",
		videoHDRScale(dimension),
		"tonemap=tonemap=hable:desat=0:peak=" + strconv.FormatFloat(peak, 'f', -1, 64),
		"zscale=p=bt709:t=iec61966-2-1:m=170m:r=full",
		"format=yuv420p",
	}
}

func videoHDRFilters(transfer string, peak float64, dimension int) []string {
	if peak <= 0 || math.IsNaN(peak) || math.IsInf(peak, 0) {
		peak = playbackHDRDefaultPeak(transfer)
	}
	return []string{
		"zscale=t=linear:npl=100",
		"format=gbrpf32le",
		videoHDRScale(dimension),
		"tonemap=tonemap=mobius:desat=0:peak=" + strconv.FormatFloat(peak, 'f', -1, 64),
		"zscale=p=bt709:t=bt709:m=bt709:r=tv",
		"format=yuv420p",
	}
}
