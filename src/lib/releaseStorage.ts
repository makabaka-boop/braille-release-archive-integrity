/**
 * 压点放行单的本地存档（只追加、不改写、不删除、不静默丢弃）。
 *
 * 放行单是不可变快照，存档同样只追加：每次成功签发把新单据追加到数组末尾，
 * 历史单据始终只读复核，任何草稿或后续修改都不能覆盖它们。
 *
 * 三条历史可信底线：
 *  1. 历史只增不减：不设条数上限——第 201 张、第 2001 张与第一张一样必须可查，
 *     绝不能静默顶掉最早的单据；
 *  2. 跨页签交错写入不丢单：追加采用“读当前存档 → 合并 → 写回 → 再读校验”的
 *     乐观并发循环，发现自己刚写的单据不在存档里说明被其它页签覆盖，立即带着
 *     最新存档重试，直到两张单据都落库（或写入配额 / 权限失败，原存档逐字保留）；
 *  3. 编号冲突给出明确结果：相同编号且内容逐字一致视为同一张单据（幂等，成功）；
 *     相同编号但内容不同是不可调和的冲突，拒绝写入、保留原单据并明确告警，
 *     绝不把新内容当成已存档原件，也不让“当前放行单”与历史原件不一致。
 *
 * 关键约束（与校准存档一致的失败保护策略）：
 *  - 只有结构完整、版本相符、且能用领域服务重新计算一致的单据才恢复为历史；
 *  - 旧版、损坏或字段不符的存档明确告警，只展示最近一次完整记录用于取证，
 *    绝不自动覆盖原存档；
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
 * 交错写入的乐观重试上限。每次重试都基于刚读到的最新存档合并；
 * 正常两个页签几乎首轮即收敛。超限说明存在极端持续抢占，按写入冲突失败处理，
 * 绝不静默丢单，也不无限循环写爆配额。
 */
const MAX_APPEND_ATTEMPTS = 10;

/** 追加签发放行单的结果：失败类别与告警一一对应，调用方必须向操作员明确反馈。 */
export type AppendReleaseOutcome =
  | { ok: true }
  | { ok: false; kind: Extract<ReleaseStorageWarningKind, 'write-failed' | 'id-conflict' | 'write-contention'> };

export interface StoredReleases {
  /** 可安全复核的历史放行单（签发顺序），冻结为只读。 */
  slips: ReleaseSlip[];
  /** 存档无法安全恢复时的告警；此时禁止任何写入。 */
  warning: ReleaseStorageWarning | null;
  /** true 表示当前 localStorage 存档处于保护态（损坏 / 版本不符）。 */
  protected: boolean;
  /** 跨页签覆盖被自动修复等一次性状态提示（不阻断签发）；读取后由界面清空。 */
  notice: ReleaseStorageWarning | null;
}

export type ReleaseStorageWarningKind =
  | 'corrupted-json'
  | 'corrupted-record'
  | 'unknown-version'
  | 'invalid-slip'
  | 'write-failed'
  | 'id-conflict'
  | 'write-contention'
  | 'cross-tab-repaired';

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
 * 本页签成功签发过的全部单据（跨页签覆盖后的认领依据）。
 *
 * 两个页签交错签发时，浏览器里每次 setItem 是同步原子的，但“读旧列表 →
 * 追加 → 写整表”这一序列可能交错：后写的整表不含先写的单据。storage 事件
 * 是异步投递的，丢失方在收到事件时据此把自己签发过、却已不在新整表里的
 * 单据合并补写回去。刷新（JS 上下文重建）后该集合清空——那时单据本应由
 * 仍在线的其它页签补回，或已在主存档 / 冗余备份中。
 */
const localIssued = new Map<string, ReleaseSlip>();
/** 跨页签修复等一次性状态提示，挂在下一次 loadReleaseState 的结果里。 */
let pendingNotice: ReleaseStorageWarning | null = null;

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
    case 'write-failed':
      return '放行单写入失败（可能是配额不足或权限受限）：本次签发未写入，历史放行单与原存档仍保留。';
    case 'id-conflict':
      return '放行单编号与历史单据相同但内容不一致：已拒绝本次写入，历史原单据逐字保留。请重新签发以生成新编号，切勿把当前展示内容当作历史原件。';
    case 'write-contention':
      return '多个页签同时签发放行单且持续交错：本次写入未能稳定落库，已停止重试，历史原存档逐字保留。请复核历史后重新签发。';
    case 'cross-tab-repaired':
      return '检测到其它页签的旧列表覆盖了放行存档（有已签发单据丢失）：已自动把本页签签发的单据合并补写回历史，全部单据可只读复核。';
  }
}

