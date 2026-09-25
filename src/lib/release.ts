/**
 * 压点放行单领域服务。
 *
 * 制版员完成铭牌文字预检后，只有“当前六点试压合格”这一授权仍然成立时，
 * 才允许签发一份可复核的压点放行单。放行单是**不可变快照**：
 *
 *  - 固化合法单稿的原文、行宽、逐方编码与排版结果；
 *  - 固化同一次新完成的“合格”校准判定及其六点原始读数；
 *  - “需调机”、受阻读数、非法文字、未重新判定的旧版校准存档都不能放行。
 *
 * 本模块只做纯函数式判定与快照组装，不访问网络与存储；
 * 持久化由 releaseStorage.ts 负责，界面不在这里。
 */
import { encodePhrase, type BrailleCell, type EncodeError } from './braille';
import { validateWidth, type WidthError } from './layout';
import { planPlate } from './precheck';
import type { PlateLine } from './precheck';
import type { CalibrationResult, PointJudgmentView, ThresholdSummary } from './calibration';
import { POINT_COUNT, judgeCalibration } from './calibration';

/** 放行单快照中的单稿部分：原文、行宽、逐方编码与排版结果。 */
export interface ReleaseDraftSnapshot {
  /** 单稿原文（按操作员录入逐字保留，含空格等）。 */
  text: string;
  /** 放行时合法的每行方数。 */
  width: number;
  /** 逐方编码（点号升序字符串序列），与单稿预检的逐方预览一致。 */
  cells: BrailleCell[];
  /** 总方数。 */
  totalCells: number;
  /** 排版后的逐行结果（末行不补齐）。 */
  lines: PlateLine[];
}

/** 放行单快照中的校准部分：一次新完成的“合格”判定及其六点读数。 */
export interface ReleaseCalibrationSnapshot {
  /** 固化时必须为 'pass'；任何其它结论都不能进入放行单。 */
  verdict: 'pass';
  /** 六点原始录入文本（逐字保留，含前导 0 等写法）。 */
  raws: string[];
  /** 六点解析后的逐点判定视图。 */
  readings: PointJudgmentView[];
  /** 最小、最大、极差等阈值汇总。 */
  threshold: ThresholdSummary;
  /** 合格判定结论文本。 */
  conclusion: string;
}

/**
 * 一次放行的完整、不可变快照。模块在返回前会递归冻结，
 * 界面只能读取，不能事后改写其中任何字段。
 */
export interface ReleaseSnapshot {
  draft: ReleaseDraftSnapshot;
  calibration: ReleaseCalibrationSnapshot;
}

/** 放行单：独立标识 + 签发时刻 + 不可变来源快照。 */
export interface ReleaseSlip {
  /** 独立标识，如 “PF-20260924-093015-ab12cd34”。 */
  id: string;
  /** 签发时刻（ISO 8601 字符串）。 */
  issuedAt: string;
  snapshot: ReleaseSnapshot;
}

/** 放行阻断原因类别。 */
export type ReleaseBlockerKind =
  | 'draft-illegal'
  | 'calibration-none'
  | 'calibration-blocked'
  | 'calibration-adjust'
  | 'calibration-stale'
  | 'calibration-legacy'
  | 'calibration-protected';

export interface ReleaseBlocker {
  scope: 'draft' | 'calibration';
  kind: ReleaseBlockerKind;
  message: string;
}

/**
 * 校准放行授权视图：由当前试压校准会话投影而来。
 *
 * 关键在于“当前”二字——只有版本相符、未受保护、六点与最近一次判定读数一致、
 * 且判定结论为“合格”的记录才可能授权；旧版（未重新判定）存档一律拒绝。
 */
export interface CalibrationGateView {
  /** 最近一次判定的结论；本会话尚未判定时为 null。 */
  verdict: 'pass' | 'adjust' | 'blocked' | null;
  /** 判定结果对象（pass/adjust 带阈值，blocked 带读数错误）；未判定为 null。 */
  result: CalibrationResult | null;
  /** 最近一次成功判定所用的六点原始读数；未判定为 null。 */
  judgedRaws: readonly string[] | null;
  /** 当前输入框里的六点原始读数。 */
  currentReadings: readonly string[];
  /** true 表示当前存档损坏 / 版本不符 / 处于保护态，不能作为授权来源。 */
  protected: boolean;
  /** 存档记录版本（1=旧版兼容记录，2=当前版本）；无法识别时为 null。 */
  recordVersion: number | null;
}

/** 放行所要求的校准存档记录版本（当前版本）。 */
export const CURRENT_CALIBRATION_RECORD_VERSION = 2;

export interface ReleaseGate {
  /** true 表示当前状态可以签发放行单。 */
  canRelease: boolean;
  /** 不能放行时逐条列出原因（单稿错误在前，校准原因在后）。 */
  blockers: ReleaseBlocker[];
}

