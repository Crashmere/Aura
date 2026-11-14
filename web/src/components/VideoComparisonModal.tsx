import { useEffect, useRef, useState } from "react";
import { Columns2, Layers3, LoaderCircle, Pause, Play, RefreshCw, Volume2, X } from "lucide-react";
import { buildFramePreviewUrl, buildMediaUrl, formatDurationClock } from "../core/client";
import { useIsPresent } from "../core/motion";
import { usePageScrollLock } from "../core/photo-view";
import type { CandidatePair, CatalogAsset } from "../core/types";
import { VideoPlayback, type PlaybackRepresentation } from "../core/video-playback";

function waitForComparisonFrame(element: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      element.removeEventListener("canplay", check);
      element.removeEventListener("seeked", check);
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (element.readyState >= 3 && !element.seeking) finish();
    };
    const abort = () => finish(new DOMException("Playback cancelled", "AbortError"));
    const timeout = window.setTimeout(() => finish(new Error("视频准备超时，请重试")), 100_000);
    element.addEventListener("canplay", check);
    element.addEventListener("seeked", check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}

function comparisonDuration(element: HTMLVideoElement | null, fallback: number): number {
  return element && Number.isFinite(element.duration) ? element.duration : fallback;
}

function useComparisonVideo(asset: CatalogAsset) {
  const ref = useRef<HTMLVideoElement>(null);
  const playback = useRef<VideoPlayback | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<PlaybackRepresentation>(null);
  const [duration, setDuration] = useState(asset.duration || 0);
  useEffect(() => {
    const element = ref.current!;
    setError("");
    const source = new VideoPlayback(element, asset.primary, asset.rotation || 0, {
      onReady: setReady,
      onModeChange: setMode,
      onDescriptor: descriptor => setDuration(descriptor.duration || asset.duration || 0),
      onSwitch: () => setError(""),
      onError: setError,
    });
    playback.current = source;
    void source.prepare().catch((failure: Error) => {
      if (failure.name !== "AbortError" && playback.current === source) setError(failure.message);
    });
    return () => {
      playback.current = null;
      source.destroy();
    };
  }, [asset.primary, asset.rotation]);
  return { ref, playback, ready, error, setError, mode, duration };
}