function makeWarning(kind: ReleaseStorageWarningKind): ReleaseStorageWarning {
  return { kind, message: warningMessage(kind) };
}

function protectedState(slips: ReleaseSlip[], kind: ReleaseStorageWarningKind): StoredReleases {
  return {
    slips: slips.map((slip) => Object.freeze(slip) as ReleaseSlip),
    warning: makeWarning(kind),
    protected: true,
    notice: pendingNotice
  };
}

/**
 * 读取历史放行单。损坏时返回最近一次完整记录（内存缓存，或冗余备份）并告警，
 * 绝不返回半张损坏单据，也不覆盖 localStorage 原文。
 */
export function loadReleaseState(): StoredReleases {
  const notice = pendingNotice;
  pendingNotice = null;
  const empty: StoredReleases = { slips: memorySlips.slice(), warning: null, protected: false, notice };
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
    // 存储被清空（或从未写入）：内存缓存与本页签认领集合一并清空，
    // 既避免幽灵历史，也避免旧认领把单据“补回”一份被有意清空的存档。
    memorySlips = [];
    localIssued.clear();
    return { slips: [], warning: null, protected: false, notice };
  }

  const parsedRecord = parseVersionedReleases(raw);
  if (parsedRecord.ok) {
    memorySlips = parsedRecord.slips.slice();
    return { slips: parsedRecord.slips, warning: null, protected: false, notice };
  }

  // 主存档不可信：先看冗余备份里有没有“最近一次完整记录”可只读取证。
  const backup = readBackup(store);
  const fallbackSlips = memorySlips.length > 0 ? memorySlips : backup;
  return protectedState(fallbackSlips, parsedRecord.kind);
}

/**
 * 跨页签修复：收到其它页签的整表写入时，把本页签签发过、却不在新整表里的
 * 单据合并补写。只做“补缺”：已在存档中的同编号单据一律以存档原件为准
 * （编号冲突在直接签发时拦截，修复路径绝不覆盖任何已落库原件）。
 */
function healAfterCrossTabWrite(store: Storage): void {
  if (localIssued.size === 0) {
    return;
  }
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  // 存档损坏 / 为空 / 不可解析：交给保护态与既有失败处理，修复路径不碰它。
  if (!raw) {
    return;
  }
  const parsed = parseVersionedReleases(raw, { recompute: false });
  if (!parsed.ok) {
    return;
  }

  const presentIds = new Set(parsed.slips.map((slip) => slip.id));
  const missing = [...localIssued.values()].filter((slip) => !presentIds.has(slip.id));
  if (missing.length === 0) {
    memorySlips = parsed.slips.slice();
    return;
  }

  // 仍带认领循环写回，避免与其它页签的修复再次交错（极端情况下互相补缺，
  // 上限保护防止无限抢占；失败只提示，绝不静默，也不覆盖原存档）。
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const latest = readFreshSlips(store);
    if (!latest.ok) {
      return;
    }
    const stillMissing = missing.filter((slip) => !latest.slips.some((existing) => existing.id === slip.id));
    if (stillMissing.length === 0) {
      memorySlips = latest.slips.slice();
      return;
    }
    const merged = [...latest.slips, ...stillMissing];
    const mergedSerialized = JSON.stringify({ version: CURRENT_STORAGE_VERSION, slips: merged });
    try {
      store.setItem(STORAGE_KEY, mergedSerialized);
    } catch {
      return;
    }
    const verified = readFreshSlips(store);
    if (!verified.ok) {
      return;
    }
    const healed = missing.every((slip) => verified.slips.some((existing) => existing.id === slip.id));
    if (healed) {
      memorySlips = verified.slips.slice();
      try {
        lastTrustedWrittenRaw = store.getItem(STORAGE_KEY) === mergedSerialized ? mergedSerialized : null;
      } catch {
        lastTrustedWrittenRaw = null;
      }
      pendingNotice = makeWarning('cross-tab-repaired');
      try {
        store.setItem(BACKUP_KEY, JSON.stringify({ version: CURRENT_STORAGE_VERSION, slips: verified.slips }));
      } catch {
        // 备份失败不影响已完成的修复。
      }
      return;
    }
  }
  pendingNotice = makeWarning('write-contention');
}

function onCrossTabStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) {
    return;
  }
  const store = storage();
  if (store) {
    healAfterCrossTabWrite(store);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onCrossTabStorage);
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

/**
 * 最近一次通过“完整领域重算”校验的存档原文（逐字节）。
 * 追加 / 修复热路径每轮都会重新读整表，但表里除新单外的每张单据此前都已
 * 完整校验且未变化；字节相同即跳过昂贵的逐单重算，避免历史越长签发越慢。
 */
let lastFullyValidatedRaw: string | null = null;
/**
 * 本页签最近一次自己写回且复核通过的整表原文：
 * 自己的后续追加读到它时无需重算（单据不可能在本页签同步代码之间被篡改）；
 * 一旦读到其它页签写入的不同整表，立即恢复完整重算，防止外部内容混入。
 */
let lastTrustedWrittenRaw: string | null = null;

function parseVersionedReleases(
  raw: string,
  options: { recompute: boolean } = { recompute: true }
): ParsedReleases {
  // 完整校验模式下，与最近一次完整校验通过的存档逐字节相同时直接信任。
  if (options.recompute && raw === lastFullyValidatedRaw) {
    return parseVersionedReleases(raw, { recompute: false });
  }
  let parsed: VersionedReleases;
  try {
    parsed = JSON.parse(raw) as VersionedReleases;
  } catch {
    lastFullyValidatedRaw = null;
    return { ok: false, kind: 'corrupted-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    lastFullyValidatedRaw = null;
    return { ok: false, kind: 'corrupted-record' };
  }
  if (parsed.version !== undefined && parsed.version !== CURRENT_STORAGE_VERSION) {
    lastFullyValidatedRaw = null;
    return { ok: false, kind: 'unknown-version' };
  }
  if (!Array.isArray(parsed.slips)) {
    lastFullyValidatedRaw = null;
    return { ok: false, kind: 'corrupted-record' };
  }
  const slips: ReleaseSlip[] = [];
  for (const candidate of parsed.slips) {
    if (!isWellFormedSlip(candidate, { recompute: options.recompute })) {
      lastFullyValidatedRaw = null;
      return { ok: false, kind: 'invalid-slip' };
    }
    slips.push(Object.freeze(candidate) as ReleaseSlip);
  }
  if (options.recompute) {
    lastFullyValidatedRaw = raw;
  }
  return { ok: true, slips };
}

/**
 * 追加签发放行单。
 *
 * 采用“读取最新存档 → 合并新单 → 写回 → 重新读取校验”的乐观并发循环，
 * 保证多个浏览器页签交错签发时没有任何一张单据被后写入的列表整体覆盖：
 * 若校验时发现刚写入的单据不在存档里（说明在本次读写间隙被其它页签的
 * 列表覆盖），就带着刚读到的最新列表合并后重试，直到本单稳定落库
 * （或写入配额 / 权限失败，原存档逐字保留）。
 *
 * 编号冲突的明确结果：
 *  - 同编号且快照内容逐字一致 → 同一张单据的重复写入，幂等成功；
 *  - 同编号但内容不同 → 不可调和冲突，拒绝写入、保留历史原件并返回
 *    `id-conflict`，绝不允许“当前放行单”冒充历史编号的原件。
 *
 * @returns 结构化结果；失败时原 localStorage 记录逐字不变，
 *          调用方必须把失败类别与文案反馈给操作员。
 */
export function appendReleaseSlip(slip: ReleaseSlip): AppendReleaseOutcome {
  if (!isWellFormedSlip(slip)) {
    return { ok: false, kind: 'write-failed' };
  }
  const store = storage();
  if (!store) {
    return { ok: false, kind: 'write-failed' };
  }

  // 签发前读取存档：结构损坏 / 未知版本 / 内容无法重算（保护态）时绝不写入。
  const initial = readForAppend(store);
  if (!initial.ok) {
    return { ok: false, kind: 'write-failed' };
  }

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    // 每轮都重新读取当前存档（热路径只做结构校验）：拿到的是跨页签交错后的最新列表。
    const current = readForAppend(store);
    if (!current.ok) {
      // 存档恰好在此刻被外部改坏：保持原状并按失败处理，绝不覆盖坏记录。
      return { ok: false, kind: 'write-failed' };
    }

    const existingIndex = current.slips.findIndex((existing) => existing.id === slip.id);
    if (existingIndex >= 0) {
      // 相同编号：内容逐字一致才是幂等的同一张单据；否则是明确的编号冲突。
      if (slipContentEqual(current.slips[existingIndex], slip)) {
        memorySlips = current.slips.slice();
        localIssued.set(slip.id, current.slips[existingIndex]);
        return { ok: true };
      }
      return { ok: false, kind: 'id-conflict' };
    }

    // 历史只增不减：直接追加，不截断、不顶掉最早单据。
    const next = [...current.slips, slip];
    const serialized = JSON.stringify({ version: CURRENT_STORAGE_VERSION, slips: next });
    try {
      store.setItem(STORAGE_KEY, serialized);
    } catch {
      // 主记录配额或权限失败：不吞掉错误，原 localStorage 记录仍可恢复。
      return { ok: false, kind: 'write-failed' };
    }

    // 写回后立即重新读取校验：若本单已不在存档中，说明写间隙被其它页签的
    // 完整列表覆盖，带着最新列表进入下一轮合并重试，两张单最终都会保留。
    const verified = readFreshSlips(store);
    if (!verified.ok) {
      // 存档恰好在此刻被外部改坏：保持原状并按失败处理，绝不覆盖坏记录。
      return { ok: false, kind: 'write-failed' };
    }
    if (!verified.slips.some((existing) => existing.id === slip.id)) {
      continue;
    }

    // 确认稳定落库后再刷新冗余备份；备份失败不影响本次签发（主记录完整可恢复），
    // 但会影响下次“主记录被外部改坏”时的取证余量，故静默保留内存最近完整记录。
    memorySlips = verified.slips.slice();
    localIssued.set(slip.id, slip);
    // 只有当前主存档与本次写回逐字节相同，后续追加才允许跳过重算。
    try {
      lastTrustedWrittenRaw = store.getItem(STORAGE_KEY) === serialized ? serialized : null;
    } catch {
      lastTrustedWrittenRaw = null;
    }
    try {
      store.setItem(BACKUP_KEY, JSON.stringify({ version: CURRENT_STORAGE_VERSION, slips: verified.slips }));
    } catch {
      // 忽略备份失败：主记录与内存缓存均已是完整记录。
    }
    return { ok: true };
  }

  // 重试上限：极端持续交错下也明确失败，绝不静默丢单或无限循环写爆配额。
  return { ok: false, kind: 'write-contention' };
}

