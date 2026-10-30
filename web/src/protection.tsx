import { useEffect, useState } from "react";
import { ChevronRight, ShieldCheck, ShieldAlert } from "lucide-react";

type Backup = {
  completed?: string;
  created?: string;
  verification?: string;
  restoreVerification?: string;
};
type Coverage = Backup & {
  host?: string;
  scope?: string;
  state?: string;
  capturedAt?: string;
  lastCheck?: string;
  source?: "portal" | "agent-ssh";
};
type Recovery = {
  policy?: { host?: string; state?: string; available?: boolean; error?: string };
  lastBackup?: Backup | null;
  coverage?: Coverage[];
  metadataError?: string;
};

export function ProtectionSummary() {
  const [recovery, setRecovery] = useState<Recovery>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/portal/api/recovery", { credentials: "same-origin", signal: controller.signal, cache: "no-store" });
        if (response.status === 401) throw new Error("请在门户查看备份状态");
        if (!response.ok) throw new Error("备份状态暂不可用");
        const data: Recovery = await response.json();
        if (!controller.signal.aborted) {
          setRecovery(data);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "备份状态暂不可用");
      }
    }
    void load();
    const timer = window.setInterval(load, 60000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  const coverage = recovery?.coverage?.find(item => item.host === "nas" && item.scope === "full");
  // Portal selects the latest full NAS evidence, including agent-created packages.
  const backup = recovery?.coverage ? coverage?.state === "captured" ? coverage : undefined : recovery?.lastBackup;
  const verified = !error && !recovery?.metadataError && backup?.verification === "verified";
  const restored = verified && backup?.restoreVerification === "verified";
  const unknown = recovery && !backup && coverage?.state !== "not-captured";
  const when = recovery?.coverage ? coverage?.capturedAt : recovery?.lastBackup?.completed || recovery?.lastBackup?.created;
  const date = when && !isNaN(Date.parse(when)) ? new Date(when).toLocaleDateString("zh-CN") : "";
  let title = "正在读取备份状态";
  let note = "在门户管理数据保护";
  if (error || recovery?.metadataError || unknown) {
    title = "备份状态未确认";
    note = error || "完整备份记录待核实，请在门户核对";
  } else if (verified) {
    title = date ? `最近备份 · ${date}` : "备份已校验";
    note = restored ? "隔离恢复已验收" : "隔离恢复尚未验收";
    if (recovery?.policy?.available === false) note += " · 存储器未就绪";
  } else if (backup) {
    title = "备份记录待校验";
    note = "在门户核对全量备份与恢复验收";
  } else if (recovery?.policy?.state === "unconfigured") {
    title = "备份存储器未登记";
    note = "在门户配置外置全量备份";
  } else if (recovery?.policy?.available === false) {
    title = "备份存储器未就绪";
    note = "已保存的备份记录请在门户核对";
  } else if (recovery) {
    title = "尚无已校验的备份记录";
    note = "在门户执行备份与恢复验收";
  }
  const Icon = restored ? ShieldCheck : ShieldAlert;
  return (
    <a className={`protection-summary ${restored ? "is-verified" : ""}`} href="/portal/#/backups" title="在门户查看数据保护">
      <Icon size={18} />
      <span><strong>{title}</strong><small>{note}</small></span>
      <ChevronRight size={14} />
    </a>
  );
}
