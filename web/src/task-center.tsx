import { useEffect, useRef, useState } from "react";
import { CheckCheck, Check, ChevronDown, Circle, CloudUpload, Image as ImageIcon, LoaderCircle, Minus, RefreshCw, Video, X } from "lucide-react";
import { api, bytes, Job, JobPage, JobStatus, JobStep, Page, PendingUpload } from "./api";

const labels: Record<JobStatus, string> = { all: "全部", queued: "等待处理", processing: "处理中", error: "失败", ready: "已完成" };
const emptyCounts = { all: 0, queued: 0, processing: 0, error: 0, ready: 0 };

const stepLabels: Record<JobStep["status"], string> = { queued: "未开始", processing: "处理中", ready: "已完成", error: "失败", skipped: "已跳过" };
function elapsed(start?: string, finish?: string) {
  if (!start) return "";
  const seconds = Math.max(0, Math.floor(((finish ? Date.parse(finish) : Date.now()) - Date.parse(start)) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function TaskJob({ job, retrying, retry, openAsset }: { job: Job; retrying: boolean; retry: (hashes: string[]) => void; openAsset: (id: string) => void }) {
  const progress = job.progress;
  const steps = progress?.steps || [];
  const completed = steps.filter(step => step.status === "ready").length;
  const skipped = steps.filter(step => step.status === "skipped").length;
  const current = steps.find(step => step.status === "processing");
  const resolved = completed + skipped;
  return <details className={`task-job ${job.status === "error" ? "has-error" : ""}`}>
    <summary className="task-row">
      <span className={`task-state ${job.status}`}>{job.status === "processing" ? <LoaderCircle className="spin" size={21} /> : job.status === "ready" ? <CheckCheck size={21} /> : job.mime.startsWith("video/") ? <Video size={21} /> : <ImageIcon size={21} />}</span>
      <div className="task-description"><strong>{job.name}</strong><small>{bytes(job.size)} · {labels[job.status]}{current ? ` · ${current.label}${current.percent ? ` ${Math.floor(current.percent)}%` : ""}` : ""}</small>
        {!!steps.length && <><div className="progress-track" role="progressbar" aria-label="已结束的处理步骤" aria-valuenow={resolved} aria-valuemin={0} aria-valuemax={steps.length}><i style={{ width: `${100 * resolved / steps.length}%` }} /></div><small>已完成 {completed} / {steps.length} 项{skipped ? ` · 跳过 ${skipped} 项` : ""}{progress?.startedAt ? ` · ${elapsed(progress.startedAt, progress.finishedAt)}` : ""}</small></>}
      </div>
      <ChevronDown className="task-expand" size={17} aria-hidden="true" />
    </summary>
    <div className="task-detail">
      {!!steps.length ? <ol className="task-steps">{steps.map(step => <li key={step.id} className={step.status}>
        <span className="task-step-icon">{step.status === "ready" ? <Check size={15} /> : step.status === "processing" ? <LoaderCircle size={15} className="spin" /> : step.status === "error" ? <X size={15} /> : step.status === "skipped" ? <Minus size={15} /> : <Circle size={12} />}</span>
        <div><span>{step.label}</span><small>{stepLabels[step.status]}{step.engine ? ` · ${step.engine}` : ""}{step.startedAt ? ` · ${elapsed(step.startedAt, step.finishedAt)}` : ""}</small>{step.status === "processing" && typeof step.percent === "number" && <div className="task-step-progress"><progress max={100} value={step.percent} aria-label={step.label} /><span>{Math.floor(step.percent)}%</span></div>}{step.note && <small>{step.note}</small>}{step.error && <p className="task-error">{step.error}</p>}</div>
      </li>)}</ol> : <p className="task-note">{job.status === "queued" ? "等待开始处理" : "此记录没有分步骤进度"}</p>}
      {job.error && !steps.some(step => step.error === job.error) && <p className="task-error">{job.error}</p>}
      <div className="task-row-actions">{job.assetId && <button onClick={() => openAsset(job.assetId)}>查看照片</button>}{job.status === "error" && <button disabled={retrying} onClick={() => retry([job.hash])}>重新处理</button>}</div>
    </div>
  </details>;
}

export function TaskCenter({ openUpload, openAsset, changed }: {
  openUpload: () => void;
  openAsset: (id: string) => void;
  changed: () => void;
}) {
  const [tab, setTab] = useState("processing");
  const [status, setStatus] = useState<JobStatus>("all");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [counts, setCounts] = useState(emptyCounts);
  const [next, setNext] = useState("");
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const refresh = useRef(() => {});
  const busy = useRef(false);
  const [page, setPage] = useState(0);
  const cursors = useRef([""]);

  async function load(cursor = "", quiet = false) {
    if (busy.current) return;
    busy.current = true;
    const key = ++request.current;
    if (!quiet) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ paged: "true", limit: "50", status, ...(cursor ? { cursor } : {}) });
      if (tab === "uploads") {
        const data = await api<Page<PendingUpload>>("uploads?" + params);
        if (request.current !== key) return;
        setUploads(data.items);
        setNext(data.next);
      } else {
        const data = await api<JobPage>("jobs?" + params);
        if (request.current !== key) return;
        setJobs(data.items);
        setCounts(data.counts);
        setNext(data.next);
      }
    } catch (e) {
      if (request.current === key) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request.current === key) { busy.current = false; setLoading(false); }
    }
  }
  refresh.current = () => { void load(cursors.current[page] || "", true); };
  useEffect(() => {
    busy.current = false;
    cursors.current = [""]; setPage(0);
    setJobs([]);
    setUploads([]);
    setNext("");
    void load();
    return () => { ++request.current; };
  }, [tab, status]);
  useEffect(() => {
    const handler = () => refresh.current();
    window.addEventListener("aura-library-changed", handler);
    return () => window.removeEventListener("aura-library-changed", handler);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) refresh.current(); }, 3000);
    return () => clearInterval(timer);
  }, []);

  async function retry(hashes: string[]) {
    if (retrying || !hashes.length) return;
    setRetrying(true);
    setError("");
    try {
      await api("files/retry", { hashes });
      await load(cursors.current[page] || "");
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setRetrying(false); }
  }
  const failed = jobs.filter(job => job.status === "error").map(job => job.hash);
  return (
    <section className="task-center">
      <div className="task-tabs">
        <button className={tab === "processing" ? "active" : ""} onClick={() => setTab("processing")}><ImageIcon size={16} />原件与预览</button>
        <button className={tab === "uploads" ? "active" : ""} onClick={() => setTab("uploads")}><CloudUpload size={16} />未完成上传</button>
        <button className="task-refresh" disabled={loading || retrying} onClick={() => void load(cursors.current[page] || "")}><RefreshCw size={15} />刷新</button>
      </div>
      {tab === "processing" ? (
        <>
          <p className="task-note">已结束的记录保留 24 小时，未完成的任务持续显示。</p>
          <div className="task-filters">
            {(Object.keys(labels) as JobStatus[]).map(value => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{labels[value]}<span>{counts[value]}</span></button>)}
            {!!failed.length && <button className="button task-bulk" disabled={retrying || loading} onClick={() => void retry(failed)}><RefreshCw size={14} />重试已加载失败（{failed.length}）</button>}
          </div>
        </>
      ) : <p className="task-note">已接收的分片保留在服务器。重新选择同一原件可继续上传，不会重复保存原件。</p>}
      {error && <div className="error-banner" role="alert">{error}<button className="button" onClick={() => void load(cursors.current[page] || "")} disabled={loading}>重试</button></div>}
      <div className="task-list">
        {tab === "processing" ? jobs.map(job => (
          <TaskJob key={job.hash} job={job} retrying={retrying} retry={hashes => void retry(hashes)} openAsset={openAsset} />
        )) : uploads.map(upload => (
          <article className="task-row" key={upload.id}>
            <span className="task-state queued"><CloudUpload size={21} /></span>
            <div className="task-description"><strong>{upload.name}</strong><small>{bytes(upload.offset)} / {bytes(upload.size)} · {upload.missing ? "原件缺失，等待补传" : "等待源文件继续上传"}</small><div className="progress-track"><i style={{ width: `${Math.min(100, 100 * upload.offset / upload.size)}%` }} /></div></div>
            <div className="task-row-actions"><button onClick={openUpload}>选择源文件</button></div>
          </article>
        ))}
      </div>
      {loading && <div className="loading-inline"><LoaderCircle className="spin" size={20} />正在加载任务</div>}
      {!loading && !error && !(tab === "processing" ? jobs.length : uploads.length) && <div className="task-empty"><CheckCheck size={28} /><p>{tab === "uploads" ? "没有未完成的上传" : status === "all" ? "最近 24 小时没有处理记录" : `没有${labels[status]}的资源`}</p></div>}
      {(next || page > 0) && <nav className="similar-pagination" aria-label="任务分页">
        <button className="button" disabled={loading || page === 0} onClick={() => { setPage(page - 1); void load(cursors.current[page - 1]); }}>上一页</button>
        <span>第 {page + 1} 页</span>
        <button className="button" disabled={loading || !next} onClick={() => { cursors.current = [...cursors.current.slice(0,page + 1),next]; setPage(page + 1); void load(next); }}>下一页</button>
      </nav>}
    </section>
  );
}