/**
 * 追加写入路径读取存档：本页签自己写回的整表（原文逐字节未变）直接信任，
 * 其它页签写入的新整表必须通过完整领域重算。这样连续签发是线性开销，
 * 而外部 / 跨页签篡改仍会在第一张单据写入前被保护态拦下。
 */
function readForAppend(store: Storage): ParsedReleases {
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { ok: false, kind: 'corrupted-record' };
  }
  if (!raw) {
    return { ok: true, slips: [] };
  }
  return parseVersionedReleases(raw, { recompute: raw !== lastTrustedWrittenRaw });
}

/**
 * 不经内存缓存、直接读取并校验当前 localStorage 主存档（热路径只做结构校验）。
 */
function readFreshSlips(store: Storage): ParsedReleases {
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { ok: false, kind: 'corrupted-record' };
  }
  if (!raw) {
    return { ok: true, slips: [] };
  }
  // 追加 / 修复循环刚写回：旧单据都已完整校验且未变，只需结构校验确认
  // 写回完整、新单可解析；是否被外部改坏由下一次完整 loadReleaseState 兜底。
  return parseVersionedReleases(raw, { recompute: false });
}

/**
 * 比较两张放行单内容是否逐字一致（编号已相等的前提下）。
 * 两份单据都通过了结构与领域重算校验，序列化比较足以区分“同一原件的重复写入”
 * 与“同编号不同内容”的冲突。
 */
function slipContentEqual(left: ReleaseSlip, right: ReleaseSlip): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 供界面展示指定失败类别的告警文案（不产生任何写入）。 */
export function appendFailureWarning(kind: 'write-failed' | 'id-conflict' | 'write-contention'): ReleaseStorageWarning {
  return makeWarning(kind);
}

/** 测试辅助：清空进程内最近一次完整记录、跨页签认领集合与一次性提示。 */
export function __resetReleaseMemoryForTests(): void {
  memorySlips = [];
  localIssued.clear();
  pendingNotice = null;
  lastFullyValidatedRaw = null;
  lastTrustedWrittenRaw = null;
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
    lastFullyValidatedRaw = null;
    lastTrustedWrittenRaw = null;
    return true;
  } catch {
    return false;
  }
}
