/**
 * 压点放行单的本地存档（只追加、不改写、不删除、不静默丢弃）。
 *
 * 放行单是不可变快照，存档同样只追加：每次成功签发把新单据追加到数组末尾，
 * 历史单据始终只读复核，任何草稿或后续修改都不能覆盖它们。
 *
 * 关键约束（与校准存档一致的失败保护策略）：
 *  - 只有结构完整、版本相符、且能用领域服务重新计算一致的单据才恢复为历史；
 *  - 旧版、损坏或字段不符的存档明确告警，只展示最近一次完整记录用于取证，
 *    绝不自动覆盖原存档；
 *  - 历史**只增不删**：第 201 张及以后的单据全部保留，绝不在达到某个数量后
 *    静默移除最早的单据（批次追责、交接复核与再次打印都依赖完整历史）；
 *  - 追加写入采用“读取最新持久化记录 → 合并 → 一次性写回”：即使两个浏览器
 *    页签交错签发，每次写入都以磁盘上的最新列表为基准合并，后写入的一份
 *    绝不会覆盖另一份；
 *  - 编号冲突必须给出明确结果：同编号且内容逐字一致视为重复写入（幂等）；
 *    同编号但快照内容不同则明确拒绝，当前单据不会被冒充成历史原件；
 *  - 写入失败（配额 / 权限）返回失败结果，原 localStorage 记录逐字保留，
 *    内存中仍保留最近一次完整记录，界面明确告警。
 */
import { isWellFormedSlip, type ReleaseSlip } from './release';

const STORAGE_KEY = 'braille-plate:release:v1';
/**
 * 最近一次完整写入的冗余备份：主存档被外部改坏（如坏 JSON、未知版本、单据损坏）
 * 或刷新后内存缓存为空时，仍能用这份“最近一次完整记录”只读取证并明确告警。
 * 备份只用于恢复展示，主存档一日不修复，存档就一直处于保护态、拒绝新写入。
 */
const BACKUP_KEY = 'braille-plate:release:v1:backup';
const CURRENT_STORAGE_VERSION = 1;

/**
 * 追加写入的明确结果。历史增长、页签交错与编号冲突都必须让调用方（操作员）
 * 得到明确反馈，不能静默成功或静默丢单。
 */
export type AppendReleaseResult =
  | {
      /** 单据已在历史末尾（本次新写入）。 */
      outcome: 'appended';
      /** 写入后的完整历史（签发顺序，只读）。 */
      slips: ReleaseSlip[];
    }
  | {
      /** 同编号、同内容的单据已在历史中：重复签发幂等，不重复追加。 */
      outcome: 'duplicate';
      /** 已存在的那份单据（与提交件逐字一致）。 */
      existing: ReleaseSlip;
      slips: ReleaseSlip[];
    }
  | {
      /** 编号冲突：历史中已有同编号但内容不同的单据，本次签发拒绝写入。 */
      outcome: 'id-conflict';
      /** 历史中占用该编号的原件。 */
      existing: ReleaseSlip;
      /** 冲突告警文案。 */
      error: string;
    }
  | {
      /** 存档处于保护态（损坏 / 版本不符），按失败保护策略拒绝写入。 */
      outcome: 'protected';
      /** 保护态告警文案。 */
      error: string;
    }
  | {
      /** 单据契约非法（结构不完整 / 无法复核），拒绝写入。 */
      outcome: 'invalid-slip'
    }
  | {
      /** 浏览器写入失败（配额 / 权限），原存档逐字保留。 */
      outcome: 'write-failed';
      /** 写入失败告警文案。 */
      error: string;
    };

export interface StoredReleases {
  /** 可安全复核的历史放行单（签发顺序），冻结为只读。 */
  slips: ReleaseSlip[];
  /** 存档无法安全恢复时的告警；此时禁止任何写入。 */
  warning: ReleaseStorageWarning | null;
  /** true 表示当前 localStorage 存档处于保护态（损坏 / 版本不符）。 */
  protected: boolean;
}

