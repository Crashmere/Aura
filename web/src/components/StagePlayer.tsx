import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  Image as ImageIcon,
  LoaderCircle,
  Maximize,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  StepBack,
  StepForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  buildFramePreviewUrl,
  buildMediaUrl,
  formatDurationClock,
  normalizeQuarterAngle,
  orientedDimensions,
} from "../core/client";
import type { CatalogAsset } from "../core/types";
import {
  cacheDecodedPreview,
  isPreviewCached,
  readCachedPreviewUrl,
  useNetworkMediaPolicy,
} from "../core/workspace";
import { MotionPresence, useIsPresent } from "../core/motion";
import { SkipSecondsGlyph } from "./Icons";

// ============================================================================
// 1. Live Quarter-Turn CSS Rotation Preview Hook
// ============================================================================

export function useQuarterTurnBoxStyle(
  containerRef: RefObject<HTMLElement | null>,
  deltaRotation: number,
): CSSProperties | undefined {
  const isOddQuarter = normalizeQuarterAngle(deltaRotation) % 180 !== 0;
  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !isOddQuarter) return;
    const measure = () =>
      setBoxSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, isOddQuarter]);

  // Keep the same centered geometry at zero so each quarter-turn takes the short path.
  return {
    position: "absolute",
    inset: "auto",
    left: "50%",
    top: "50%",
    width: isOddQuarter && boxSize.height ? boxSize.height : "100%",
    height: isOddQuarter && boxSize.width ? boxSize.width : "100%",
    transform: `translate(-50%, -50%) rotate(${deltaRotation}deg)`,
  };
}

// ============================================================================
// 2. Progressive Photo Stage (Thumb -> 2560px Preview Crossfade)
// ============================================================================

