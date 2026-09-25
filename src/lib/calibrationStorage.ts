/**
 * 试压校准工作区的本地快照持久化。
 *
 * 领域模块（calibration.ts）只负责判定契约，不接触浏览器存储；
 * 本助手负责把“未提交草稿”或“一次成功判定的完整六点快照”
 * 安全地写入 / 读出 localStorage。
 *
 * 关键约束：
 *  - 只有完整六点才可能恢复结论，绝不补空或截断；
 *  - 输入框、judgedRaws 与重新计算出的结论必须来自同一快照；
 *  - 旧版、未知版本或字段损坏时只用于取证展示，不自动覆盖原存档；
 *  - 写入失败必须把失败返回给界面，让原 localStorage 记录继续可恢复。
 */
import { createDraft, judgeCalibration, type CalibrationDraft, type CalibrationResult } from './calibration';

const STORAGE_KEY = 'braille-plate:calibration:v1';
const CURRENT_STORAGE_VERSION = 2;
const POINT_COUNT = 6;

export interface StoredCalibration {
  draft: CalibrationDraft;
  /** 最近一次成功判定（合格/需调机）所用的六点原始读数；无有效快照时为 null。 */
  judgedRaws: string[] | null;
  result: CalibrationResult | null;
  /** 存档无法作为可信快照恢复时的告警；同时禁止自动覆盖原记录。 */
  warning: CalibrationStorageWarning | null;
  /** true 表示当前显示内容来自受保护的异常存档，用户完成新判定前不得写入。 */
  protected: boolean;
  /**
   * 恢复来源的存档版本号：当前版本为 2，兼容恢复的旧版（v1）记录为 1；
   * 损坏、未知版本或无存档时为 null。放行流程据此拒绝“未重新判定的旧版校准”。
   */
  recordVersion: number | null;
}

export type CalibrationStorageWarningKind =
  | 'inconsistent-snapshot'
  | 'short-record'
  | 'overlong-record'
  | 'old-format'
  | 'unknown-version'
  | 'invalid-judgment'
  | 'corrupted-record';

export interface CalibrationStorageWarning {
  kind: CalibrationStorageWarningKind;
  message: string;
}

interface VersionedShape {
  version?: unknown;
  draft?: unknown;
  judgedRaws?: unknown;
}

function isStringArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function exactSixStrings(value: unknown): value is string[] {
  return isStringArray(value) && value.length === POINT_COUNT;
}

function draftReadings(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'readings' in value) {
    return (value as { readings?: unknown }).readings;
  }
  return value;
}

function emptyDraft(): CalibrationDraft {
  return createDraft();
}

function displayDraft(values: string[]): CalibrationDraft {
  return { readings: values.slice() };
}

function displayFromPartial(values: unknown[]): CalibrationDraft {
  return {
    readings: Array.from({ length: POINT_COUNT }, (_, index) =>
      typeof values[index] === 'string' ? (values[index] as string) : ''
    )
  };
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // 隐私模式等场景禁用存储时，退化为仅内存态。
    return null;
  }
}

function warningMessage(kind: CalibrationStorageWarningKind): string {
  const prefix = '本地校准存档无法安全恢复：';
  const retain = ' 已保留原始存档用于取证；请核对六点读数并重新执行判定，在此之前不会自动覆盖。';
  switch (kind) {
    case 'inconsistent-snapshot':
      return `${prefix}草稿与上次判定读数不一致，不能显示原判定结论。${retain}`;
    case 'short-record':
      return `${prefix}记录少于六点，点号对应关系不完整。${retain}`;
    case 'overlong-record':
      return `${prefix}记录多于六点，不能截断后改变点号对应关系。${retain}`;
    case 'old-format':
      return `${prefix}旧版记录格式不完整或已损坏，不能显示有效结论。${retain}`;
    case 'unknown-version':
      return `${prefix}存档版本无法识别，不能信任其中的判定结论。${retain}`;
    case 'invalid-judgment':
      return `${prefix}上次判定读数不能重新形成有效结论。${retain}`;
    case 'corrupted-record':
      return `${prefix}字段缺失或类型已损坏。${retain}`;
  }
}

function makeWarning(kind: CalibrationStorageWarningKind): CalibrationStorageWarning {
  return { kind, message: warningMessage(kind) };
}

function sameReadings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * 读取上次未提交草稿或成功判定快照。
 * 判定结果不直接信任缓存，而是用领域服务按同一快照的读数重新判定。
 */
