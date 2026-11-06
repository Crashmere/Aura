import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  ChevronDown,
  Circle,
  CloudUpload,
  Cpu,
  Image as ImageIcon,
  LoaderCircle,
  Minus,
  RefreshCw,
  Video,
  X,
} from "lucide-react";
import { formatByteSize, requestJson } from "../core/client";
import type {
  CursorPage,
  IncompleteUploadSession,
  LibraryTelemetry,
  PipelineFilterStatus,
  PipelineJob,
  PipelineJobPage,
  PipelineStep,
} from "../core/types";

const STATUS_FILTER_LABELS: Record<PipelineFilterStatus, string> = {
  all: "全部",
  queued: "等待处理",
  processing: "处理中",
  error: "失败",
  ready: "已完成",
};

const STEP_STATUS_LABELS: Record<PipelineStep["status"], string> = {
  queued: "未开始",
  processing: "处理中",
  ready: "已完成",
  error: "失败",
  skipped: "已跳过",
};

const ZERO_COUNTS: Record<PipelineFilterStatus, number> = {
  all: 0,
  queued: 0,
  processing: 0,
  error: 0,
  ready: 0,
};

function formatElapsedSpan(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "";
  const endMs = finishedAt ? Date.parse(finishedAt) : Date.now();
  const sec = Math.max(0, Math.floor((endMs - Date.parse(startedAt)) / 1000));
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

function PipelineJobAccordion({
  job,
  retrying,
  onRetryHashes,
  onLocateAsset,
}: {
  job: PipelineJob;
  retrying: boolean;
  onRetryHashes: (hashes: string[]) => void;
  onLocateAsset: (assetId: string) => void;
}) {
  const progress = job.progress;
  const steps = progress?.steps || [];
  const readyCount = steps.filter((s) => s.status === "ready").length;
  const skippedCount = steps.filter((s) => s.status === "skipped").length;
  const activeStep = steps.find((s) => s.status === "processing");
  const finishedSteps = readyCount + skippedCount;

  return (
    <details className={`task-job ${job.status === "error" ? "has-error" : ""}`}>
      <summary className="task-row">
        <span className={`task-state ${job.status}`}>
          {job.status === "processing" ? (
            <LoaderCircle className="spin" size={20} />
          ) : job.status === "ready" ? (
            <CheckCheck size={20} />
          ) : job.mime.startsWith("video/") ? (
            <Video size={20} />
          ) : (
            <ImageIcon size={20} />
          )}
        </span>
        <div className="task-description">
          <strong>{job.name}</strong>
          <small>
            {formatByteSize(job.size)} · {STATUS_FILTER_LABELS[job.status]}
            {activeStep
              ? ` · ${activeStep.label}${activeStep.percent ? ` ${Math.floor(activeStep.percent)}%` : ""}`
              : ""}
          </small>
          {steps.length > 0 && (
            <>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="已结束的处理步骤"
                aria-valuenow={finishedSteps}
                aria-valuemin={0}
                aria-valuemax={steps.length}
              >
                <i style={{ width: `${(100 * finishedSteps) / steps.length}%` }} />
              </div>
              <small>
                已完成 {readyCount} / {steps.length} 项
                {skippedCount ? ` · 跳过 ${skippedCount} 项` : ""}
                {progress?.startedAt
                  ? ` · ${formatElapsedSpan(progress.startedAt, progress.finishedAt)}`
                  : ""}
              </small>
            </>
          )}
        </div>
        <ChevronDown className="task-expand" size={17} aria-hidden="true" />
      </summary>

      <div className="task-detail">
        {steps.length > 0 ? (
          <ol className="task-steps">
            {steps.map((step) => (
              <li key={step.id} className={step.status}>
                <span className="task-step-icon">
                  {step.status === "ready" ? (
                    <Check size={14} />
                  ) : step.status === "processing" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : step.status === "error" ? (
                    <X size={14} />
                  ) : step.status === "skipped" ? (
                    <Minus size={14} />
                  ) : (
                    <Circle size={11} />
                  )}
                </span>
                <div>
                  <span>{step.label}</span>
                  <small>
                    {STEP_STATUS_LABELS[step.status]}
                    {step.engine ? ` · ${step.engine}` : ""}
                    {step.startedAt
                      ? ` · ${formatElapsedSpan(step.startedAt, step.finishedAt)}`
                      : ""}
                  </small>
                  {step.status === "processing" &&
                    typeof step.percent === "number" && (
                      <div className="task-step-progress">
                        <progress
                          max={100}
                          value={step.percent}
                          aria-label={step.label}
                        />
                        <span>{Math.floor(step.percent)}%</span>
                      </div>
                    )}
                  {step.note && <small>{step.note}</small>}
                  {step.error && <p className="task-error">{step.error}</p>}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="task-note">
            {job.status === "queued"
              ? "等待开始处理"
              : "此记录没有分步骤进度"}
          </p>
        )}

        {job.error && !steps.some((s) => s.error === job.error) && (
          <p className="task-error">{job.error}</p>
        )}

        <div className="task-row-actions">
          {job.assetId && (
            <button type="button" onClick={() => onLocateAsset(job.assetId)}>
              查看照片
            </button>
          )}
          {job.status === "error" && (
            <button
              type="button"
              disabled={retrying}
              onClick={() => onRetryHashes([job.hash])}
            >
              重新处理
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

export function PipelineTaskCenter({
  info,
  onOpenUploadHub,
  onLocateAsset,
  onCatalogMutated,
}: {
  info?: LibraryTelemetry;
  onOpenUploadHub: () => void;
  onLocateAsset: (assetId: string) => void;
  onCatalogMutated: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"processing" | "uploads">("processing");
  const [statusFilter, setStatusFilter] = useState<PipelineFilterStatus>("all");
  const [jobsList, setJobsList] = useState<PipelineJob[]>([]);
  const [pendingUploads, setPendingUploads] = useState<IncompleteUploadSession[]>([]);
  const [statusCounts, setStatusCounts] = useState(ZERO_COUNTS);
  const [nextCursor, setNextCursor] = useState("");
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [pageIdx, setPageIdx] = useState(0);

  const reqSeq = useRef(0);
  const refreshFn = useRef(() => {});
  const inFlight = useRef(false);
  const cursorStack = useRef<string[]>([""]);

  async function fetchPage(cursor = "", silent = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    const seq = ++reqSeq.current;
    if (!silent) setLoading(true);
    setErrorMsg("");

    try {
      const params = new URLSearchParams({
        paged: "true",
        limit: "50",
        status: statusFilter,
        ...(cursor ? { cursor } : {}),
      });
      if (activeTab === "uploads") {
        const res = await requestJson<CursorPage<IncompleteUploadSession>>(
          `uploads?${params.toString()}`,
        );
        if (seq !== reqSeq.current) return;
        setPendingUploads(res.items);
        setNextCursor(res.next);
      } else {
        const res = await requestJson<PipelineJobPage>(`jobs?${params.toString()}`);
        if (seq !== reqSeq.current) return;
        setJobsList(res.items);
        setStatusCounts(res.counts);
        setNextCursor(res.next);
      }
    } catch (err) {
      if (seq === reqSeq.current) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (seq === reqSeq.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }

  refreshFn.current = () => {
    void fetchPage(cursorStack.current[pageIdx] || "", true);
  };

  useEffect(() => {
    inFlight.current = false;
    cursorStack.current = [""];
    setPageIdx(0);
    setJobsList([]);
    setPendingUploads([]);
    setNextCursor("");
    void fetchPage();
    return () => {
      ++reqSeq.current;
    };
  }, [activeTab, statusFilter]);

  useEffect(() => {
    const onChanged = () => refreshFn.current();
    window.addEventListener("aura-library-changed", onChanged);
    return () => window.removeEventListener("aura-library-changed", onChanged);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) refreshFn.current();
    }, 3000);
    return () => clearInterval(t);
  }, []);

  async function triggerBatchRetry(hashes: string[]) {
    if (retrying || !hashes.length) return;
    setRetrying(true);
    setErrorMsg("");
    try {
      await requestJson("files/retry", { hashes });
      await fetchPage(cursorStack.current[pageIdx] || "");
      onCatalogMutated();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }

  const failedHashes = jobsList
    .filter((j) => j.status === "error")
    .map((j) => j.hash);

  const concurrency = info?.processingConcurrency;

  return (
    <section className="task-center">
      {concurrency && (
        <div className="pipeline-telemetry-strip">
          <div className="telemetry-chip">
            <Cpu size={14} />
            <span>
              并发工作槽 {concurrency.workers} · GPU 通道 {concurrency.gpuOperations} · CPU 通道{" "}
              {concurrency.cpuOperations}
            </span>
          </div>
          {info?.similarityIndex && (
            <div className="telemetry-chip">
              <span>
                DINO 索引：{info.similarityIndex.ready} / {info.similarityIndex.total} 已就绪
                {info.similarityIndex.pending ? `（${info.similarityIndex.pending} 待分析）` : ""}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="task-tabs">
        <button
          type="button"
          className={activeTab === "processing" ? "active" : ""}
          onClick={() => setActiveTab("processing")}
        >
          <ImageIcon size={16} />
          <span>原件与预览</span>
        </button>
        <button
          type="button"
          className={activeTab === "uploads" ? "active" : ""}
          onClick={() => setActiveTab("uploads")}
        >
          <CloudUpload size={16} />
          <span>未完成上传</span>
        </button>
        <button
          type="button"
          className="task-refresh"
          disabled={loading || retrying}
          onClick={() => void fetchPage(cursorStack.current[pageIdx] || "")}
        >
          <RefreshCw size={15} />
          <span>刷新</span>
        </button>
      </div>

      {activeTab === "processing" ? (
        <>
          <p className="task-note">
            已结束的记录保留 24 小时，未完成的任务持续显示。
          </p>
          <div className="task-filters">
            {(Object.keys(STATUS_FILTER_LABELS) as PipelineFilterStatus[]).map(
              (st) => (
                <button
                  type="button"
                  key={st}
                  className={statusFilter === st ? "active" : ""}
                  onClick={() => setStatusFilter(st)}
                >
                  <span>{STATUS_FILTER_LABELS[st]}</span>
                  <span className="task-count-pill">{statusCounts[st]}</span>
                </button>
              ),
            )}
            {failedHashes.length > 0 && (
              <button
                type="button"
                className="btn task-bulk"
                disabled={retrying || loading}
                onClick={() => void triggerBatchRetry(failedHashes)}
              >
                <RefreshCw size={14} />
                <span>重试已加载失败（{failedHashes.length}）</span>
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="task-note">
          已接收的分片保留在服务器。重新选择同一原件可继续上传，不会重复保存原件。
        </p>
      )}

      {errorMsg && (
        <div className="inline-alert" role="alert">
          <span>{errorMsg}</span>
          <button
            type="button"
            className="btn"
            disabled={loading}
            onClick={() => void fetchPage(cursorStack.current[pageIdx] || "")}
          >
            重试
          </button>
        </div>
      )}

      <div className="task-list">
        {activeTab === "processing"
          ? jobsList.map((job) => (
              <PipelineJobAccordion
                key={job.hash}
                job={job}
                retrying={retrying}
                onRetryHashes={(hashes) => void triggerBatchRetry(hashes)}
                onLocateAsset={onLocateAsset}
              />
            ))
          : pendingUploads.map((u) => (
              <article className="task-row" key={u.id}>
                <span className="task-state queued">
                  <CloudUpload size={20} />
                </span>
                <div className="task-description">
                  <strong>{u.name}</strong>
                  <small>
                    {formatByteSize(u.offset)} / {formatByteSize(u.size)} ·{" "}
                    {u.missing ? "原件缺失，等待补传" : "等待源文件继续上传"}
                  </small>
                  <div className="progress-track">
                    <i
                      style={{
                        width: `${Math.min(100, (100 * u.offset) / u.size)}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="task-row-actions">
                  <button type="button" onClick={onOpenUploadHub}>
                    选择源文件
                  </button>
                </div>
              </article>
            ))}
      </div>

      {loading && (
        <div className="loading-inline">
          <LoaderCircle className="spin" size={20} />
          <span>正在加载任务</span>
        </div>
      )}

      {!loading &&
        !errorMsg &&
        !(activeTab === "processing" ? jobsList.length : pendingUploads.length) && (
          <div className="task-empty">
            <CheckCheck size={28} />
            <p>
              {activeTab === "uploads"
                ? "没有未完成的上传"
                : statusFilter === "all"
                  ? "最近 24 小时没有处理记录"
                  : `没有${STATUS_FILTER_LABELS[statusFilter]}的资源`}
            </p>
          </div>
        )}

      {(nextCursor || pageIdx > 0) && (
        <nav className="similar-pagination" aria-label="任务分页">
          <button
            type="button"
            className="btn"
            disabled={loading || pageIdx === 0}
            onClick={() => {
              const prev = pageIdx - 1;
              setPageIdx(prev);
              void fetchPage(cursorStack.current[prev]);
            }}
          >
            上一页
          </button>
          <span>第 {pageIdx + 1} 页</span>
          <button
            type="button"
            className="btn"
            disabled={loading || !nextCursor}
            onClick={() => {
              cursorStack.current = [
                ...cursorStack.current.slice(0, pageIdx + 1),
                nextCursor,
              ];
              const next = pageIdx + 1;
              setPageIdx(next);
              void fetchPage(nextCursor);
            }}
          >
            下一页
          </button>
        </nav>
      )}
    </section>
  );
}
