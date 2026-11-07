import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { SimilarityScoreRange } from "../core/types";

export function SimilarityScoreFilter({ range, disabled, onChange }: {
  range: SimilarityScoreRange;
  disabled?: boolean;
  onChange: (range: SimilarityScoreRange) => void;
}) {
  const [percent, setPercent] = useState<SimilarityScoreRange>([range[0] * 100, range[1] * 100]);
  const percentRef = useRef(percent);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; bound: 0 | 1; offset: number } | null>(null);

  useEffect(() => {
    const next: SimilarityScoreRange = [Math.round(range[0] * 1000) / 10, Math.round(range[1] * 1000) / 10];
    percentRef.current = next;
    setPercent(next);
  }, [range[0], range[1]]);

  function moveBound(bound: 0 | 1, value: number) {
    const next: SimilarityScoreRange = [...percentRef.current];
    next[bound] = Math.max(bound === 0 ? 70 : next[0],
      Math.min(bound === 0 ? next[1] : 100, Math.round(value * 10) / 10));
    percentRef.current = next;
    setPercent(next);
  }

  function movePointer(clientX: number) {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = trackRef.current!.getBoundingClientRect();
    moveBound(drag.bound, 70 + (clientX - drag.offset - rect.left) / rect.width * 30);
  }

  function commitRange() {
    const next: SimilarityScoreRange = [percentRef.current[0] / 100, percentRef.current[1] / 100];
    if (next[0] !== range[0] || next[1] !== range[1]) onChange(next);
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>, bound: 0 | 1) {
    if (disabled || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const delta = event.shiftKey ? 1 : .1;
    const value = percentRef.current[bound];
    const next = event.key === "ArrowLeft" || event.key === "ArrowDown" ? value - delta :
      event.key === "ArrowRight" || event.key === "ArrowUp" ? value + delta :
      event.key === "Home" ? (bound === 0 ? 70 : percentRef.current[0]) :
      event.key === "End" ? (bound === 0 ? percentRef.current[1] : 100) : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    moveBound(bound, next);
  }

  const position = (value: number) => (value - 70) / 30 * 100;

  return (
    <div className="similar-score-filter" role="group" aria-label="特征相似度范围"
      aria-disabled={disabled || undefined}>
      <span className="similar-score-label">特征相似度</span>
      <output className="similar-score-value" aria-label="相似度下限">{percent[0]}%</output>
      <div className="similar-score-track" ref={trackRef}
        style={{ "--score-start": `${position(percent[0])}%`, "--score-end": `${position(percent[1])}%` } as CSSProperties}
        onPointerDown={event => {
          if (disabled || event.button !== 0 || dragRef.current) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const value = 70 + (event.clientX - rect.left) / rect.width * 30;
          const target = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("[data-bound]") : null;
          // Choose by distance because the two thumb hit areas can overlap in narrow ranges.
          const lowerDistance = Math.abs(value - percentRef.current[0]);
          const upperDistance = Math.abs(value - percentRef.current[1]);
          const bound: 0 | 1 = lowerDistance === upperDistance ? (value <= percentRef.current[0] ? 0 : 1) :
            lowerDistance < upperDistance ? 0 : 1;
          const offset = target ? event.clientX - rect.left - position(percentRef.current[bound]) / 100 * rect.width : 0;
          dragRef.current = { pointerId: event.pointerId, bound, offset };
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-bound="${bound}"]`)?.focus({ preventScroll: true });
          movePointer(event.clientX);
        }}
        onPointerMove={event => { if (dragRef.current?.pointerId === event.pointerId) movePointer(event.clientX); }}
        onPointerUp={event => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          movePointer(event.clientX);
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          commitRange();
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          percentRef.current = [Math.round(range[0] * 1000) / 10, Math.round(range[1] * 1000) / 10];
          setPercent(percentRef.current);
        }}>
        <span className="similar-score-rail" aria-hidden="true" />
        <span className="similar-score-selection" aria-hidden="true" />
        {([0, 1] as const).map(bound => (
          <button key={bound} className="similar-score-thumb" type="button" role="slider"
            data-bound={bound} disabled={disabled} style={{ left: `${position(percent[bound])}%` }}
            aria-label={bound === 0 ? "最低特征相似度" : "最高特征相似度"}
            aria-valuemin={bound === 0 ? 70 : percent[0]} aria-valuemax={bound === 0 ? percent[1] : 100}
            aria-valuenow={percent[bound]} aria-valuetext={`${percent[bound]}%`}
            onKeyDown={event => handleKey(event, bound)}
            onKeyUp={event => {
              if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.stopPropagation();
                commitRange();
              }
            }} onBlur={() => { if (!dragRef.current) commitRange(); }} />
        ))}
      </div>
      <output className="similar-score-value" aria-label="相似度上限">{percent[1]}%</output>
    </div>
  );
}
