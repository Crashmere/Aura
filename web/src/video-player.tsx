import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LoaderCircle, Maximize, Pause, PictureInPicture2, Play, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import { media, timestamp, type Asset } from "./api";
import { useRotationPreview } from "./rotation-preview";
let volumePreference = 1;
let mutePreference = false;
type SafariVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
export const VIDEO_SKIP_SECONDS = 5;

function SkipIcon({ forward = false }: { forward?: boolean }) {
  return <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <g transform={forward ? "translate(24 0) scale(-1 1)" : undefined}>
      <path d="M3.3 7.8a9.5 9.5 0 1 1-.7 7.2" />
      <path d="M3 3.5V8h4.5" />
    </g>
    <path d="M14.2 8.2h-4.1l-.4 3.6c.6-.5 1.2-.7 2-.7 1.6 0 2.7.9 2.7 2.4s-1.1 2.5-2.6 2.5c-1 0-1.8-.4-2.2-1.1" strokeWidth="1.5" />
  </svg>;
}

export function VideoPlayer({ asset, live = false, rotationPreview = 0, locked, toggleChrome, activity, onPlayback, onEnded, previous, next, close }: {
  asset: Asset; live?: boolean; rotationPreview?: number; locked: boolean; toggleChrome: () => void; activity: () => void;
  onPlayback: (playing: boolean) => void; onEnded?: () => void; previous: () => void; next: () => void; close: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const rotationStyle = useRotationPreview(container, rotationPreview);
  const [started, setStarted] = useState(live);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(live);
  const [failed, setFailed] = useState("");
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [seeking, setSeeking] = useState<number | null>(null);
  const [buffered, setBuffered] = useState<{ start: number; end: number }[]>([]);
  const [volume, setVolume] = useState(volumePreference);
  const [muted, setMuted] = useState(mutePreference);
  const [speed, setSpeed] = useState(1);
  const [pip, setPip] = useState(false);
  const resumeAfterSeek = useRef(false);
  const seekingValue = useRef<number | null>(null);
  const previewSeek = useRef<number | null>(null);
  const seekFrame = useRef(0);
  const swipe = useRef<{ x: number; y: number } | undefined>(undefined);
  const suppressClick = useRef(false);
  const mounted = useRef(true);
  const frameTime = useRef<number | undefined>(undefined);
  const observedFrameDuration = useRef<number | undefined>(undefined);
  const callbacks = useRef({ onPlayback, onEnded });
  callbacks.current = { onPlayback, onEnded };
  const source = media(live ? asset.motion! : asset.primary, "play", live ? asset.motionRotation : asset.rotation);
  useEffect(() => {
    const element = video.current;
    mounted.current = true;
    if (element) { element.volume = volumePreference; element.muted = mutePreference; }
    let frameCallback = 0;
    const observeFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (frameTime.current !== undefined && !element?.paused && !element?.seeking) {
        const delta = metadata.mediaTime - frameTime.current;
        if (delta > 0 && delta < .2) observedFrameDuration.current = delta;
      }
      frameTime.current = metadata.mediaTime;
      frameCallback = element?.requestVideoFrameCallback(observeFrame) || 0;
    };
    if (element?.requestVideoFrameCallback) frameCallback = element.requestVideoFrameCallback(observeFrame);
    const visibility = () => { if (document.hidden && document.pictureInPictureElement !== element) element?.pause(); };
    document.addEventListener("visibilitychange", visibility);
    if (live) void play();
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", visibility);
      if (frameCallback) element?.cancelVideoFrameCallback(frameCallback);
      cancelAnimationFrame(seekFrame.current);
      if (document.pictureInPictureElement === element) void document.exitPictureInPicture().catch(() => {});
      if (element) { element.pause(); element.removeAttribute("src"); element.load(); }
      callbacks.current.onPlayback(false);
    };
  }, []);
  useEffect(() => { if (locked) video.current?.pause(); }, [locked]);
  async function play() {
    const element = video.current;
    if (!element || locked) return;
    if (!element.getAttribute("src")) { element.src = source; element.load(); }
    setStarted(true); setWaiting(true); setFailed("");
    try { await element.play(); }
    catch (error) {
      if (!mounted.current || (error as DOMException).name === "AbortError") return;
      setWaiting(false);
      setFailed((error as DOMException).name === "NotAllowedError" ? "点按播放以继续" : "视频加载失败，请重试");
    }
  }
  function togglePlay() {
    if (video.current?.paused) void play(); else video.current?.pause();
    activity();
  }
  function commitSeek() {
    const value = seekingValue.current;
    const element = video.current;
    if (value === null || !element) return;
    cancelAnimationFrame(seekFrame.current); seekFrame.current = 0; previewSeek.current = null;
    element.currentTime = value;
    setTime(value); setSeeking(null); seekingValue.current = null;
    if (resumeAfterSeek.current) void play();
    resumeAfterSeek.current = false;
    activity();
  }
  function queuePreviewSeek() {
    if (seekFrame.current || video.current?.seeking) return;
    seekFrame.current = requestAnimationFrame(() => {
      seekFrame.current = 0;
      const element = video.current;
      const value = previewSeek.current;
      if (!element || element.seeking || value === null) return;
      previewSeek.current = null;
      element.currentTime = value;
    });
  }
  function stepFrame(direction: -1 | 1) {
    const element = video.current;
    if (!element || locked || !duration) return;
    element.pause();
    resumeAfterSeek.current = false;
    seekingValue.current = null;
    previewSeek.current = null;
    cancelAnimationFrame(seekFrame.current); seekFrame.current = 0;
    setSeeking(null);
    const rate = !live && Number.isFinite(asset.frameRate) && asset.frameRate && asset.frameRate > 0 ? asset.frameRate : 0;
    const interval = rate ? 1 / rate : observedFrameDuration.current || 1 / 30;
    const current = rate ? Math.floor((element.currentTime + interval * .01) / interval) * interval :
      !element.seeking && frameTime.current !== undefined && Math.abs(frameTime.current - element.currentTime) < interval ? frameTime.current : element.currentTime;
    // Seek inside the target frame; exact boundary rounding can show its predecessor.
    const target = Math.max(0, Math.min(Math.max(0, duration - interval / 2), current + (direction + .1) * interval));
    element.currentTime = target;
    setTime(target);
    activity();
  }
  async function fullscreen() {
    const element = video.current as SafariVideo | null;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (container.current?.requestFullscreen) await container.current.requestFullscreen();
      else element?.webkitEnterFullscreen?.();
    } catch { setFailed("暂时无法进入全屏"); }
  }
  async function pictureInPicture() {
    const element = video.current;
    if (!element) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await element.requestPictureInPicture();
    } catch { setFailed("暂时无法开启画中画"); }
  }
  const shownTime = seeking ?? time;
  const shownDuration = duration || (!live && Number.isFinite(asset.duration) ? Math.max(0, asset.duration || 0) : 0);
  const progress = shownDuration ? Math.min(100, shownTime / shownDuration * 100) : 0;
  return <div ref={container} className={`aura-player ${playing ? "is-playing" : ""} ${started ? "is-started" : ""}`}>
    <video ref={video} className="player-video" style={rotationStyle} playsInline preload="none" poster={media(asset.primary, "thumb", asset.rotation)} aria-label={live ? `${asset.name} · 实况` : asset.name}
      onPointerDown={event => { if (event.pointerType === "touch" && !locked) { swipe.current = { x: event.clientX, y: event.clientY }; suppressClick.current = false; } }}
      onPointerMove={event => { if (swipe.current && Math.hypot(event.clientX - swipe.current.x, event.clientY - swipe.current.y) > 8) suppressClick.current = true; }}
      onPointerUp={event => {
        const start = swipe.current; swipe.current = undefined;
        if (!start || locked) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) { if (dx < 0) next(); else previous(); }
        else if (dy > 110 && dy > Math.abs(dx) * 1.5) close();
      }}
      onPointerCancel={() => { swipe.current = undefined; suppressClick.current = true; }}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (!started || !playing) togglePlay(); else toggleChrome(); }}
      onLoadedMetadata={event => { setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0); setPip(!!document.pictureInPictureEnabled && !event.currentTarget.disablePictureInPicture); }}
      onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
      onProgress={event => { const element = event.currentTarget; const ranges = []; for (let i = 0; i < element.buffered.length; i++) ranges.push({ start: element.buffered.start(i), end: element.buffered.end(i) }); setBuffered(ranges); }}
      onPlay={() => { setPlaying(true); callbacks.current.onPlayback(true); }}
      onPause={() => { if (mounted.current) { setPlaying(false); setWaiting(false); callbacks.current.onPlayback(false); } }}
      onPlaying={() => setWaiting(false)} onWaiting={() => setWaiting(true)} onSeeking={() => setWaiting(true)} onSeeked={() => { setWaiting(false); queuePreviewSeek(); }}
      onEnded={() => { setPlaying(false); callbacks.current.onPlayback(false); callbacks.current.onEnded?.(); }}
      onVolumeChange={event => { volumePreference = event.currentTarget.volume; mutePreference = event.currentTarget.muted; setVolume(volumePreference); setMuted(mutePreference); }}
      onError={() => { if (mounted.current) { setFailed("视频加载失败，请重试"); setWaiting(false); setPlaying(false); callbacks.current.onPlayback(false); } }} />
    {!playing && !waiting && !failed && <button className="player-big-play" disabled={locked} aria-label={time >= duration && duration > 0 ? "重新播放" : "播放视频"} onClick={togglePlay}><Play size={32} fill="currentColor" strokeWidth={1} /></button>}
    {waiting && <div className="player-waiting" role="status" aria-label="视频缓冲中"><LoaderCircle className="spin" size={28} /></div>}
    {failed && <div className="player-error" role="status"><span>{failed}</span><button disabled={locked} onClick={() => { video.current?.removeAttribute("src"); void play(); }}>重试</button></div>}
    <div className="player-controls" onPointerDown={event => { event.stopPropagation(); activity(); }} onPointerMove={event => event.stopPropagation()}>
      <div className="player-seek-row">
        <span className="player-time">{timestamp(shownTime)}</span>
        <div className="player-seek" style={{ "--played": `${progress}%` } as CSSProperties}>
          <div className="player-buffered" aria-hidden="true">{duration > 0 && buffered.map((range, index) => <i key={index} style={{ left: `${range.start / duration * 100}%`, width: `${(range.end - range.start) / duration * 100}%` }} />)}</div>
          <input type="range" aria-label="播放进度" aria-valuetext={`${timestamp(shownTime)} / ${timestamp(shownDuration)}`} min="0" max={shownDuration || 1} step="0.1" value={shownTime} disabled={locked || !duration}
            onPointerDown={() => { resumeAfterSeek.current = !!video.current && !video.current.paused; video.current?.pause(); }}
            onChange={event => { const value = Number(event.target.value); seekingValue.current = value; setSeeking(value); previewSeek.current = value; queuePreviewSeek(); }}
            onPointerUp={commitSeek} onPointerCancel={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} />
        </div>
        <span className="player-time" title={started ? "剩余时长" : "视频时长"}>{started ? "−" : ""}{timestamp(started ? shownDuration - shownTime : shownDuration)}</span>
      </div>
      <div className="player-buttons">
        <div className="player-volume">
          <button aria-label={muted || volume === 0 ? "取消静音" : "静音"} data-player-mute disabled={locked} onClick={() => { if (video.current) video.current.muted = !video.current.muted; }}>{muted || volume === 0 ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
          <input aria-label="音量" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} disabled={locked} onChange={event => { if (video.current) { video.current.volume = Number(event.target.value); video.current.muted = false; } }} />
        </div>
        <div className="player-transport">
          <button className="player-frame-step" data-player-previous-frame title="上一帧（,）" aria-label="上一帧" disabled={locked || !duration} onClick={() => stepFrame(-1)}><StepBack size={17} /></button>
          <button title={`后退 ${VIDEO_SKIP_SECONDS} 秒`} aria-label={`后退 ${VIDEO_SKIP_SECONDS} 秒`} disabled={locked || !duration} onClick={() => { if (video.current) video.current.currentTime = Math.max(0, video.current.currentTime - VIDEO_SKIP_SECONDS); }}><SkipIcon /></button>
          <button className="player-toggle" data-player-toggle aria-label={playing ? "暂停" : "播放"} title="播放 / 暂停（空格）" disabled={locked} onClick={togglePlay}>{playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}</button>
          <button title={`前进 ${VIDEO_SKIP_SECONDS} 秒`} aria-label={`前进 ${VIDEO_SKIP_SECONDS} 秒`} disabled={locked || !duration} onClick={() => { if (video.current) video.current.currentTime = Math.min(duration, video.current.currentTime + VIDEO_SKIP_SECONDS); }}><SkipIcon forward /></button>
          <button className="player-frame-step" data-player-next-frame title="下一帧（.）" aria-label="下一帧" disabled={locked || !duration} onClick={() => stepFrame(1)}><StepForward size={17} /></button>
        </div>
        <div className="player-options">
          <button className="player-speed" aria-label={`播放速度 ${speed} 倍`} title="切换播放速度" disabled={locked} onClick={() => { const values = [.5, 1, 1.5, 2]; const value = values[(values.indexOf(speed) + 1) % values.length]; setSpeed(value); if (video.current) video.current.playbackRate = value; }}>{speed}×</button>
          {pip && <button title="画中画" aria-label="画中画" disabled={locked} onClick={() => void pictureInPicture()}><PictureInPicture2 size={19} /></button>}
          <button title="全屏播放（F）" aria-label="全屏播放" data-player-fullscreen disabled={locked} onClick={() => void fullscreen()}><Maximize size={19} /></button>
        </div>
      </div>
    </div>
  </div>;
}
