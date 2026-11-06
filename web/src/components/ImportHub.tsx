import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CheckCheck,
  CloudUpload,
  FolderOpen,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { APP_BASE, formatByteSize, requestJson } from "../core/client";
import {
  clearCompletedUploads,
  enqueueUploadFiles,
  getUploadSnapshot,
  pauseUploads,
  resolveUploadedAssetId,
  restoreTrashedUploadEntry,
  resumeUploads,
  setUploadDateBounds,
  startDirectoryWatch,
  stopDirectoryWatch,
  subscribeUploadEngine,
  type UploadTaskPhase,
} from "../core/importer";
import { useSlidingIndicator } from "../core/motion";
import type { StoredFile } from "../core/types";
import { ActionButton, RoundIconButton } from "./Icons";

const UPLOAD_PHASE_LABELS: Record<UploadTaskPhase, string> = {
  waiting: "等待上传",
  reading: "读取原件",
  uploading: "上传中",
  done: "已保存",
  duplicate: "原件已存在",
  trashed: "已在最近删除中",
  skipped: "不在日期范围",
  error: "上传失败",
};

export function ImportHubModal({
  activeTab,
  onSelectTab,
  onClose,
  onLocateAsset,
  onOpenJobsView,
}: {
  activeTab: string;
  onSelectTab: (tab: string) => void;
  onClose: () => void;
  onLocateAsset: (assetId: string) => void;
  onOpenJobsView: () => void;
}) {
  const tabsIndicator = useSlidingIndicator(activeTab, ".active");
  const engine = useSyncExternalStore(subscribeUploadEngine, getUploadSnapshot);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const dirPickerRef = useRef<HTMLInputElement>(null);

  const [serverJobs, setServerJobs] = useState<StoredFile[]>([]);
  const [serverJobError, setServerJobError] = useState("");
  const [locateError, setLocateError] = useState("");

  useEffect(() => {
    const pollJobs = () =>
      requestJson<StoredFile[]>("jobs")
        .then((res) => {
          setServerJobs(res);
          setServerJobError("");
        })
        .catch((err) =>
          setServerJobError(err instanceof Error ? err.message : String(err)),
        );
    void pollJobs();
    const timer = setInterval(pollJobs, 4000);
    return () => clearInterval(timer);
  }, []);

  const isBusy = engine.running || engine.scanning;
  const doneCount = engine.items.filter((x) =>
    ["done", "duplicate", "trashed", "skipped"].includes(x.state),
  ).length;
  const errorCount = engine.items.filter((x) => x.state === "error").length;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <section
        className="modal-card upload-modal"
        role="dialog"
        aria-modal="true"
        aria-label="添加到 Aura"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2>添加到 Aura</h2>
          </div>
          <RoundIconButton title="关闭" onClick={onClose}>
            <X size={20} />
          </RoundIconButton>
        </header>

        <div
          className="modal-tabs motion-tabs"
          ref={tabsIndicator.ref}
          style={tabsIndicator.style}
        >
          {[
            ["files", "文件上传"],
            ["sources", "持续导入"],
            ["apple", "Apple 照片库"],
          ].map(([id, title]) => (
            <button
              type="button"
              key={id}
              onClick={() => onSelectTab(id)}
              className={activeTab === id ? "active" : ""}
              aria-pressed={activeTab === id}
            >
              {title}
            </button>
          ))}
        </div>

        <div className="modal-body" key={activeTab}>
          {activeTab !== "apple" && (
            <div className="upload-dates">
              <label>
                <span>拍摄日期</span>
                <input
                  type="date"
                  disabled={isBusy}
                  value={engine.from}
                  max={engine.to || undefined}
                  onChange={(e) => setUploadDateBounds(e.target.value, engine.to)}
                />
              </label>
              <span>—</span>
              <label>
                <span>结束日期</span>
                <input
                  type="date"
                  disabled={isBusy}
                  min={engine.from || undefined}
                  value={engine.to}
                  onChange={(e) => setUploadDateBounds(engine.from, e.target.value)}
                />
              </label>
              {(engine.from || engine.to) && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setUploadDateBounds("", "")}
                >
                  不限日期
                </button>
              )}
            </div>
          )}

          {activeTab === "files" && (
            <>
              <button
                type="button"
                className="dropzone"
                onClick={() => filePickerRef.current?.click()}
              >
                <div className="upload-symbol">
                  <CloudUpload size={28} strokeWidth={1.5} />
                </div>
                <strong>选择照片与视频</strong>
                <span>也可以直接将文件拖入窗口</span>
              </button>
              <div className="upload-options">
                <button
                  type="button"
                  onClick={() => dirPickerRef.current?.click()}
                >
                  <FolderOpen size={15} />
                  <span>选择整个文件夹</span>
                </button>
                <span>HEIC · RAW · JPEG · MOV · MP4</span>
              </div>
              <p className="upload-note">
                iPhone 实况原件请使用 Apple 客户端，或从「文件」选择照片与 MOV。系统选图器可能只提供静态照片。
              </p>
            </>
          )}

          {activeTab === "sources" && (
            <div className="source-panel">
              <div className="source-icon">
                <FolderOpen size={28} />
              </div>
              <h3>
                {engine.watching ? engine.sourceName : "持续读取一个文件夹"}
              </h3>
              <p>
                页面保持打开时，每 30 秒检查新增文件，按上方拍摄日期范围上传。中断后可继续。
              </p>
              <div className="source-actions">
                {engine.watching ? (
                  <ActionButton onClick={stopDirectoryWatch}>
                    <Pause size={15} />
                    <span>停止监测</span>
                  </ActionButton>
                ) : (
                  <>
                    <ActionButton
                      variant="primary"
                      onClick={() => void startDirectoryWatch()}
                    >
                      <FolderOpen size={15} />
                      <span>选择文件夹</span>
                    </ActionButton>
                    <ActionButton onClick={() => void startDirectoryWatch(true)}>
                      <RefreshCw size={15} />
                      <span>重新连接</span>
                    </ActionButton>
                  </>
                )}
              </div>
              <small>Chrome 支持文件夹持续读取；Apple 照片库请使用客户端。</small>
            </div>
          )}

          {activeTab === "apple" && (
            <div className="apple-panel">
              <div className="apple-illustration">
                <Monitor size={58} strokeWidth={1.1} />
                <Smartphone size={32} strokeWidth={1.3} />
                <span className="connection-line" />
                <img src={`${APP_BASE}favicon.svg`} alt="Aura" />
              </div>
              <h3>原样上传你的 Apple 照片库</h3>
              <p>
                按拍摄日期持续导入，直接读取原始照片、实况视频、RAW 和编辑资源。客户端沿用门户设备授权。
              </p>
              <div className="apple-download-row">
                <a
                  className="btn btn-primary"
                  href="https://github.com/Crashmere/Aura/releases/latest/download/Aura-macOS.dmg"
                >
                  <ArrowDownToLine size={16} />
                  <span>下载 Mac 客户端</span>
                </a>
                <a
                  className="btn"
                  href="https://github.com/Crashmere/Aura/releases/latest/download/Aura-iOS.ipa"
                >
                  <Smartphone size={16} />
                  <span>下载 iOS 安装包</span>
                </a>
              </div>
              <ol>
                <li>打开客户端，输入此服务器地址并完成门户授权。</li>
                <li>允许访问照片，选择日期范围，开始持续上传。</li>
              </ol>
              <div className="platform-note">
                <Smartphone size={18} />
                <p>
                  iOS 安装包使用 AltStore 或 Sideloadly 自签安装。网页无法后台扫描系统照片库。
                </p>
              </div>
              <a
                className="text-link"
                href="https://github.com/Crashmere/Aura/blob/main/docs/APPLE.md"
                target="_blank"
                rel="noreferrer"
              >
                <span>客户端说明</span>
                <ArrowUpRight size={14} />
              </a>
            </div>
          )}

          {engine.error && <div className="inline-alert">{engine.error}</div>}
          {locateError && (
            <div className="inline-alert" role="alert">
              {locateError}
            </div>
          )}

          {activeTab !== "apple" && engine.items.length > 0 && (
            <div className="upload-queue">
              <div className="queue-header">
                <strong>
                  {doneCount} / {engine.items.length} 个文件
                </strong>
                <div>
                  {isBusy ? (
                    <button type="button" onClick={pauseUploads}>
                      <Pause size={14} />
                      <span>暂停</span>
                    </button>
                  ) : engine.paused || errorCount ? (
                    <button type="button" onClick={resumeUploads}>
                      <Play size={14} />
                      <span>继续{errorCount ? " / 重试" : ""}</span>
                    </button>
                  ) : null}
                  <button type="button" onClick={clearCompletedUploads}>
                    清除已完成
                  </button>
                </div>
              </div>

              <div className="queue-items">
                {engine.items.slice(-150).map((entry) => (
                  <div className="queue-item" key={entry.id}>
                    <span key={entry.state} className={`queue-state ${entry.state}`}>
                      {entry.state === "trashed" ? (
                        <Trash2 size={16} />
                      ) : entry.state === "done" || entry.state === "duplicate" ? (
                        <Check size={16} />
                      ) : entry.state === "error" ? (
                        <X size={16} />
                      ) : entry.state === "uploading" ||
                        entry.state === "reading" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <ImageIcon size={16} />
                      )}
                    </span>
                    <div className="queue-info">
                      <strong>{entry.file.name}</strong>
                      <small>
                        {entry.error || UPLOAD_PHASE_LABELS[entry.state]} ·{" "}
                        {formatByteSize(entry.file.size)}
                      </small>
                      {entry.restoreError && (
                        <small className="queue-restore-error">
                          {entry.restoreError}
                        </small>
                      )}
                      {entry.assetId &&
                        ["done", "duplicate", "trashed"].includes(entry.state) && (
                          <div className="queue-actions">
                            <button
                              type="button"
                              onClick={() =>
                                void resolveUploadedAssetId(entry.id)
                                  .then(onLocateAsset)
                                  .catch((err) =>
                                    setLocateError(
                                      err instanceof Error
                                        ? err.message
                                        : String(err),
                                    ),
                                  )
                              }
                            >
                              定位照片
                            </button>
                            {entry.state === "trashed" && (
                              <button
                                type="button"
                                disabled={entry.restoring}
                                onClick={() =>
                                  void restoreTrashedUploadEntry(entry.id)
                                }
                              >
                                {entry.restoring ? "正在恢复" : "恢复照片"}
                              </button>
                            )}
                          </div>
                        )}
                      {["reading", "uploading"].includes(entry.state) && (
                        <div className="progress-track">
                          <i style={{ width: `${entry.progress * 100}%` }} />
                        </div>
                      )}
                    </div>
                    <small>{Math.round(entry.progress * 100)}%</small>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab !== "apple" && serverJobError && (
            <div className="inline-alert" role="alert">
              {serverJobError}
            </div>
          )}

          {activeTab !== "apple" && (
            <button
              type="button"
              className="text-link processing-link"
              onClick={onOpenJobsView}
            >
              <ListChecks size={15} />
              <span>查看全部导入与处理任务</span>
            </button>
          )}

          {activeTab !== "apple" && serverJobs.length > 0 && (
            <details className="processing-jobs">
              <summary>服务器处理 · {serverJobs.length} 项</summary>
              {serverJobs.map((f) => (
                <div key={f.hash}>
                  <span>
                    {f.name}
                    <small>
                      {f.status === "error"
                        ? f.error || "预览处理失败，原件已保存"
                        : f.status === "queued"
                          ? "等待整理"
                          : "正在生成预览"}
                    </small>
                  </span>
                  {f.status === "error" && (
                    <button
                      type="button"
                      onClick={() =>
                        void requestJson(`files/${f.hash}/retry`, {})
                          .then(() =>
                            requestJson<StoredFile[]>("jobs").then(setServerJobs),
                          )
                          .catch((err) =>
                            setServerJobError(
                              err instanceof Error ? err.message : String(err),
                            ),
                          )
                      }
                    >
                      重试
                    </button>
                  )}
                </div>
              ))}
            </details>
          )}
        </div>

        <footer className="modal-footer">
          <span className="upload-footer-badge">
            <CheckCheck size={15} />
            <span>原件校验 · 自动去重 · 断点续传</span>
          </span>
          <ActionButton onClick={onClose}>
            {isBusy ? "收起" : "完成"}
          </ActionButton>
        </footer>

        <input
          ref={filePickerRef}
          hidden
          type="file"
          multiple
          onChange={(e) => {
            enqueueUploadFiles(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
        <input
          ref={dirPickerRef}
          hidden
          type="file"
          multiple
          {...({
            webkitdirectory: "",
          } as React.InputHTMLAttributes<HTMLInputElement>)}
          onChange={(e) => {
            enqueueUploadFiles(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
      </section>
    </div>
  );
}
