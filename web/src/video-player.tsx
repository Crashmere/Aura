import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LoaderCircle, Maximize, Pause, PictureInPicture2, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { media, timestamp, type Asset } from "./api";
let volumePreference = 1;
let mutePreference = false;
type SafariVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

export function VideoPlayer({ asset, live = false, locked, toggleChrome, activity, onPlayback, onEnded, previous, next, close }: {
  asset: Asset; live?: boolean; locked: boolean; toggleChrome: () => void; activity: () => void;
  onPlayback: (playing: boolean) => void; onEnded?: () => void; previous: () => void; next: () => void; close: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);
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
  const swipe = useRef<{ x: number; y: number } | undefined>(undefined);
  const suppressClick = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onPlayback, onEnded });
  callbacks.current = { onPlayback, onEnded };
  const source = media(live ? asset.motion! : asset.primary, "play");
  useEffect(() => {
    const element = video.current;
    mounted.current = true;
    if (element) { element.volume = volumePreference; element.muted = mutePreference; }
    const visibility = () => { if (document.hidden && document.pictureInPictureElement !== element) element?.pause(); };
    document.addEventListener("visibilitychange", visibility);
    if (live) void play();
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", visibility);
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
    element.currentTime = value;
    setTime(value); setSeeking(null); seekingValue.current = null;
    if (resumeAfterSeek.current) void play();
    resumeAfterSeek.current = false;
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
  const progress = duration ? Math.min(100, shownTime / duration * 100) : 0;
  return <div ref={container} className={`aura-player ${playing ? "is-playing" : ""} ${started ? "is-started" : ""}`}>
    <video ref={video} className="player-video" playsInline preload="none" poster={media(asset.primary)} aria-label={live ? `${asset.name} · 实况` : asset.name}
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
      onPlaying={() => setWaiting(false)} onWaiting={() => setWaiting(true)} onSeeking={() => setWaiting(true)} onSeeked={() => setWaiting(false)}
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
          <input type="range" aria-label="播放进度" aria-valuetext={`${timestamp(shownTime)} / ${timestamp(duration)}`} min="0" max={duration || 1} step="0.1" value={shownTime} disabled={locked || !duration}
            onPointerDown={() => { resumeAfterSeek.current = !!video.current && !video.current.paused; video.current?.pause(); }}
            onChange={event => { const value = Number(event.target.value); seekingValue.current = value; setSeeking(value); }}
            onPointerUp={commitSeek} onPointerCancel={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} />
        </div>
        <span className="player-time">−{timestamp(duration - shownTime)}</span>
      </div>
      <div className="player-buttons">
        <div className="player-volume">
          <button aria-label={muted || volume === 0 ? "取消静音" : "静音"} data-player-mute disabled={locked} onClick={() => { if (video.current) video.current.muted = !video.current.muted; }}>{muted || volume === 0 ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
          <input aria-label="音量" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} disabled={locked} onChange={event => { if (video.current) { video.current.volume = Number(event.target.value); video.current.muted = false; } }} />
        </div>
        <div className="player-transport">
          <button title="后退 10 秒" aria-label="后退 10 秒" disabled={locked || !duration} onClick={() => { if (video.current) video.current.currentTime = Math.max(0, video.current.currentTime - 10); }}><RotateCcw size={19} /><small>10</small></button>
          <button className="player-toggle" data-player-toggle aria-label={playing ? "暂停" : "播放"} title="播放 / 暂停（空格）" disabled={locked} onClick={togglePlay}>{playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}</button>
          <button title="前进 10 秒" aria-label="前进 10 秒" disabled={locked || !duration} onClick={() => { if (video.current) video.current.currentTime = Math.min(duration, video.current.currentTime + 10); }}><RotateCcw className="player-forward" size={19} /><small>10</small></button>
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