export function VideoComparisonModal({ left, right, evidence, onClose, onMergePair }: {
  left: CatalogAsset;
  right: CatalogAsset;
  evidence?: CandidatePair;
  onClose: () => void;
  onMergePair?: (left: CatalogAsset, right: CatalogAsset) => void;
}) {
  const isPresent = useIsPresent();
  const first = useComparisonVideo(left);
  const second = useComparisonVideo(right);
  const [playing, setPlaying] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [time, setTime] = useState(0);
  const [audio, setAudio] = useState<"left" | "right" | "none">("none");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preparing, setPreparing] = useState(false);
  const offset = useRef(0);
  const starting = useRef(false);
  const operation = useRef(0);
  const pendingPlay = useRef<AbortController | null>(null);
  const wantsPlayback = useRef(false);
  const active = useRef(isPresent);
  active.current = isPresent;
  usePageScrollLock();

  function pause() {
    operation.current++;
    wantsPlayback.current = false;
    pendingPlay.current?.abort();
    first.ref.current?.pause();
    second.ref.current?.pause();
    first.playback.current?.paused();
    second.playback.current?.paused();
    setPlaying(false);
  }

  useEffect(() => {
    first.ref.current!.muted = audio !== "left";
    second.ref.current!.muted = audio !== "right";
  }, [audio]);

  useEffect(() => {
    if (first.error || second.error) pause();
  }, [first.error, second.error]);

  useEffect(() => {
    if (!isPresent) {
      first.playback.current?.suspend();
      second.playback.current?.suspend();
    }
    const visibility = () => {
      if (document.hidden) pause();
    };
    const key = (event: KeyboardEvent) => {
      if (!active.current || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", key);
    return () => {
      pendingPlay.current?.abort();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", key);
    };
  }, [isPresent, onClose]);

  async function play() {
    if (starting.current || !isPresent || !first.ready || !second.ready) return;
    if (playing) { pause(); return; }
    starting.current = true;
    setPreparing(true);
    const request = ++operation.current;
    const controller = new AbortController();
    pendingPlay.current = controller;
    setError("");
    setNotice("");
    try {
      const durations = [first, second].map(player => comparisonDuration(player.ref.current, player.duration));
      if (completed || [first, second].some((player, index) => {
        const element = player.ref.current!;
        return element.ended || (durations[index] > 0 && element.currentTime >= durations[index] - .01);
      })) {
        // Restart the shared timeline, not just the ended element. Match anchors
        // retain their offset when both sides still have a playable interval.
        let leftStart = Math.max(0, -offset.current);
        let rightStart = Math.max(0, offset.current);
        if (leftStart >= durations[0] - .01 || rightStart >= durations[1] - .01) {
          offset.current = 0;
          leftStart = rightStart = 0;
        }
        first.playback.current!.loadFrame(leftStart);
        second.playback.current!.loadFrame(rightStart);
        setTime(leftStart);
        setCompleted(false);
      }
      // Load both sides while paused so a slow compatibility segment cannot
      // let the original reach its end before comparison playback starts.
      for (const player of [first, second]) {
        const element = player.ref.current!;
        if (element.readyState < 3 || element.seeking) {
          if (player.playback.current!.changingSource) player.playback.current!.loadFrame();
          else player.playback.current!.loadFrame(element.currentTime);
        }
      }
      if ([first, second].some(player => player.ref.current!.readyState < 3 || player.ref.current!.seeking)) {
        await Promise.all([waitForComparisonFrame(first.ref.current!, controller.signal), waitForComparisonFrame(second.ref.current!, controller.signal)]);
      }
      if (request !== operation.current || !active.current) return;
      wantsPlayback.current = true;
      await Promise.all([first.playback.current!.play(), second.playback.current!.play()]);
      if (request !== operation.current || !active.current) {
        first.ref.current?.pause();
        second.ref.current?.pause();
        return;
      }
      setPlaying(true);
    } catch (failure) {
      pause();
      if (failure instanceof Error && failure.name === "NotAllowedError") setNotice("视频已准备，请再点按播放");
      else if (!(failure instanceof Error && failure.name === "AbortError")) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (pendingPlay.current === controller) pendingPlay.current = null;
      starting.current = false;
      setPreparing(false);
    }
  }

  function seek(leftTime: number, rightTime = leftTime + offset.current) {
    pause();
    setCompleted(false);
    leftTime = Math.max(0, Math.min(comparisonDuration(first.ref.current, first.duration) - .001, leftTime));
    rightTime = Math.max(0, Math.min(comparisonDuration(second.ref.current, second.duration) - .001, rightTime));
    offset.current = rightTime - leftTime;
    first.playback.current?.loadFrame(leftTime);
    second.playback.current?.loadFrame(rightTime);
    setTime(leftTime);
  }

  function updateTime() {
    const a = first.ref.current!;
    const b = second.ref.current!;
    setTime(a.currentTime);
    if (!playing || a.seeking || b.seeking || first.playback.current?.changingSource || second.playback.current?.changingSource) return;
    const target = Math.max(0, Math.min(second.duration - .001, a.currentTime + offset.current));
    if (Math.abs(b.currentTime - target) > .3) {
      b.currentTime = target;
      second.playback.current?.seeking();
    }
  }

  const samples = evidence?.samples || [];
  const reversed = evidence?.left === right.id;
  const failed = error || first.error || second.error;
  const blocked = !isPresent || !first.ready || !second.ready || !!failed;
  const pane = (asset: CatalogAsset, player: ReturnType<typeof useComparisonVideo>, side: "left" | "right") => (
    <section className="video-compare-pane">
      <div className="video-compare-picture">
        <video ref={player.ref} playsInline preload="none"
          poster={buildMediaUrl(asset.primary, "thumb", asset.rotation, asset.cover?.revision)}
          onTimeUpdate={side === "left" ? updateTime : undefined}
          onPlay={() => player.playback.current?.played()}
          onPause={() => player.playback.current?.paused()}
          onSeeking={() => player.playback.current?.seeking()}
          onSeeked={() => player.playback.current?.settled()}
          onLoadedData={() => player.playback.current?.settled()}
          onWaiting={() => {
            if (!wantsPlayback.current) return;
            const other = side === "left" ? second : first;
            other.ref.current?.pause();
            other.playback.current?.paused();
          }}
          onCanPlay={() => {
            if (!wantsPlayback.current) return;
            for (const target of [first, second]) {
              if (target.ref.current?.paused) void target.playback.current?.play().catch(failure => {
                pause(); setError(String(failure));
              });
            }
          }}
          onEnded={() => { setCompleted(true); pause(); }}
          onError={() => { if (!player.playback.current?.handleMediaError()) player.setError("视频加载失败"); }} />
      </div>
      <header>
        <strong title={asset.name}>{asset.name}</strong>
        <span>{formatDurationClock(player.duration)} · {asset.width} × {asset.height}</span>
        {player.mode === "compatibility" && <small>兼容模式 · 已转码</small>}
      </header>
    </section>
  );

  return <div className="modal-scrim video-compare-scrim" inert={!isPresent} onClick={onClose}>
    <section className="modal-card video-compare-modal" role="dialog" aria-modal="true" aria-label="视频对比"
      onClick={event => event.stopPropagation()}>
      <header className="modal-header">
        <h2><Columns2 size={18} />视频对比</h2>
        <button className="icon-btn" type="button" aria-label="关闭视频对比" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="modal-body">
        <div className="video-compare-panes">{pane(left, first, "left")}{pane(right, second, "right")}</div>
        <div className="video-compare-controls">
          <button className="btn" type="button" disabled={blocked || preparing} onClick={() => void play()}>
            {preparing ? <LoaderCircle className="spin" size={17} /> : playing ? <Pause size={17} /> : <Play size={17} />}{preparing ? "正在准备" : playing ? "暂停" : completed ? "重新播放" : "同时播放"}
          </button>
          <span className="video-compare-clock">{formatDurationClock(time)} / {formatDurationClock(first.duration)}</span>
          <input type="range" min="0" max={Math.max(0, first.duration - .001)} step=".01" value={time}
            aria-label="联动视频进度" disabled={blocked} onChange={event => seek(Number(event.target.value))} />
          <label className="video-compare-audio"><Volume2 size={16} /><select aria-label="播放哪侧声音" value={audio}
            onChange={event => setAudio(event.target.value as typeof audio)}>
            <option value="left">左侧声音</option><option value="right">右侧声音</option><option value="none">静音</option>
          </select></label>
        </div>
        {notice && <p className="video-similarity-note" role="status">{notice}</p>}
        {failed && <div className="inline-alert" role="alert">{failed}
          <button className="btn" type="button" onClick={() => {
            pause(); setError(""); first.setError(""); second.setError("");
            void Promise.all([first.playback.current?.retry(), second.playback.current?.retry()])
              .catch(failure => setError(String(failure)));
          }}><RefreshCw size={14} />重试</button>
        </div>}
        {(!first.ready || !second.ready) && !failed && <p className="loading-inline"><LoaderCircle className="spin" size={16} />正在准备视频</p>}
        <div className="video-compare-compatibility">
          <button type="button" onClick={() => first.playback.current?.useCompatibility()}>左侧兼容播放</button>
          <button type="button" onClick={() => second.playback.current?.useCompatibility()}>右侧兼容播放</button>
        </div>
        {!!samples.length && <section className="video-match-evidence">
          <h3>匹配画面 <small>点击联动定位</small></h3>
          <div className="video-match-samples">{samples.map((sample, index) => {
            const a = reversed ? sample.right : sample.left;
            const b = reversed ? sample.left : sample.right;
            return <button type="button" key={index} disabled={blocked} onClick={() => seek(a, b)}>
              <img loading="lazy" src={buildFramePreviewUrl(left.id, left.primary, left.primary, a, left.rotation)} alt="" />
              <img loading="lazy" src={buildFramePreviewUrl(right.id, right.primary, right.primary, b, right.rotation)} alt="" />
              <span>{formatDurationClock(a)} / {formatDurationClock(b)}</span>
            </button>;
          })}</div>
        </section>}
      </div>
      <footer className="modal-footer">
        <span>归并保留全部原件，不比较音轨。</span>
        {onMergePair && left.id !== right.id && <button className="btn btn-primary" type="button"
          disabled={!isPresent || left.deletionPending || right.deletionPending}
          onClick={() => { pause(); onMergePair(left, right); }}><Layers3 size={16} />归并，选择主版本</button>}
      </footer>
    </section>
  </div>;
}
