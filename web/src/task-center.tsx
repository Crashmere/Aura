import { useEffect, useRef, useState } from "react";
import { CheckCheck, CloudUpload, Image as ImageIcon, LoaderCircle, RefreshCw, Video } from "lucide-react";
import { api, bytes, Job, JobPage, JobStatus, Page, PendingUpload } from "./api";

const labels: Record<JobStatus, string> = { all: "全部", queued: "等待处理", processing: "处理中", error: "失败", ready: "已就绪" };
const emptyCounts = { all: 0, queued: 0, processing: 0, error: 0, ready: 0 };

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

  async function load(cursor = "") {
    const key = ++request.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ paged: "true", limit: "50", status, ...(cursor ? { cursor } : {}) });
      if (tab === "uploads") {
        const data = await api<Page<PendingUpload>>("uploads?" + params);
        if (request.current !== key) return;
        setUploads(old => cursor ? [...old, ...data.items.filter(item => !old.some(existing => existing.id === item.id))] : data.items);
        setNext(data.next);
      } else {
        const data = await api<JobPage>("jobs?" + params);
        if (request.current !== key) return;
        setJobs(old => cursor ? [...old, ...data.items.filter(item => !old.some(existing => existing.hash === item.hash))] : data.items);
        setCounts(data.counts);
        setNext(data.next);
      }
    } catch (e) {
      if (request.current === key) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request.current === key) setLoading(false);
    }
  }
  refresh.current = () => { void load(); };
  useEffect(() => {
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
    if (tab !== "processing" || jobs.length > 50 || !counts.queued && !counts.processing) return;
    const timer = setInterval(() => refresh.current(), 4000);
    return () => clearInterval(timer);
  }, [tab, jobs.length, counts.queued, counts.processing]);

  async function retry(hashes: string[]) {
    if (retrying || !hashes.length) return;
    setRetrying(true);
    setError("");
    try {
      await api("files/retry", { hashes });
      await load();
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
        <button className="task-refresh" disabled={loading || retrying} onClick={() => void load()}><RefreshCw size={15} />刷新</button>
      </div>
      {tab === "processing" ? (
        <>
          <p className="task-note">原件提交完成后会独立生成预览；处理失败不会删除原件。</p>
          <div className="task-filters">
            {(Object.keys(labels) as JobStatus[]).map(value => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{labels[value]}<span>{counts[value]}</span></button>)}
            {!!failed.length && <button className="button task-bulk" disabled={retrying || loading} onClick={() => void retry(failed)}><RefreshCw size={14} />重试已加载失败（{failed.length}）</button>}
          </div>
        </>
      ) : <p className="task-note">已接收的分片保留在服务器。重新选择同一原件可继续上传，不会重复保存原件。</p>}
      {error && <div className="error-banner" role="alert">{error}<button className="button" onClick={() => void load()} disabled={loading}>重试</button></div>}
      <div className="task-list">
        {tab === "processing" ? jobs.map(job => (
          <article className={`task-row ${job.status === "error" ? "has-error" : ""}`} key={job.hash}>
            <span className={`task-state ${job.status}`}>{job.status === "processing" ? <LoaderCircle className="spin" size={21} /> : job.status === "ready" ? <CheckCheck size={21} /> : job.mime.startsWith("video/") ? <Video size={21} /> : <ImageIcon size={21} />}</span>
            <div className="task-description"><strong>{job.name}</strong><small>{bytes(job.size)} · {labels[job.status as JobStatus] || job.status}</small>{job.error && <p className="task-error">{job.error}</p>}</div>
            <div className="task-row-actions">{job.assetId && <button onClick={() => openAsset(job.assetId)}>查看照片</button>}{job.status === "error" && <button disabled={retrying} onClick={() => void retry([job.hash])}>重新处理</button>}</div>
          </article>
        )) : uploads.map(upload => (
          <article className="task-row" key={upload.id}>
            <span className="task-state queued"><CloudUpload size={21} /></span>
            <div className="task-description"><strong>{upload.name}</strong><small>{bytes(upload.offset)} / {bytes(upload.size)} · {upload.missing ? "原件缺失，等待补传" : "等待源文件继续上传"}</small><div className="progress-track"><i style={{ width: `${Math.min(100, 100 * upload.offset / upload.size)}%` }} /></div></div>
            <div className="task-row-actions"><button onClick={openUpload}>选择源文件</button></div>
          </article>
        ))}
      </div>
      {loading && <div className="loading-inline"><LoaderCircle className="spin" size={20} />正在加载任务</div>}
      {!loading && !error && !(tab === "processing" ? jobs.length : uploads.length) && <div className="task-empty"><CheckCheck size={28} /><p>{tab === "uploads" ? "没有未完成的上传" : status === "all" ? "还没有已提交的原件" : `没有${labels[status]}的资源`}</p></div>}
      {next && <button className="button task-more" disabled={loading} onClick={() => void load(next)}>加载更多</button>}
    </section>
  );
}