export function loadCalibrationState(): StoredCalibration {
  const empty: StoredCalibration = {
    draft: emptyDraft(),
    judgedRaws: null,
    result: null,
    warning: null,
    protected: false,
    recordVersion: null
  };
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
    return empty;
  }

  let parsed: VersionedShape;
  try {
    parsed = JSON.parse(raw) as VersionedShape;
  } catch {
    return { ...empty, warning: makeWarning('corrupted-record'), protected: true };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...empty, warning: makeWarning('corrupted-record'), protected: true };
  }

  const hasVersion = parsed.version !== undefined;
  const isLegacy = !hasVersion;

  const draftSource = draftReadings(parsed.draft);
  const judgedSource = parsed.judgedRaws;

  const draftSix = exactSixStrings(draftSource) ? (draftSource as string[]).slice() : null;
  const judgedSix = exactSixStrings(judgedSource) ? (judgedSource as string[]).slice() : null;
  const draftIsArray = isArray(draftSource);
  const judgedIsArray = isArray(judgedSource);

  const unknownCandidate = draftSix ?? judgedSix;
  const unknownDraft = unknownCandidate ? displayDraft(unknownCandidate) :
    draftIsArray && isStringArray(draftSource)
      ? displayFromPartial(draftSource)
      : judgedIsArray && isStringArray(judgedSource)
        ? displayFromPartial(judgedSource)
        : emptyDraft();
  if (hasVersion && parsed.version !== CURRENT_STORAGE_VERSION) {
    return {
      draft: unknownDraft,
      judgedRaws: null,
      result: null,
      warning: makeWarning('unknown-version'),
      protected: true,
      recordVersion: typeof parsed.version === 'number' ? parsed.version : null
    };
  }

  const invalid = (kind: CalibrationStorageWarningKind, shownDraft: CalibrationDraft): StoredCalibration => ({
    draft: shownDraft,
    judgedRaws: null,
    result: null,
    warning: makeWarning(isLegacy ? 'old-format' : kind),
    protected: true,
    // 旧版兼容记录标为版本 1；当前版本的损坏记录为 2；无法辨认时为 null。
    recordVersion: isLegacy ? 1 : hasVersion ? CURRENT_STORAGE_VERSION : null
  });

  const partialDraft =
    draftIsArray && isStringArray(draftSource)
      ? displayFromPartial(draftSource)
      : judgedIsArray && isStringArray(judgedSource)
        ? displayFromPartial(judgedSource)
        : emptyDraft();
  const candidateDraft = draftSix ?? judgedSix;
  const displayedDraft = candidateDraft ? displayDraft(candidateDraft) : partialDraft;

  if (parsed.draft !== undefined && !draftIsArray && !draftSix) {
    return invalid('corrupted-record', displayedDraft);
  }
  if (parsed.judgedRaws !== undefined && judgedSource !== null && !judgedIsArray && !judgedSix) {
    return invalid('corrupted-record', displayedDraft);
  }
  if (draftIsArray && draftSource.length < POINT_COUNT) {
    return invalid('short-record', displayedDraft);
  }
  if (draftIsArray && draftSource.length > POINT_COUNT) {
    return invalid('overlong-record', displayedDraft);
  }
  if (judgedIsArray && judgedSource.length < POINT_COUNT) {
    return invalid('short-record', displayedDraft);
  }
  if (judgedIsArray && judgedSource.length > POINT_COUNT) {
    return invalid('overlong-record', displayedDraft);
  }
  if (!draftSix) {
    return invalid('corrupted-record', displayedDraft);
  }

  // 没有 judgedRaws 字段或显式为 null：这是一份六点完整的未提交草稿。
  if (parsed.judgedRaws === undefined || judgedSource === null) {
    return {
      draft: displayDraft(draftSix),
      judgedRaws: null,
      result: null,
      warning: null,
      protected: false,
      recordVersion: isLegacy ? 1 : CURRENT_STORAGE_VERSION
    };
  }
  if (!judgedSix) {
    return invalid('corrupted-record', displayedDraft);
  }
  if (!sameReadings(draftSix, judgedSix)) {
    return invalid('inconsistent-snapshot', displayedDraft);
  }

  let result: CalibrationResult;
  try {
    result = judgeCalibration(judgedSix);
  } catch {
    return invalid('invalid-judgment', displayedDraft);
  }
  if (result.verdict === 'blocked') {
    return invalid('invalid-judgment', displayedDraft);
  }

  return {
    draft: displayDraft(draftSix),
    judgedRaws: judgedSix,
    result,
    warning: null,
    protected: false,
    recordVersion: isLegacy ? 1 : CURRENT_STORAGE_VERSION
  };
}

function validReadings(values: unknown): values is string[] {
  return exactSixStrings(values);
}

/**
 * 保存六点草稿或一次成功判定的完整快照（无效读数不构成结果，传 null）。
 * @returns false 表示契约非法或浏览器写入失败；此时不会改动原存档。
 */
export function saveCalibrationState(draft: CalibrationDraft, judgedRaws: string[] | null): boolean {
  if (!validReadings(draft.readings)) {
    return false;
  }
  if (judgedRaws !== null) {
    if (!validReadings(judgedRaws) || !sameReadings(draft.readings, judgedRaws)) {
      return false;
    }
    const result = judgeCalibration(judgedRaws);
    if (result.verdict === 'blocked') {
      return false;
    }
  }

  const store = storage();
  if (!store) {
    return false;
  }
  try {
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: CURRENT_STORAGE_VERSION,
        draft: { readings: draft.readings.slice() },
        judgedRaws: judgedRaws === null ? null : judgedRaws.slice()
      })
    );
    return true;
  } catch {
    // 配额或权限失败：不吞掉错误，让界面保持告警且原 localStorage 记录仍可恢复。
    return false;
  }
}

/** 清空所有校准本地状态（用于“清空重填”）。失败时保留原存档。 */
export function clearCalibrationState(): boolean {
  const store = storage();
  if (!store) {
    return false;
  }
  try {
    store.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