/** 放行单标识生成器：默认由时间戳与随机后缀组成；测试可注入确定性来源。 */
export interface ReleaseIdSources {
  now: () => Date;
  random: () => number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 生成独立放行单标识：`PF-YYYYMMDD-HHMMSS-xxxxxxxx`。
 * 同一秒并发也由 8 位十六进制随机后缀区分。
 */
export function createReleaseId(sources: ReleaseIdSources = { now: () => new Date(), random: Math.random }): string {
  const date = sources.now();
  const stamp =
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const suffix = Math.floor(sources.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
    .slice(0, 8);
  return `PF-${stamp}-${suffix}`;
}

/** 深度冻结一份快照（数组与普通对象），让放行单成为只读取证记录。 */
export function freezeSnapshot<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') {
        freezeSnapshot(child);
      }
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * 组装单稿快照。调用方必须先用放行闸门确认单稿合法；
 * 这里再次防御性校验，任何非法输入直接抛错，绝不产生半成品快照。
 */
export function buildDraftSnapshot(text: string, rawWidth: string | number): ReleaseDraftSnapshot {
  const plan = planPlate(text, rawWidth);
  if (plan.errors.length > 0) {
    throw new TypeError(`单稿不合法，不能固化为放行快照：${plan.errors.join('；')}`);
  }
  return {
    text,
    width: plan.width,
    cells: plan.lines.flatMap((line) => line.cells.slice()),
    totalCells: plan.totalCells,
    lines: plan.lines.map((line) => ({ index: line.index, cells: line.cells.slice() }))
  };
}

/** 组装校准快照；只接受“合格”判定，且读数必须与判定来源逐字一致。 */
export function buildCalibrationSnapshot(view: CalibrationGateView): ReleaseCalibrationSnapshot {
  const result = view.result;
  if (!result || result.verdict !== 'pass' || !view.judgedRaws) {
    throw new TypeError('只有“合格”校准判定才能固化为放行快照。');
  }
  return {
    verdict: 'pass',
    raws: view.judgedRaws.slice(),
    readings: result.readings.map((point) => ({ ...point })),
    threshold: { ...result.threshold },
    conclusion: result.conclusion
  };
}

export interface CreateReleaseInput {
  text: string;
  rawWidth: string | number;
  gate: CalibrationGateView;
}

export interface CreateReleaseResult {
  ok: boolean;
  /** ok=true 时为已冻结的放行单。 */
  slip?: ReleaseSlip;
  /** ok=false 时为全部阻断原因。 */
  blockers?: ReleaseBlocker[];
}

/**
 * 评估放行闸门：单稿预检必须合法且有输出；校准必须是当前会话新完成的合格判定，
 * 且屏幕读数与判定读数逐字一致；保护态、旧版存档一律拒绝。
 */
export function evaluateReleaseGate(text: string, rawWidth: string | number, gate: CalibrationGateView): ReleaseGate {
  const blockers: ReleaseBlocker[] = [];

  const encode = encodePhrase(text);
  const widthError: WidthError | null = validateWidth(rawWidth);
  const plan = planPlate(text, rawWidth);
  if (encode.errors.length > 0 || widthError !== null || plan.totalCells === 0) {
    const messages: string[] = [
      ...encode.errors.map((error: EncodeError) => error.message),
      ...(widthError ? [widthError.message] : [])
    ];
    blockers.push({
      scope: 'draft',
      kind: 'draft-illegal',
      message:
        messages.length > 0
          ? `单稿预检未通过，不能放行：${messages.join('；')}`
          : '单稿没有任何可压点的方：请先完成铭牌文字预检。'
    });
  }

  if (gate.protected) {
    blockers.push({
      scope: 'calibration',
      kind: 'calibration-protected',
      message: '试压校准存档异常且处于保护中：请核对六点读数并重新执行判定，在此之前不能放行。'
    });
  } else if (gate.recordVersion !== null && gate.recordVersion < CURRENT_CALIBRATION_RECORD_VERSION) {
    blockers.push({
      scope: 'calibration',
      kind: 'calibration-legacy',
      message: '当前显示的是旧版校准存档：即使兼容恢复了结论，也必须重新执行一次判定才能作为放行依据。'
    });
  } else if (gate.verdict === null || !gate.result) {
    blockers.push({
      scope: 'calibration',
      kind: 'calibration-none',
      message: '尚未完成六点试压判定：请在试压校准工作区录入六点读数并执行判定。'
    });
  } else if (gate.verdict === 'blocked') {
    blockers.push({
      scope: 'calibration',
      kind: 'calibration-blocked',
      message: '六点试压存在无效读数（判定受阻）：请修正读数后重新判定，合格前不能放行。'
    });
  } else if (gate.verdict === 'adjust') {
    blockers.push({
      scope: 'calibration',
      kind: 'calibration-adjust',
      message: '最近一次试压结论为“需调机”：请调整设备、重新试压并判定合格后再放行。'
    });
  } else if (!readingsMatch(gate.currentReadings, gate.judgedRaws)) {
    blockers.push({
      scope: 'calibration',
      kind: 'calibration-stale',
      message: '任一六点读数已在判定后改动：当前合格结论已失效，请重新执行判定后再放行。'
    });
  }

  return { canRelease: blockers.length === 0, blockers };
}

function readingsMatch(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (!left || !right || left.length !== POINT_COUNT || right.length !== POINT_COUNT) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

/**
 * 签发放行单：闸门不通过时只返回阻断原因，绝不产生半成品；
 * 通过时把单稿快照与同一次“合格”校准快照一并冻结。
 */
export function createReleaseSlip(input: CreateReleaseInput, sources?: ReleaseIdSources): CreateReleaseResult {
  const gate = evaluateReleaseGate(input.text, input.rawWidth, input.gate);
  if (!gate.canRelease) {
    return { ok: false, blockers: gate.blockers };
  }

  const snapshot: ReleaseSnapshot = {
    draft: buildDraftSnapshot(input.text, input.rawWidth),
    calibration: buildCalibrationSnapshot(input.gate)
  };
  freezeSnapshot(snapshot);

  const now = sources?.now ?? (() => new Date());
  const slip: ReleaseSlip = {
    id: createReleaseId(sources),
    issuedAt: now().toISOString(),
    snapshot
  };
  return { ok: true, slip: freezeSnapshot(slip) as ReleaseSlip };
}

/**
 * 校验一份外部（如 localStorage 恢复）放行单的结构完整性。
 * 损坏或字段不符时返回 false，调用方只能告警并保留原记录，不得半信半疑地展示。
 */
export function isWellFormedSlip(value: unknown): value is ReleaseSlip {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const slip = value as Record<string, unknown>;
  if (typeof slip.id !== 'string' || slip.id === '' || typeof slip.issuedAt !== 'string') {
    return false;
  }
  if (Number.isNaN(Date.parse(slip.issuedAt))) {
    return false;
  }
  const snapshot = slip.snapshot;
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return false;
  }
  const { draft, calibration } = snapshot as Record<string, unknown>;
  if (!isWellFormedDraft(draft) || !isWellFormedCalibration(calibration)) {
    return false;
  }
  // 最关键的一致性：快照内的排版必须能由原文与行宽重新推出，
  // 六点读数必须能重新判定出“合格”，且与逐点视图一致。
  return snapshotRecomputes(snapshot as ReleaseSnapshot);
}

function isWellFormedDraft(value: unknown): value is ReleaseDraftSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.text === 'string' &&
    typeof draft.width === 'number' &&
    Number.isInteger(draft.width) &&
    Array.isArray(draft.cells) &&
    draft.cells.every((cell) => typeof cell === 'string') &&
    typeof draft.totalCells === 'number' &&
    Array.isArray(draft.lines) &&
    draft.lines.every(
      (line) =>
        line !== null &&
        typeof line === 'object' &&
        typeof (line as PlateLine).index === 'number' &&
        Array.isArray((line as PlateLine).cells) &&
        (line as PlateLine).cells.every((cell) => typeof cell === 'string')
    )
  );
}

