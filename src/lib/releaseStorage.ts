/**
 * 压点放行单的本地存档（只追加、不改写、不删除）。
 *
 * 放行单是不可变快照，存档同样只追加：每次成功签发把新单据追加到数组末尾，
 * 历史单据始终只读复核，任何草稿或后续修改都不能覆盖它们。
 *
 * 关键约束（与校准存档一致的失败保护策略）：
 *  - 只有结构完整、版本相符、且能用领域服务重新计算一致的单据才恢复为历史；
 *  - 旧版、损坏或字段不符的存档明确告警，只展示最近一次完整记录用于取证，
 *    绝不自动覆盖原存档；
 *  - 写入失败（配额 / 权限）返回 false，原 localStorage 记录逐字保留，
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
/** 追加写入前对单条数上限，防止异常循环写爆配额；正常班组使用远低于此。 */
const MAX_STORED_SLIPS = 200;

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
  | 'write-failed';

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
  return { ok: true, slips };
}

/**
 * 追加签发放行单。
 * @returns false 表示存档处于保护态、契约非法或浏览器写入失败；
 *          此时原 localStorage 记录逐字不变，调用方必须把失败反馈给操作员。
 */
export function appendReleaseSlip(slip: ReleaseSlip): boolean {
  if (!isWellFormedSlip(slip)) {
    return false;
  }
  // 保护态（损坏 / 未知版本）下绝不自动覆盖原存档。
  const current = loadReleaseState();
  if (current.protected) {
    return false;
  }

  // 同标识单据视为重复写入（幂等），不重复追加。
  if (current.slips.some((existing) => existing.id === slip.id)) {
    memorySlips = current.slips.slice();
    return true;
  }

  const next = [...current.slips, slip].slice(-MAX_STORED_SLIPS);
  const store = storage();
  if (!store) {
    return false;
  }
  const serialized = JSON.stringify({ version: CURRENT_STORAGE_VERSION, slips: next });
  try {
    store.setItem(STORAGE_KEY, serialized);
  } catch {
    // 主记录配额或权限失败：不吞掉错误，原 localStorage 记录仍可恢复。
    return false;
  }
  // 主记录写入成功后再刷新冗余备份；备份失败不影响本次签发（主记录完整可恢复），
  // 但会影响下次“主记录被外部改坏”时的取证余量，故静默保留内存最近完整记录。
  try {
    store.setItem(BACKUP_KEY, serialized);
  } catch {
    // 忽略备份失败：主记录与内存缓存均已是完整记录。
  }
  memorySlips = next.slice();
  return true;
}

/** 写入失败时供界面展示的告警文案（不产生任何写入）。 */
export function writeFailureWarning(): ReleaseStorageWarning {
  return makeWarning('write-failed');
}

/** 测试辅助：清空进程内最近一次完整记录缓存。 */
export function __resetReleaseMemoryForTests(): void {
  memorySlips = [];
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
    return true;
  } catch {
    return false;
  }
}
