import React, { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Camera, Check, FileImage, Search, SlidersHorizontal, X } from "lucide-react";
import { formatIsoDayLocal, requestJson } from "../core/client";
import { useIsPresent } from "../core/motion";
import { useCompactViewer, usePageScrollLock } from "../core/photo-view";
import {
  type ActiveFilterChip,
  createEmptyFilters,
  FILTER_ENUM_OPTIONS,
  resolveMonthBounds,
  type FilterParameterKey,
  type LibraryFilterDraft,
} from "../core/workspace";

export function ActiveFiltersBar({
  query,
  from,
  to,
  chips,
  isAlbumOverview,
  onClearSearch,
  onClearDates,
  onClearChip,
  onClearAll,
}: {
  query: string;
  from: string;
  to: string;
  chips: ActiveFilterChip[];
  isAlbumOverview: boolean;
  onClearSearch: () => void;
  onClearDates: () => void;
  onClearChip: (keys: FilterParameterKey[]) => void;
  onClearAll: () => void;
}) {
  return (
    <div className="active-filters-strip" aria-label="当前筛选条件">
      {query && (
        <button type="button" onClick={onClearSearch} aria-label="清除搜索条件">
          <Search size={13} />
          <span>{query}</span>
          <X size={13} />
        </button>
      )}
      {(from || to) && !isAlbumOverview && (
        <button type="button" onClick={onClearDates} aria-label="清除日期条件">
          <CalendarDays size={13} />
          <span>
            {from || "不限"} — {to || "不限"}
          </span>
          <X size={13} />
        </button>
      )}
      {!isAlbumOverview &&
        chips.map((chip) => (
          <button
            type="button"
            key={chip.keys.join("-")}
            aria-label={`清除${chip.text}`}
            onClick={() => onClearChip(chip.keys)}
          >
            <span>{chip.text}</span>
            <X size={13} />
          </button>
        ))}
      <button type="button" className="clear-filters-btn" onClick={onClearAll}>
        清除筛选
      </button>
    </div>
  );
}