export function ProgressiveStagePhoto({
  asset,
  zoomed = false,
  rotationDelta = 0,
  onClearReady,
}: {
  asset: CatalogAsset;
  zoomed?: boolean;
  rotationDelta?: number;
  onClearReady: () => void;
}) {
  const mediaPolicy = useNetworkMediaPolicy();
  const [userRequestedClear, setUserRequestedClear] = useState(false);
  const [retryStamp, setRetryStamp] = useState(0);
  const [clearFailed, setClearFailed] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);

  const detailImgRef = useRef<HTMLImageElement>(null);
  const frameBoxRef = useRef<HTMLDivElement>(null);
  const rotationCss = useQuarterTurnBoxStyle(frameBoxRef, rotationDelta);

  const dims = orientedDimensions({
    ...asset,
    rotation: normalizeQuarterAngle((asset.rotation || 0) + rotationDelta),
  });

  const basePreviewUrl = buildMediaUrl(
    asset.primary,
    "preview",
    asset.rotation,
    asset.cover?.revision,
  );
  const [initialUrl] = useState(
    () => readCachedPreviewUrl(basePreviewUrl) || basePreviewUrl,
  );
  const activePreviewUrl = retryStamp
    ? `${basePreviewUrl}&retry=${retryStamp}`
    : initialUrl;

  const [clearLoaded, setClearLoaded] = useState(() =>
    isPreviewCached(activePreviewUrl),
  );

  useEffect(() => {
    if (clearLoaded) onClearReady();
  }, [clearLoaded]);

  const shouldFetchClear = !mediaPolicy.economy || userRequestedClear || zoomed;
  const [mountClearImg, setMountClearImg] = useState(clearLoaded);

  useEffect(() => {
    if (!shouldFetchClear) return;
    const delay = isPreviewCached(activePreviewUrl) ? 0 : 90;
    const t = setTimeout(() => setMountClearImg(true), delay);
    return () => clearTimeout(t);
  }, [shouldFetchClear, activePreviewUrl]);

  useEffect(() => {
    if (!clearFailed && !thumbFailed) return;
    const handleOnline = () => {
      setRetryStamp(Date.now());
      setClearFailed(false);
      setThumbFailed(false);
      setMountClearImg(true);
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [clearFailed, thumbFailed]);

  useEffect(() => {
    const el = detailImgRef.current;
    if (el?.complete && el.naturalWidth) {
      setClearLoaded(true);
      cacheDecodedPreview(el);
    }
  }, [mountClearImg, activePreviewUrl]);

  const thumbSrc =
    buildMediaUrl(asset.primary, "thumb", asset.rotation, asset.cover?.revision) +
    (retryStamp ? `&retry=${retryStamp}` : "");

  return (
    <>
      <div
        ref={frameBoxRef}
        className="viewer-image-frame"
        role="img"
        aria-label={asset.name}
        data-image-width={dims.width}
        data-image-height={dims.height}
      >
        {!thumbFailed && (
          <img
            className="viewer-image-placeholder"
            style={rotationCss}
            src={thumbSrc}
            alt=""
            aria-hidden="true"
            decoding="async"
            draggable={false}
            onError={() => setThumbFailed(true)}
          />
        )}
        {mountClearImg && (
          <img
            ref={detailImgRef}
            className={`viewer-image-detail ${clearLoaded ? "is-ready" : ""}`}
            style={rotationCss}
            src={activePreviewUrl}
            alt=""
            aria-hidden="true"
            decoding="async"
            fetchPriority="high"
            draggable={false}
            onLoad={async (e) => {
              const target = e.currentTarget;
              try {
                await target.decode();
              } catch {
                /* Decoded enough to display */
              }
              if (detailImgRef.current !== target) return;
              cacheDecodedPreview(target);
              setClearLoaded(true);
              setClearFailed(false);
            }}
            onError={() => {
              setClearFailed(true);
              setClearLoaded(false);
            }}
          />
        )}
      </div>

      <MotionPresence present={!clearLoaded && mountClearImg && !clearFailed} variant="panel">
        {!clearLoaded && mountClearImg && !clearFailed && (
          <div className="viewer-image-loading" role="status">
            <LoaderCircle size={15} className="spin" />
            <span>正在加载清晰图</span>
          </div>
        )}
      </MotionPresence>

      <MotionPresence
        present={!clearLoaded && (clearFailed || !shouldFetchClear || thumbFailed)}
        variant="panel"
      >
        {!clearLoaded && (clearFailed || !shouldFetchClear || thumbFailed) && (
          <div className="viewer-quality-action">
            <button
              type="button"
              disabled={!!asset.deletionPending}
              onClick={() => {
                setUserRequestedClear(true);
                setMountClearImg(true);
                if (clearFailed || thumbFailed) setRetryStamp(Date.now());
                setClearFailed(false);
                setThumbFailed(false);
              }}
            >
              {clearFailed || thumbFailed ? (
                <>
                  <RefreshCw size={14} />
                  <span>重新加载</span>
                </>
              ) : (
                "载入清晰图"
              )}
            </button>
          </div>
        )}
      </MotionPresence>
    </>
  );
}

// ============================================================================
// 3. 7-Frame Timeline Strip for Cover / Live Photo Key Frame Selection
// ============================================================================

function StripFrameThumb({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <ImageIcon size={17} />
  ) : (
    <img
      src={url}
      alt=""
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

export function FrameTimelineStrip({
  asset,
  time,
  duration,
  locked,
  onSeek,
}: {
  asset: CatalogAsset;
  time: number;
  duration: number;
  locked: boolean;
  onSeek: (targetSeconds: number) => void;
}) {
  const fps = (asset.kind === "live" ? asset.motionFrameRate : asset.frameRate) || 30;
  const maxEnd = Math.max(0, duration - 0.5 / fps);
  const motionHash = asset.kind === "live" ? asset.motion! : asset.primary;
  const timestamps = Array.from({ length: 7 }, (_, idx) => (maxEnd * idx) / 6);
  const playheadPercent = maxEnd ? Math.min(100, (time / maxEnd) * 100) : 0;

  return (
    <div className="frame-strip" role="group" aria-label="缩略帧时间轴">
      {timestamps.map((ts, idx) => {
        const frameSrc = buildFramePreviewUrl(
          asset.id,
          asset.primary,
          motionHash,
          ts,
          asset.rotation || 0,
          "thumb",
        );
        return (
          <button
            type="button"
            key={idx}
            disabled={locked || !duration}
            aria-label={`选择 ${formatDurationClock(ts)} 的帧`}
            aria-pressed={idx === Math.round((playheadPercent / 100) * 6)}
            title={`${ts.toFixed(3)} 秒`}
            onClick={() => onSeek(ts)}
          >
            {duration > 0 && <StripFrameThumb key={frameSrc} url={frameSrc} />}
          </button>
        );
      })}
      {duration > 0 && (
        <span
          className="frame-strip-position"
          style={{ left: `${playheadPercent}%` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

// ============================================================================
// 4. Custom HTML5 Video & Live Photo Motion Player
// ============================================================================

let savedVolume = 1;
let savedMuted = false;

type WebkitFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

export const PLAYER_SKIP_SECONDS = 5;

export interface FramePlayheadState {
  time: number;
  duration: number;
  ready: boolean;
}

export function StageVideoPlayer({
  asset,
  live = false,
  rotationDelta = 0,
  locked,
  onToggleChrome,
  onActivity,
  onPlaybackChange,
  onEnded,
  onPrevious,
  onNext,
  onClose,
  framePicker,
}: {
  asset: CatalogAsset;
  live?: boolean;
  rotationDelta?: number;
  locked: boolean;
  onToggleChrome: () => void;
  onActivity: () => void;
  onPlaybackChange: (playing: boolean) => void;
  onEnded?: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
  framePicker?: {
    initialTime: number;
    onChange: (frame: FramePlayheadState) => void;
  };
}) {
  const isPresent = useIsPresent();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageBoxRef = useRef<HTMLDivElement>(null);
  const rotationCss = useQuarterTurnBoxStyle(stageBoxRef, rotationDelta);

  const [started, setStarted] = useState(live || !!framePicker);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(live || !!framePicker);
  const [errorMsg, setErrorMsg] = useState("");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [bufferedRanges, setBufferedRanges] = useState<{ start: number; end: number }[]>(
    [],
  );
  const [volume, setVolume] = useState(savedVolume);
  const [muted, setMuted] = useState(savedMuted);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [supportsPip, setSupportsPip] = useState(false);

  const resumeOnRelease = useRef(false);
  const activeScrubValue = useRef<number | null>(null);
  const pendingPreviewTime = useRef<number | null>(null);
  const seekRafId = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const ignoreNextClick = useRef(false);
  const isMounted = useRef(true);
  const lastObservedMediaTime = useRef<number | undefined>(undefined);
  const measuredFrameInterval = useRef<number | undefined>(undefined);

  const callbacksRef = useRef({
    onPlaybackChange,
    onEnded,
    onFrame: framePicker?.onChange,
  });
  callbacksRef.current = {
    onPlaybackChange,
    onEnded,
    onFrame: framePicker?.onChange,
  };

  const playUrl = buildMediaUrl(
    live ? asset.motion! : asset.primary,
    "play",
    live ? asset.motionRotation : asset.rotation,
  );
  const nominalFps = (live ? asset.motionFrameRate : asset.frameRate) || 30;

  function emitFrameState() {
    const el = videoRef.current;
    if (!el || !callbacksRef.current.onFrame) return;
    const totalLen = Number.isFinite(el.duration) ? el.duration : 0;
    const observed = lastObservedMediaTime.current;
    const effectiveNow =
      !el.seeking &&
      observed !== undefined &&
      Math.abs(observed - el.currentTime) < 1 / nominalFps
        ? observed
        : el.currentTime;
    callbacksRef.current.onFrame({
      time: Math.max(0, Math.min(Math.max(0, totalLen - 0.5 / nominalFps), effectiveNow)),
      duration: totalLen,
      ready: el.paused && !el.seeking && el.readyState >= 2,
    });
  }

  useEffect(() => {
    const el = videoRef.current;
    isMounted.current = true;
    if (el) {
      el.volume = savedVolume;
      el.muted = savedMuted;
    }

    let vfcHandle = 0;
    const onVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (
        lastObservedMediaTime.current !== undefined &&
        !el?.paused &&
        !el?.seeking
      ) {
        const dt = meta.mediaTime - lastObservedMediaTime.current;
        if (dt > 0 && dt < 0.2) measuredFrameInterval.current = dt;
      }
      lastObservedMediaTime.current = meta.mediaTime;
      emitFrameState();
      vfcHandle = el?.requestVideoFrameCallback(onVideoFrame) || 0;
    };
    if (el?.requestVideoFrameCallback) {
      vfcHandle = el.requestVideoFrameCallback(onVideoFrame);
    }

    const onVisibility = () => {
      if (document.hidden && document.pictureInPictureElement !== el) {
        el?.pause();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    if (framePicker && el) {
      el.src = playUrl;
      el.load();
    } else if (live) {
      void startPlayback();
    }

    return () => {
      isMounted.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      if (vfcHandle) el?.cancelVideoFrameCallback(vfcHandle);
      cancelAnimationFrame(seekRafId.current);
      if (document.pictureInPictureElement === el) {
        void document.exitPictureInPicture().catch(() => {});
      }
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      callbacksRef.current.onPlaybackChange(false);
    };
  }, []);

  useEffect(() => {
    if (locked || !isPresent) videoRef.current?.pause();
  }, [locked, isPresent]);

  async function startPlayback() {
    const el = videoRef.current;
    if (!el || locked || !isPresent) return;
    if (!el.getAttribute("src")) {
      el.src = playUrl;
      el.load();
    }
    setStarted(true);
    setBuffering(true);
    setErrorMsg("");
    try {
      await el.play();
    } catch (err) {
      if (!isMounted.current || (err as DOMException).name === "AbortError") return;
      setBuffering(false);
      setErrorMsg(
        (err as DOMException).name === "NotAllowedError"
          ? "点按播放以继续"
          : "视频加载失败，请重试",
      );
    }
  }

  function togglePlayPause() {
    if (videoRef.current?.paused) void startPlayback();
    else videoRef.current?.pause();
    onActivity();
  }

  function finishScrub() {
    const val = activeScrubValue.current;
    const el = videoRef.current;
    if (val === null || !el) return;
    cancelAnimationFrame(seekRafId.current);
    seekRafId.current = 0;
    pendingPreviewTime.current = null;
    el.currentTime = val;
    setCurrentTime(val);
    setScrubTime(null);
    activeScrubValue.current = null;
    if (resumeOnRelease.current) void startPlayback();
    resumeOnRelease.current = false;
    onActivity();
  }

  function schedulePreviewSeek() {
    if (seekRafId.current || videoRef.current?.seeking) return;
    seekRafId.current = requestAnimationFrame(() => {
      seekRafId.current = 0;
      const el = videoRef.current;
      const target = pendingPreviewTime.current;
      if (!el || el.seeking || target === null) return;
      pendingPreviewTime.current = null;
      el.currentTime = target;
    });
  }

  function stepSingleFrame(dir: -1 | 1) {
    const el = videoRef.current;
    if (!el || locked || !duration) return;
    el.pause();
    resumeOnRelease.current = false;
    activeScrubValue.current = null;
    pendingPreviewTime.current = null;
    cancelAnimationFrame(seekRafId.current);
    seekRafId.current = 0;
    setScrubTime(null);

    const catalogRate = live ? asset.motionFrameRate : asset.frameRate;
    const validRate =
      Number.isFinite(catalogRate) && catalogRate && catalogRate > 0 ? catalogRate : 0;
    const stepDt = validRate
      ? 1 / validRate
      : measuredFrameInterval.current || 1 / 30;
    const baseTime = validRate
      ? Math.floor((el.currentTime + stepDt * 0.01) / stepDt) * stepDt
      : !el.seeking &&
          lastObservedMediaTime.current !== undefined &&
          Math.abs(lastObservedMediaTime.current - el.currentTime) < stepDt
        ? lastObservedMediaTime.current
        : el.currentTime;

    const target = Math.max(
      0,
      Math.min(Math.max(0, duration - stepDt / 2), baseTime + (dir + 0.1) * stepDt),
    );
    el.currentTime = target;
    setCurrentTime(target);
    onActivity();
  }

  async function toggleFullscreen() {
    const el = videoRef.current as WebkitFullscreenVideo | null;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stageBoxRef.current?.requestFullscreen)
        await stageBoxRef.current.requestFullscreen();
      else el?.webkitEnterFullscreen?.();
    } catch {
      setErrorMsg("暂时无法进入全屏");
    }
  }

  async function togglePip() {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      setErrorMsg("暂时无法开启画中画");
    }
  }

  const effectiveTime = scrubTime ?? currentTime;
  const effectiveDuration =
    duration ||
    (!live && Number.isFinite(asset.duration) ? Math.max(0, asset.duration || 0) : 0);
  const playedRatio = effectiveDuration
    ? Math.min(100, (effectiveTime / effectiveDuration) * 100)
    : 0;

  return (
    <div
      ref={stageBoxRef}
      className={`aura-player ${playing ? "is-playing" : ""} ${started ? "is-started" : ""} ${framePicker ? "is-frame-picker" : ""}`}
    >
      <video
        ref={videoRef}
        className="player-video"
        style={rotationCss}
        playsInline
        preload={framePicker ? "auto" : "none"}
        poster={buildMediaUrl(
          asset.primary,
          "thumb",
          asset.rotation,
          asset.cover?.revision,
        )}
        aria-label={live ? `${asset.name} · 实况` : asset.name}
        onPointerDown={(e) => {
          if (e.pointerType === "touch" && !locked && !framePicker) {
            touchStart.current = { x: e.clientX, y: e.clientY };
            ignoreNextClick.current = false;
          }
        }}
        onPointerMove={(e) => {
          if (
            touchStart.current &&
            Math.hypot(e.clientX - touchStart.current.x, e.clientY - touchStart.current.y) > 8
          ) {
            ignoreNextClick.current = true;
          }
        }}
        onPointerUp={(e) => {
          const start = touchStart.current;
          touchStart.current = undefined;
          if (!start || locked) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            if (dx < 0) onNext();
            else onPrevious();
          } else if (dy > 110 && dy > Math.abs(dx) * 1.5) {
            onClose();
          }
        }}
        onPointerCancel={() => {
          touchStart.current = undefined;
          ignoreNextClick.current = true;
        }}
        onClick={() => {
          if (ignoreNextClick.current) {
            ignoreNextClick.current = false;
            return;
          }
          if (!started || !playing) togglePlayPause();
          else onToggleChrome();
        }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          const len = Number.isFinite(el.duration) ? el.duration : 0;
          setDuration(len);
          setSupportsPip(
            !!document.pictureInPictureEnabled && !el.disablePictureInPicture,
          );
          if (framePicker) {
            el.currentTime = Math.max(
              0,
              Math.min(Math.max(0, len - 0.5 / nominalFps), framePicker.initialTime),
            );
          }
          emitFrameState();
        }}
        onLoadedData={() => {
          if (framePicker) setBuffering(false);
          emitFrameState();
        }}
        onTimeUpdate={(e) => {
          setCurrentTime(e.currentTarget.currentTime);
          emitFrameState();
        }}
        onProgress={(e) => {
          const el = e.currentTarget;
          const list: { start: number; end: number }[] = [];
          for (let i = 0; i < el.buffered.length; i++) {
            list.push({ start: el.buffered.start(i), end: el.buffered.end(i) });
          }
          setBufferedRanges(list);
        }}
        onPlay={() => {
          setPlaying(true);
          callbacksRef.current.onPlaybackChange(true);
          emitFrameState();
        }}
        onPause={() => {
          if (isMounted.current) {
            setPlaying(false);
            setBuffering(false);
            callbacksRef.current.onPlaybackChange(false);
            emitFrameState();
          }
        }}
        onPlaying={() => setBuffering(false)}
        onWaiting={() => setBuffering(true)}
        onSeeking={() => {
          setBuffering(true);
          emitFrameState();
        }}
        onSeeked={() => {
          setBuffering(false);
          schedulePreviewSeek();
          emitFrameState();
        }}
        onEnded={() => {
          setPlaying(false);
          callbacksRef.current.onPlaybackChange(false);
          callbacksRef.current.onEnded?.();
        }}
        onVolumeChange={(e) => {
          savedVolume = e.currentTarget.volume;
          savedMuted = e.currentTarget.muted;
          setVolume(savedVolume);
          setMuted(savedMuted);
        }}
        onError={() => {
          if (isMounted.current) {
            setErrorMsg("视频加载失败，请重试");
            setBuffering(false);
            setPlaying(false);
            callbacksRef.current.onPlaybackChange(false);
            callbacksRef.current.onFrame?.({ time: 0, duration: 0, ready: false });
          }
        }}
      />

      <MotionPresence present={!framePicker && !playing && !buffering && !errorMsg} variant="panel">
        {!framePicker && !playing && !buffering && !errorMsg && (
          <button
            type="button"
            className="player-big-play"
            disabled={locked}
            aria-label={
              currentTime >= duration && duration > 0 ? "重新播放" : "播放视频"
            }
            onClick={togglePlayPause}
          >
            <Play size={30} fill="currentColor" strokeWidth={1} />
          </button>
        )}
      </MotionPresence>

      <MotionPresence present={buffering} variant="panel">
        {buffering && (
          <div className="player-waiting" role="status" aria-label="视频缓冲中">
            <LoaderCircle className="spin" size={28} />
          </div>
        )}
      </MotionPresence>

      <MotionPresence present={!!errorMsg} variant="panel">
        {errorMsg && (
          <div className="player-error" role="status">
            <span>{errorMsg}</span>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                videoRef.current?.removeAttribute("src");
                void startPlayback();
              }}
            >
              重试
            </button>
          </div>
        )}
      </MotionPresence>

      <div
        className="player-controls"
        onPointerDown={(e) => {
          e.stopPropagation();
          onActivity();
        }}
        onPointerMove={(e) => e.stopPropagation()}
      >
        <div className="player-seek-row">
          <span className="player-time">{formatDurationClock(effectiveTime)}</span>
          <div
            className="player-seek"
            style={{ "--played": `${playedRatio}%` } as CSSProperties}
          >
            <div className="player-buffered" aria-hidden="true">
              {duration > 0 &&
                bufferedRanges.map((r, idx) => (
                  <i
                    key={idx}
                    style={{
                      left: `${(r.start / duration) * 100}%`,
                      width: `${((r.end - r.start) / duration) * 100}%`,
                    }}
                  />
                ))}
            </div>
            <input
              type="range"
              aria-label={framePicker ? "选帧进度" : "播放进度"}
              aria-valuetext={`${formatDurationClock(effectiveTime)} / ${formatDurationClock(effectiveDuration)}`}
              min="0"
              max={
                framePicker && effectiveDuration
                  ? Math.max(0, effectiveDuration - 0.5 / nominalFps)
                  : effectiveDuration || 1
              }
              step={framePicker ? ".001" : ".1"}
              value={effectiveTime}
              disabled={locked || !duration}
              onPointerDown={() => {
                resumeOnRelease.current =
                  !!videoRef.current && !videoRef.current.paused;
                videoRef.current?.pause();
              }}
              onChange={(e) => {
                const val = Number(e.target.value);
                activeScrubValue.current = val;
                setScrubTime(val);
                pendingPreviewTime.current = val;
                schedulePreviewSeek();
              }}
              onPointerUp={finishScrub}
              onPointerCancel={finishScrub}
              onKeyUp={finishScrub}
              onBlur={finishScrub}
            />
          </div>
          <span
            className="player-time"
            title={started ? "剩余时长" : "视频时长"}
          >
            {started ? "−" : ""}
            {formatDurationClock(
              started ? effectiveDuration - effectiveTime : effectiveDuration,
            )}
          </span>
        </div>

        <div className="player-buttons">
          <div className="player-volume">
            <button
              type="button"
              aria-label={muted || volume === 0 ? "取消静音" : "静音"}
              data-player-mute
              disabled={locked}
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.muted = !videoRef.current.muted;
                }
              }}
            >
              <span key={muted || volume === 0 ? "muted" : "sound"} className="player-state-icon" aria-hidden="true">
                {muted || volume === 0 ? (
                  <VolumeX size={18} />
                ) : (
                  <Volume2 size={18} />
                )}
              </span>
            </button>
            <input
              aria-label="音量"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              disabled={locked}
              onChange={(e) => {
                if (videoRef.current) {
                  videoRef.current.volume = Number(e.target.value);
                  videoRef.current.muted = false;
                }
              }}
            />
          </div>

          <div className="player-transport">
            <button
              type="button"
              className="player-frame-step"
              data-player-previous-frame
              title="上一帧（,）"
              aria-label="上一帧"
              disabled={locked || !duration}
              onClick={() => stepSingleFrame(-1)}
            >
              <StepBack size={16} />
            </button>
            <button
              type="button"
              title={`后退 ${PLAYER_SKIP_SECONDS} 秒`}
              aria-label={`后退 ${PLAYER_SKIP_SECONDS} 秒`}
              disabled={locked || !duration}
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.currentTime = Math.max(
                    0,
                    videoRef.current.currentTime - PLAYER_SKIP_SECONDS,
                  );
                }
              }}
            >
              <SkipSecondsGlyph />
            </button>
            <button
              type="button"
              className="player-toggle"
              data-player-toggle
              aria-label={playing ? "暂停" : "播放"}
              title="播放 / 暂停（空格）"
              disabled={locked}
              onClick={togglePlayPause}
            >
              <span key={playing ? "pause" : "play"} className="player-state-icon" aria-hidden="true">
                {playing ? (
                  <Pause size={22} fill="currentColor" />
                ) : (
                  <Play size={22} fill="currentColor" />
                )}
              </span>
            </button>
            <button
              type="button"
              title={`前进 ${PLAYER_SKIP_SECONDS} 秒`}
              aria-label={`前进 ${PLAYER_SKIP_SECONDS} 秒`}
              disabled={locked || !duration}
              onClick={() => {
                if (videoRef.current) {
                  videoRef.current.currentTime = Math.min(
                    duration,
                    videoRef.current.currentTime + PLAYER_SKIP_SECONDS,
                  );
                }
              }}
            >
              <SkipSecondsGlyph forward />
            </button>
            <button
              type="button"
              className="player-frame-step"
              data-player-next-frame
              title="下一帧（.）"
              aria-label="下一帧"
              disabled={locked || !duration}
              onClick={() => stepSingleFrame(1)}
            >
              <StepForward size={16} />
            </button>
          </div>

          <div className="player-options">
            <button
              type="button"
              className="player-speed"
              aria-label={`播放速度 ${playbackSpeed} 倍`}
              title="切换播放速度"
              disabled={locked}
              onClick={() => {
                const steps = [0.5, 1, 1.5, 2];
                const next = steps[(steps.indexOf(playbackSpeed) + 1) % steps.length];
                setPlaybackSpeed(next);
                if (videoRef.current) videoRef.current.playbackRate = next;
              }}
            >
              <span key={playbackSpeed} className="player-state-icon">{playbackSpeed}×</span>
            </button>
            {supportsPip && (
              <button
                type="button"
                title="画中画"
                aria-label="画中画"
                disabled={locked}
                onClick={() => void togglePip()}
              >
                <PictureInPicture2 size={18} />
              </button>
            )}
            <button
              type="button"
              title="全屏播放（F）"
              aria-label="全屏播放"
              data-player-fullscreen
              disabled={locked}
              onClick={() => void toggleFullscreen()}
            >
              <Maximize size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