export type ReleaseStorageWarningKind =
  | 'corrupted-json'
  | 'corrupted-record'
  | 'unknown-version'
  | 'invalid-slip'
  | 'write-failed'
  | 'id-conflict';

export interface ReleaseStorageWarning {
  kind: ReleaseStorageWarningKind;
  message: string;
}

interface VersionedReleases {
  version?: unknown;
  slips?: unknown;
}

/**
 * 进程内最近一次完整记录：localStorage 被外部改坏或写入失败时，
 * 界面仍可据此只读复核并明确告警，不会突然丢光历史。
 */
let memorySlips: ReleaseSlip[] = [];

/**
 * 已成功解析过的原始记录缓存：同一页签连续签发时，下一次读取到的原始字符串
 * 就是自己刚写入的那份，逐字一致即可直接复用已校验结果，不必对整段历史
 * （可能数百张）重新做一遍领域重算。其它页签 / 外部写入会产生不同的字符串，
 * 缓存自然失效，仍走完整结构与一致性校验。只缓存解析**成功**的结果，
 * 损坏记录绝不缓存；最多保留两份（自己刚写的 + 刚观察到的对端写入）。
 */
interface ParsedCacheEntry {
  raw: string;
  slips: ReleaseSlip[];
}
const parseCache: ParsedCacheEntry[] = [];
const PARSE_CACHE_LIMIT = 2;

function rememberParsed(raw: string, slips: ReleaseSlip[]): ReleaseSlip[] {
  const index = parseCache.findIndex((entry) => entry.raw === raw);
  if (index !== -1) {
    parseCache.splice(index, 1);
  }
  parseCache.push({ raw, slips });
  while (parseCache.length > PARSE_CACHE_LIMIT) {
    parseCache.shift();
  }
  return slips;
}

function clearParseCache(): void {
  parseCache.length = 0;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function warningMessage(kind: ReleaseStorageWarningKind): string {
  const prefix = '本地放行单存档无法安全恢复：';
  const retain = ' 已保留最近一次完整记录与原始存档用于取证；请检查浏览器存储，在修复前不会自动覆盖。';
  switch (kind) {
    case 'corrupted-json':
      return `${prefix}存档不是合法 JSON。${retain}`;
    case 'corrupted-record':
      return `${prefix}存档字段缺失或类型损坏。${retain}`;
    case 'unknown-version':
      return `${prefix}存档版本无法识别，不能信任其中的放行单。${retain}`;
    case 'invalid-slip':
      return `${prefix}存在结构损坏或内容无法复核的放行单，已停止恢复并保留原存档。${retain}`;
    case 'id-conflict':
      return '放行单编号冲突：历史中已存在相同编号但内容不同的单据，本次签发已拒绝，历史原件逐字保留。请核对后重新签发。';
    case 'write-failed':
      return '放行单写入失败（可能是配额不足或权限受限）：本次签发未写入，历史放行单与原存档仍保留。';
  }
}

function makeWarning(kind: ReleaseStorageWarningKind): ReleaseStorageWarning {
  return { kind, message: warningMessage(kind) };
}

function protectedState(slips: ReleaseSlip[], kind: ReleaseStorageWarningKind): StoredReleases {
  return { slips: slips.map((slip) => Object.freeze(slip) as ReleaseSlip), warning: makeWarning(kind), protected: true };
}

/**
 * 读取历史放行单。损坏时返回最近一次完整记录（内存缓存，或冗余备份）并告警，
 * 绝不返回半张损坏单据，也不覆盖 localStorage 原文。
 */
export function loadReleaseState(): StoredReleases {
  const empty: StoredReleases = { slips: memorySlips.slice(), warning: null, protected: false };
  const store = storage();
  if (!store) {
    return empty;
  }

  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { ...empty, warning: makeWarning('corrupted-record'), protected: true };
  }
  if (!raw) {
    // 存储被清空（或从未写入）：内存缓存也同步清空，避免幽灵历史。
    memorySlips = [];
    return { slips: [], warning: null, protected: false };
  }

  const parsedRecord = parseVersionedReleases(raw);
  if (parsedRecord.ok) {
    memorySlips = parsedRecord.slips.slice();
    return { slips: parsedRecord.slips, warning: null, protected: false };
  }

  // 主存档不可信：先看冗余备份里有没有“最近一次完整记录”可只读取证。
  const backup = readBackup(store);
  const fallbackSlips = memorySlips.length > 0 ? memorySlips : backup;
  return protectedState(fallbackSlips, parsedRecord.kind);
}