function isWellFormedCalibration(value: unknown): value is ReleaseCalibrationSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const calibration = value as Record<string, unknown>;
  return (
    calibration.verdict === 'pass' &&
    Array.isArray(calibration.raws) &&
    (calibration.raws as unknown[]).length === POINT_COUNT &&
    (calibration.raws as unknown[]).every((raw) => typeof raw === 'string') &&
    typeof calibration.conclusion === 'string' &&
    calibration.threshold !== null &&
    typeof calibration.threshold === 'object' &&
    Array.isArray(calibration.readings) &&
    (calibration.readings as unknown[]).length === POINT_COUNT
  );
}

/** 用领域服务重新计算快照内容，防止被篡改或版本漂移的存档冒充放行依据。 */
function snapshotRecomputes(snapshot: ReleaseSnapshot): boolean {
  const plan = planPlate(snapshot.draft.text, snapshot.draft.width);
  if (plan.errors.length > 0) {
    return false;
  }
  const flatCells = plan.lines.flatMap((line) => line.cells);
  if (
    plan.width !== snapshot.draft.width ||
    plan.totalCells !== snapshot.draft.totalCells ||
    flatCells.length !== snapshot.draft.cells.length ||
    flatCells.some((cell, index) => cell !== snapshot.draft.cells[index]) ||
    plan.lines.length !== snapshot.draft.lines.length
  ) {
    return false;
  }

  let judged: CalibrationResult;
  try {
    judged = judgeCalibration(snapshot.calibration.raws);
  } catch {
    return false;
  }
  if (judged.verdict !== 'pass') {
    return false;
  }
  const values = judged.readings.map((point) => point.value);
  const stored = snapshot.calibration.readings.map((point) => point.value);
  return values.length === stored.length && values.every((value, index) => value === stored[index]);
}
