/**
 * 每日洞察的领域类型。
 *
 * 分层：**信号**（证据）→ **成稿**（模型或模板产出的文案）→ **条目**（落盘的版本）。
 * 设计见 docs/daily-journal-plan.zh-CN.md。
 */

/** 证据类别。一期只接记忆（`memory`）；其余留给后续（文件/会话/日程/连接器）。 */
export type JournalSignalKind = "memory";

/** 一条进得了摘要的证据。`id` 必须稳定（`memory:<id>` 等），用作去重与来源回指。 */
export interface JournalSignal {
  id: string;
  kind: JournalSignalKind;
  /** 发生时间（ISO）。 */
  at: string;
  /** 一行标题（≤48 字），只用于日志与兜底文案。 */
  title: string;
  /** 进 prompt 的唯一正文（≤160 字）。 */
  excerpt: string;
  /** 0..1 权重，见 ranker 公式。 */
  weight: number;
  /** 同簇被合并进来的条数（0 = 独立一条）。 */
  merged: number;
  category?: "fact" | "lesson";
  confidence?: "observed" | "inferred" | "verified";
}

/** 成稿里的一条要点。`sourceIds` 必须来自当次输入集合（解析层硬校验）。 */
export interface JournalBullet {
  text: string;
  sourceIds: string[];
}

/**
 * 成稿里的一个可点动作。一期只开放 `ask-agent`：证据只有记忆条目，
 * 没有文件可开（等接入文件信号后再放开 `open-file`）。
 */
export interface JournalAction {
  label: string;
  kind: "ask-agent";
  targetId: string;
}

/** 一份成稿（模型产出或模板兜底，同一形状）。 */
export interface JournalComposition {
  headline: string;
  summary: string;
  bullets: JournalBullet[];
  actions: JournalAction[];
}

/** 落盘的一版条目。 */
export interface JournalEntryRecord extends JournalComposition {
  id: string;
  date: string;
  version: number;
  /** null = 模板兜底。 */
  model: string | null;
  createdAt: string;
}

export type JournalStatus = "pending" | "generating" | "ready" | "failed";

export type JournalTrigger = "boot" | "memory" | "tick" | "manual";

/** 对外的「今天」视图（桌面 `nxcore.journal.today()` 的返回体）。 */
export interface JournalTodayView {
  /** 本地时区日期（YYYY-MM-DD）。 */
  date: string;
  entry: JournalEntryRecord | null;
  status: JournalStatus;
  signalCount: number;
  lastError: string | null;
}

/** 采集结果：当天证据 + 用于跳过的指纹。 */
export interface JournalSnapshot {
  date: string;
  signals: JournalSignal[];
  /** 当天证据总条数（含被合并的），用于副标题。 */
  signalCount: number;
  fingerprint: string;
}