export function FilterSheet({
  value,
  anchorRef,
  onApply,
  onClose,
  months = [],
}: {
  value: LibraryFilterDraft;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onApply: (draft: LibraryFilterDraft) => void;
  onClose: () => void;
  months?: { month: string; count: number }[];
}) {
  const compact = useCompactViewer();
  usePageScrollLock();
  const isPresent = useIsPresent();
  const [draft, setDraft] = useState<LibraryFilterDraft>(value);
  const [mbInputs, setMbInputs] = useState({
    minSize: value.minSize ? String(Number((Number(value.minSize) / 1048576).toFixed(6))) : "",
    maxSize: value.maxSize ? String(Number((Number(value.maxSize) / 1048576).toFixed(6))) : "",
  });
  const [equipment, setEquipment] = useState<{
    cameras: string[];
    lenses: string[];
  }>();
  const [equipError, setEquipError] = useState("");
  const [equipLoading, setEquipLoading] = useState(true);
  const [retrySeq, setRetrySeq] = useState(0);

  useEffect(() => {
    let alive = true;
    setEquipLoading(true);
    setEquipError("");
    requestJson<{ cameras: string[]; lenses: string[] }>("filter-options")
      .then((res) => {
        if (alive) setEquipment(res);
      })
      .catch((err) => {
        if (alive) setEquipError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setEquipLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [retrySeq]);

  const [coords, setCoords] = useState({ top: 96, right: 24, maxHeight: 660 });
  const sheetRef = useRef<HTMLElement>(null);

  const updateField = (key: keyof LibraryFilterDraft, nextVal: string) => {
    setDraft((prev) => ({ ...prev, [key]: nextVal }));
  };

  useEffect(() => {
    const prev = document.activeElement;
    sheetRef.current?.focus({ preventScroll: true });
    return () => {
      if (prev instanceof HTMLElement && prev.isConnected) {
        prev.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!isPresent) return;
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  });

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      const width = Math.min(580, window.innerWidth - 32);
      const top = Math.max(16, Math.min((rect?.bottom || 76) + 10, window.innerHeight - 420));
      const left = Math.max(16, Math.min(rect?.left || 24, window.innerWidth - width - 16));
      setCoords({
        top,
        right: window.innerWidth - left - width,
        maxHeight: Math.min(740, window.innerHeight - top - 16),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [anchorRef]);

  function applyQuickDays(days?: number) {
    const end = new Date();
    const start = new Date(end);
    if (days) {
      start.setDate(start.getDate() - days + 1);
    } else {
      start.setMonth(0, 1);
    }
    setDraft((prev) => ({
      ...prev,
      from: formatIsoDayLocal(start),
      to: formatIsoDayLocal(end),
    }));
  }

  const renderEnumSelect = (key: keyof typeof FILTER_ENUM_OPTIONS, label: string) => (
    <label className="filter-field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={draft[key]}
        onChange={(e) => updateField(key, e.target.value)}
      >
        <option value="">全部</option>
        {FILTER_ENUM_OPTIONS[key].map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  const renderEquipmentSelect = (
    key: "camera" | "lens",
    label: string,
    options: string[] | undefined,
  ) => (
    <label className="filter-field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={
          draft[`${key}Match`] === "missing" ? "missing" : draft[key] ? `value:${draft[key]}` : ""
        }
        disabled={equipLoading && !equipment}
        onChange={(e) => {
          const val = e.target.value;
          const isMissing = val === "missing";
          const chosen = val.startsWith("value:") ? val.slice(6) : "";
          setDraft((prev) => ({
            ...prev,
            [key]: chosen,
            [`${key}Match`]: isMissing ? "missing" : chosen ? "exact" : "",
          }));
        }}
      >
        <option value="">{equipLoading && !equipment ? "正在读取照片库…" : `全部${label}`}</option>
        <option value="missing">无{label}记录</option>
        {draft[key] && !options?.includes(draft[key]) && (
          <option value={`value:${draft[key]}`}>{draft[key]}</option>
        )}
        {options?.map((opt) => (
          <option key={opt} value={`value:${opt}`}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );

  const renderNumericRange = (
    lowKey: "minSize" | "minMP",
    highKey: "maxSize" | "maxMP",
    label: string,
    unit: string,
    multiplier: number,
  ) => (
    <fieldset className="filter-range">
      <legend>
        {label} <small>{unit}</small>
      </legend>
      <div>
        <input
          aria-label={`最小${label}`}
          type="number"
          min="0"
          step="any"
          placeholder="最小"
          value={lowKey === "minSize" ? mbInputs.minSize : draft[lowKey]}
          onChange={(e) => {
            const raw = e.target.value;
            if (lowKey === "minSize") {
              setMbInputs((p) => ({ ...p, minSize: raw }));
            }
            updateField(
              lowKey,
              raw === "" || multiplier === 1 ? raw : String(Math.round(Number(raw) * multiplier)),
            );
          }}
        />
        <span>—</span>
        <input
          aria-label={`最大${label}`}
          type="number"
          min="0"
          step="any"
          placeholder="最大"
          value={highKey === "maxSize" ? mbInputs.maxSize : draft[highKey]}
          onChange={(e) => {
            const raw = e.target.value;
            if (highKey === "maxSize") {
              setMbInputs((p) => ({ ...p, maxSize: raw }));
            }
            updateField(
              highKey,
              raw === "" || multiplier === 1 ? raw : String(Math.round(Number(raw) * multiplier)),
            );
          }}
        />
      </div>
    </fieldset>
  );

  const renderDateRange = (
    lowKey: "from" | "addedFrom",
    highKey: "to" | "addedTo",
    label: string,
  ) => (
    <fieldset className="filter-range filter-dates">
      <legend>{label}</legend>
      <div>
        <input
          aria-label={`${label}开始`}
          type="date"
          value={draft[lowKey]}
          max={draft[highKey] || undefined}
          onChange={(e) => updateField(lowKey, e.target.value)}
        />
        <span>—</span>
        <input
          aria-label={`${label}结束`}
          type="date"
          value={draft[highKey]}
          min={draft[lowKey] || undefined}
          onChange={(e) => updateField(highKey, e.target.value)}
        />
      </div>
    </fieldset>
  );

  const hasInvalidBounds =
    (draft.from && draft.to && draft.from > draft.to) ||
    (draft.addedFrom && draft.addedTo && draft.addedFrom > draft.addedTo) ||
    (draft.minSize && draft.maxSize && Number(draft.minSize) > Number(draft.maxSize)) ||
    (draft.minMP && draft.maxMP && Number(draft.minMP) > Number(draft.maxMP));

  return createPortal(
    <div
      className={`filter-scrim ${!isPresent ? "is-closing" : ""}`}
      onClick={onClose}
      inert={!isPresent}
      aria-hidden={!isPresent || undefined}
    >
      <section
        ref={sheetRef}
        className="filter-panel"
        style={compact ? undefined : coords}
        id="library-filters"
        role="dialog"
        aria-modal="true"
        aria-labelledby="filter-panel-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!hasInvalidBounds && isPresent) {
              onApply(draft);
              onClose();
            }
          }}
        >
          <header>
            <h2 id="filter-panel-title">
              <SlidersHorizontal size={17} />
              <span>筛选照片</span>
            </h2>
            <button type="button" className="icon-btn" aria-label="关闭筛选" onClick={onClose}>
              <X size={19} />
            </button>
          </header>

          <div className="filter-panel-content">
            <section className="filter-section">
              <h3>
                <FileImage size={15} />
                <span>照片内容与归属</span>
              </h3>
              <div className="filter-fields">
                {renderEnumSelect("kind", "媒体类型")}
                {renderEnumSelect("format", "原件格式")}
                {renderEnumSelect("orientation", "构图")}
                {renderEnumSelect("location", "定位信息")}
                {renderEnumSelect("versions", "照片版本")}
                {renderEnumSelect("grouping", "组合方式")}
                {renderEnumSelect("albumState", "相片集归属")}
              </div>
            </section>

            <section className="filter-section">
              <h3>
                <CalendarDays size={15} />
                <span>日期范围</span>
              </h3>
              <div className="filter-presets">
                <button type="button" onClick={() => applyQuickDays(7)}>
                  最近 7 天
                </button>
                <button type="button" onClick={() => applyQuickDays(30)}>
                  最近 30 天
                </button>
                <button type="button" onClick={() => applyQuickDays()}>
                  今年
                </button>
              </div>
              {compact && months.length > 0 && <label className="filter-field filter-months">
                <span>拍摄月份</span>
                <select aria-label="拍摄月份" value={months.find(({ month }) => {
                  const bounds = resolveMonthBounds(month);
                  return draft.from === bounds.from && draft.to === bounds.to;
                })?.month || ""} onChange={(event) => {
                  const bounds = event.target.value ? resolveMonthBounds(event.target.value) : { from: "", to: "" };
                  setDraft((previous) => ({ ...previous, ...bounds }));
                }}>
                  <option value="">全部月份 / 自定义日期</option>
                  {months.map(({ month, count }) => <option key={month} value={month}>{month} · {count} 项</option>)}
                </select>
              </label>}
              {renderDateRange("from", "to", "拍摄日期")}
              {renderDateRange("addedFrom", "addedTo", "导入日期")}
            </section>

            <section className="filter-section">
              <h3>
                <Camera size={15} />
                <span>拍摄设备与镜头</span>
              </h3>
              <div className="filter-fields">
                {renderEquipmentSelect("camera", "设备", equipment?.cameras)}
                {renderEquipmentSelect("lens", "镜头", equipment?.lenses)}
              </div>
              {equipError && (
                <p className="equipment-error" role="alert">
                  <span>{equipError}</span>
                  <button
                    type="button"
                    disabled={equipLoading}
                    onClick={() => setRetrySeq((n) => n + 1)}
                  >
                    {equipLoading ? "正在重试" : "重新加载"}
                  </button>
                </p>
              )}
            </section>

            <section className="filter-section">
              <h3>
                <SlidersHorizontal size={15} />
                <span>文件规格与处理状态</span>
              </h3>
              <div className="filter-fields">
                {renderNumericRange("minMP", "maxMP", "像素数", "MP", 1)}
                {renderNumericRange("minSize", "maxSize", "原件大小", "MB", 1048576)}
                {renderEnumSelect("status", "处理状态")}
              </div>
              <p className="filter-field-note">像素数、构图、大小和处理状态按主版本筛选。</p>
            </section>

            {hasInvalidBounds && (
              <p className="filter-validation" role="alert">
                范围的起点不能大于终点
              </p>
            )}
          </div>

          <footer>
            <button
              type="button"
              className="filter-reset"
              onClick={() => {
                setDraft({ ...createEmptyFilters(), from: "", to: "" });
                setMbInputs({ minSize: "", maxSize: "" });
              }}
            >
              重置
            </button>
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!!hasInvalidBounds || !isPresent}
            >
              <Check size={15} />
              <span>应用筛选</span>
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}
