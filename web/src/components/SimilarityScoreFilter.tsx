import { useEffect, useState } from "react";

export function SimilarityScoreFilter({ minScore, disabled, onChange }: {
  minScore: number | null;
  disabled?: boolean;
  onChange: (score: number | null) => void;
}) {
  const [percent, setPercent] = useState("");

  useEffect(() => {
    setPercent(minScore === null ? "" : String(Math.round(minScore * 1000) / 10));
  }, [minScore]);

  return (
    <form className="similar-score-filter" onSubmit={event => {
      event.preventDefault();
      if (disabled) return;
      const value = percent.trim() === "" ? null : Number(percent);
      if (value !== null && (!Number.isFinite(value) || value < 70 || value > 100)) return;
      onChange(value === null ? null : value / 100);
    }}>
      <label>
        <span>特征相似度大于</span>
        <span className="similar-score-input">
          <input type="number" min="70" max="100" step="0.1" placeholder="不限"
            aria-label="特征相似度阈值（百分比）" value={percent} disabled={disabled}
            onChange={event => setPercent(event.target.value)} />
          <span>%</span>
        </span>
      </label>
      <button className="btn" type="submit" disabled={disabled}>筛选</button>
      <button className="btn" type="button" disabled={disabled || (minScore === null && percent === "")}
        onClick={() => { setPercent(""); onChange(null); }}>重置</button>
    </form>
  );
}