function readBackup(store: Storage): ReleaseSlip[] {
  let raw: string | null = null;
  try {
    raw = store.getItem(BACKUP_KEY);
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  const parsed = parseVersionedReleases(raw);
  return parsed.ok ? parsed.slips : [];
}

type ParsedReleases =
  | { ok: true; slips: ReleaseSlip[] }
  | { ok: false; kind: ReleaseStorageWarningKind };

function parseVersionedReleases(raw: string): ParsedReleases {
  const cached = parseCache.find((entry) => entry.raw === raw);
  if (cached) {
    return { ok: true, slips: cached.slips.slice() };
  }
  let parsed: VersionedReleases;
  try {
    parsed = JSON.parse(raw) as VersionedReleases;
  } catch {
    return { ok: false, kind: 'corrupted-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, kind: 'corrupted-record' };
  }
  if (parsed.version !== undefined && parsed.version !== CURRENT_STORAGE_VERSION) {
    return { ok: false, kind: 'unknown-version' };
  }
  if (!Array.isArray(parsed.slips)) {
    return { ok: false, kind: 'corrupted-record' };
  }
  const slips: ReleaseSlip[] = [];
  for (const candidate of parsed.slips) {
    if (!isWellFormedSlip(candidate)) {
      return { ok: false, kind: 'invalid-slip' };
    }
    slips.push(Object.freeze(candidate) as ReleaseSlip);
  }
  rememberParsed(raw, slips);
  return { ok: true, slips };
}

/** 两份放行单逐字段深比较（存档均为 JSON 可序列化数据，按结构比较即可）。 */
function slipsEqual(left: ReleaseSlip, right: ReleaseSlip): boolean {
  if (left.id !== right.id) {
    return false;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return left === right;
  }
}

/**
 * 把新单据合并进最新历史。合并纯函数化，便于在单元层精确验证“页签交错”
 * 与“编号冲突”两类场景：
 *  - 历史中不存在同编号：追加到末尾；
 *  - 存在同编号且内容逐字一致：幂等，返回已存在的那份；
 *  - 存在同编号但内容不同：编号冲突，拒绝合并。
 */
export function mergeReleaseSlip(
  history: readonly ReleaseSlip[],
  slip: ReleaseSlip
):
  | { outcome: 'appended'; slips: ReleaseSlip[] }
  | { outcome: 'duplicate'; existing: ReleaseSlip; slips: ReleaseSlip[] }
  | { outcome: 'id-conflict'; existing: ReleaseSlip } {
  const index = history.findIndex((existing) => existing.id === slip.id);
  if (index === -1) {
    return { outcome: 'appended', slips: [...history, slip] };
  }
  const existing = history[index];
  if (slipsEqual(existing, slip)) {
    return { outcome: 'duplicate', existing, slips: history.slice() };
  }
  return { outcome: 'id-conflict', existing };
}

/**
 * 追加签发放行单。
 *
 * 每次写入都重新读取 localStorage 中的**最新持久化列表**再合并，因此两个
 * 页签交错签发时，任何一方都不会用自己的旧内存列表覆盖对方刚写入的单据；
 * 历史只增不删，配额 / 权限失败时原记录逐字保留。
 *
 * @returns 区分“新追加 / 幂等重复 / 编号冲突 / 保护态 / 契约非法 / 写入失败”
 *          的明确结果；任何失败都不改变 localStorage，调用方必须把结果
 *          反馈给操作员。
 */
export function appendReleaseSlip(slip: ReleaseSlip): AppendReleaseResult {
  if (!isWellFormedSlip(slip)) {
    return { outcome: 'invalid-slip' };
  }

  const store = storage();
  if (!store) {
    return { outcome: 'write-failed', error: warningMessage('write-failed') };
  }

  // 以磁盘最新状态为基准（而非内存缓存），杜绝页签交错时的覆盖丢失。
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { outcome: 'protected', error: warningMessage('corrupted-record') };
  }

  let baseSlips: ReleaseSlip[];
  if (!raw) {
    baseSlips = [];
  } else {
    const parsed = parseVersionedReleases(raw);
    if (!parsed.ok) {
      // 主存档不可信：刷新内存 / 取证视图并转入保护态，绝不自动覆盖原存档。
      const backup = readBackup(store);
      const fallback = memorySlips.length > 0 ? memorySlips : backup;
      memorySlips = fallback.slice();
      return { outcome: 'protected', error: warningMessage(parsed.kind) };
    }
    baseSlips = parsed.slips;
  }

  const merged = mergeReleaseSlip(baseSlips, slip);
  if (merged.outcome === 'id-conflict') {
    // 冲突时不发生任何写入；同步内存视图，让界面能复核占用编号的原件。
    memorySlips = baseSlips.slice();
    return { outcome: 'id-conflict', existing: merged.existing, error: warningMessage('id-conflict') };
  }
  if (merged.outcome === 'duplicate') {
    // 同编号同内容：重复签发幂等。同步内存视图后返回已存在的那份。
    memorySlips = merged.slips.slice();
    return { outcome: 'duplicate', existing: merged.existing, slips: merged.slips };
  }

  // 历史只增不删，不设静默裁剪上限；配额不足由浏览器抛错并明确反馈。
  const serialized = JSON.stringify({ version: CURRENT_STORAGE_VERSION, slips: merged.slips });
  try {
    store.setItem(STORAGE_KEY, serialized);
  } catch {
    // 主记录配额或权限失败：不吞掉错误，原 localStorage 记录仍可恢复。
    return { outcome: 'write-failed', error: warningMessage('write-failed') };
  }
  // 主记录写入成功后再刷新冗余备份；备份失败不影响本次签发（主记录完整可恢复），
  // 但会影响下次“主记录被外部改坏”时的取证余量，故静默保留内存最近完整记录。
  try {
    store.setItem(BACKUP_KEY, serialized);
  } catch {
    // 忽略备份失败：主记录与内存缓存均已是完整记录。
  }
  memorySlips = merged.slips.slice();
  return { outcome: 'appended', slips: merged.slips };
}

/** 写入失败时供界面展示的告警文案（不产生任何写入）。 */
export function writeFailureWarning(): ReleaseStorageWarning {
  return makeWarning('write-failed');
}

/** 编号冲突时供界面展示的告警文案（不产生任何写入）。 */
export function idConflictWarning(): ReleaseStorageWarning {
  return makeWarning('id-conflict');
}

/** 测试辅助：清空进程内最近一次完整记录缓存。 */
export function __resetReleaseMemoryForTests(): void {
  memorySlips = [];
  clearParseCache();
}

/** 清空所有放行单本地存档（仅测试或未来显式管理入口使用）。失败时保留原存档。 */
export function clearReleaseState(): boolean {
  const store = storage();
  if (!store) {
    return false;
  }
  try {
    store.removeItem(STORAGE_KEY);
    store.removeItem(BACKUP_KEY);
    memorySlips = [];
    clearParseCache();
    return true;
  } catch {
    return false;
  }
}
