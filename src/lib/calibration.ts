/**
 * 试压校准（六点试压片）领域服务。
 *
 * 换模或保养后，班组先压一张六点试压片，操作员为 1 至 6 号点各录入一次
 * 凸点高度（毫米）并执行判定，避免设备偏压影响随后生产的铭牌：
 *
 *  - 单点合格范围固定为 0.60–0.90 毫米（含边界）；
 *  - 六点最大值与最小值之差（极差）不得超过 0.15 毫米；
 *  - 空值、非有限数、超过两位小数或非正数属于读数错误，在对应点位提示并停止判定；
 *  - 读数全部有效但阈值不满足时，正常生成“需调机”结果，而不是输入错误。
 *
 * 本模块统一完成十进制解析、缺项检查与阈值计算，只输出判定契约，
 * 不读取也不改写单稿预检或双稿核对的任何结果，不访问网络与存储。
 */

/** 试压片点位数，固定六点。 */
export const POINT_COUNT = 6;

/** 单点凸点高度合格范围（毫米，含边界）。 */
export const MIN_HEIGHT = 0.6;
export const MAX_HEIGHT = 0.9;

/** 六点极差（最大值 - 最小值）上限（毫米，含边界）。 */
export const MAX_SPREAD = 0.15;

/** 读数只允许保留两位小数。 */
export const MAX_DECIMAL_PLACES = 2;

/** 六点名称，下标 0–5 对应 1–6 号点。 */
export const POINT_LABELS: readonly string[] = Array.from(
  { length: POINT_COUNT },
  (_, index) => `${index + 1} 号点`
);

/** 读数错误类型：缺项 / 无法解析 / 非有限数 / 小数超限 / 非正数。 */
export type ReadingErrorKind = 'missing' | 'non-numeric' | 'non-finite' | 'too-many-decimals' | 'non-positive';

export interface ReadingError {
  kind: ReadingErrorKind;
  message: string;
}

/**
 * 单个点位的读数视图：始终保留操作员原始录入文本，
 * 解析成功时携带数值，失败时携带可就地展示的错误。
 */
export interface PointReadingView {
  /** 点位下标，0–5 对应 1–6 号点。 */
  index: number;
  label: string;
  raw: string;
  value: number | null;
  error: ReadingError | null;
}

/** 单点越界原因。 */
export type PointOutReasonKind = 'below-min' | 'above-max';

export interface PointOutReason {
  kind: PointOutReasonKind;
  message: string;
}

/** 阈值判定通过后，每个点位的实测值与单点结论。 */
export interface PointJudgmentView {
  index: number;
  label: string;
  raw: string;
  value: number;
  inRange: boolean;
  /** 越界原因；在合格范围内为 null。 */
  outReason: PointOutReason | null;
}

/** 整机阈值汇总。 */
export interface ThresholdSummary {
  min: number;
  max: number;
  /** 极差 = 最大值 - 最小值，按两位小数归整以消除浮点尾数。 */
  spread: number;
  spreadLimit: number;
  spreadOk: boolean;
  rangeMin: number;
  rangeMax: number;
}

/** 校准结论：合格 / 需调机（读数有效但阈值不达标）/ 受阻（存在无效读数）。 */
export type CalibrationVerdict = 'pass' | 'adjust' | 'blocked';

export type CalibrationResult =
  | {
      verdict: 'pass' | 'adjust';
      readings: PointJudgmentView[];
      threshold: ThresholdSummary;
      conclusion: string;
    }
  | {
      verdict: 'blocked';
      readings: PointReadingView[];
      conclusion: string;
    };

/** 校准草稿：六点各一次原始录入，会话未提交前由工作区自动保存。 */
export interface CalibrationDraft {
  readings: string[];
}

/** 创建一份六点全部空缺的校准草稿。 */
export function createDraft(): CalibrationDraft {
  return { readings: Array.from({ length: POINT_COUNT }, () => '') };
}

/** 毫米高度统一显示为两位小数。 */
export function formatHeight(value: number): string {
  return value.toFixed(MAX_DECIMAL_PLACES);
}

/** 两位小数归整，消除如 0.75 - 0.60 = 0.15000000000000002 的浮点尾数。 */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function readingError(index: number, kind: ReadingErrorKind): ReadingError {
  const label = POINT_LABELS[index];
  const range = `${MIN_HEIGHT.toFixed(2)}–${MAX_HEIGHT.toFixed(2)}`;
  let message: string;
  switch (kind) {
    case 'missing':
      message = `${label}缺项：请录入该点凸点高度（毫米）。`;
      break;
    case 'non-numeric':
      message = `${label}读数无法识别：请输入十进制数值，如 0.75（毫米），最多两位小数。`;
      break;
    case 'non-finite':
      message = `${label}读数不是有限数：请输入 ${range} 毫米之间的凸点高度。`;
      break;
    case 'too-many-decimals':
      message = `${label}读数超过两位小数：凸点高度只允许保留两位小数（毫米）。`;
      break;
    case 'non-positive':
      message = `${label}读数必须为正数：请输入 ${range} 毫米之间的凸点高度。`;
      break;
  }
  return { kind, message };
}

/**
 * 解析单个点位的录入文本。
 *
 * 只接受十进制写法（可带正负号与小数点），按顺序区分：
 * 空值（含纯空白）→ 无法解析 → 非有限数（Infinity 等）→ 超过两位小数 → 非正数。
 * 每个点位至多携带一条错误。
 */
export function parsePointReading(raw: string, index: number): PointReadingView {
  const label = POINT_LABELS[index];
  const text = raw.trim();

  if (text === '') {
    return { index, label, raw, value: null, error: readingError(index, 'missing') };
  }

  const parsed = Number(text);

  if (Number.isNaN(parsed)) {
    return { index, label, raw, value: null, error: readingError(index, 'non-numeric') };
  }
  if (!Number.isFinite(parsed)) {
    return { index, label, raw, value: null, error: readingError(index, 'non-finite') };
  }

  // 至此 parsed 为有限数；仅允许标准十进制写法，指数记法等一律无法识别。
  const literal = /^[+-]?\d+(?:\.(\d+))?$/.exec(text);
  if (!literal) {
    return { index, label, raw, value: null, error: readingError(index, 'non-numeric') };
  }
  if (literal[1] && literal[1].length > MAX_DECIMAL_PLACES) {
    return { index, label, raw, value: null, error: readingError(index, 'too-many-decimals') };
  }
  if (parsed <= 0) {
    return { index, label, raw, value: null, error: readingError(index, 'non-positive') };
  }

  return { index, label, raw, value: parsed, error: null };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * 校验输入是否为完整六点。
 *
 * 持久化恢复时绝不能用补空或截断改变点号与读数的对应关系；
 * 工作区正常录入始终传入六点，因此直接拒绝长度不完整的调用。
 */
function requireSixReadings(input: readonly string[] | CalibrationDraft): string[] {
  const source = isStringArray(input) ? input : input.readings;
  if (!Array.isArray(source) || source.length !== POINT_COUNT) {
    throw new TypeError(`试压校准必须提供完整的 ${POINT_COUNT} 个点读数。`);
  }
  if (!source.every((item) => typeof item === 'string')) {
    throw new TypeError('试压校准读数必须全部为字符串。');
  }
  return source.slice();
}
/**
 * 执行一次校准判定。
 *
 * 先统一解析六点：任一点位读数无效即判定受阻，错误按点位就地展示并停止判定，
 * 不产生任何阈值结论。读数全部有效时才计算单点越界与六点极差：
 * 单点均在 0.60–0.90 且极差不超过 0.15 为“合格”，否则为“需调机”。
 */
export function judgeCalibration(input: readonly string[] | CalibrationDraft): CalibrationResult {
  const raws = requireSixReadings(input);
  const readings = raws.map((raw, index) => parsePointReading(raw, index));
  const blockedNote = '存在无效读数，已停止判定：请按各点位提示修正后重新执行判定。';

  if (readings.some((reading) => reading.error !== null)) {
    return { verdict: 'blocked', readings, conclusion: blockedNote };
  }

  const values = readings.map((reading) => reading.value as number);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = round2(max - min);
  const spreadOk = spread <= MAX_SPREAD;

  const judgments: PointJudgmentView[] = readings.map((reading) => {
    const value = reading.value as number;
    let outReason: PointOutReason | null = null;
    if (value < MIN_HEIGHT) {
      outReason = {
        kind: 'below-min',
        message: `低于合格下限 ${MIN_HEIGHT.toFixed(2)} 毫米`
      };
    } else if (value > MAX_HEIGHT) {
      outReason = {
        kind: 'above-max',
        message: `高于合格上限 ${MAX_HEIGHT.toFixed(2)} 毫米`
      };
    }
    return {
      index: reading.index,
      label: reading.label,
      raw: reading.raw,
      value,
      inRange: outReason === null,
      outReason
    };
  });

  const threshold: ThresholdSummary = {
    min,
    max,
    spread,
    spreadLimit: MAX_SPREAD,
    spreadOk,
    rangeMin: MIN_HEIGHT,
    rangeMax: MAX_HEIGHT
  };

  const causes: string[] = [];
  for (const point of judgments) {
    if (point.outReason) {
      causes.push(`${point.label}实测 ${formatHeight(point.value)} 毫米，${point.outReason.message}`);
    }
  }
  if (!spreadOk) {
    causes.push(
      `六点极差 ${formatHeight(spread)} 毫米（${formatHeight(max)} − ${formatHeight(min)}），` +
        `超过限值 ${formatHeight(MAX_SPREAD)} 毫米`
    );
  }

  if (causes.length === 0) {
    return {
      verdict: 'pass',
      readings: judgments,
      threshold,
      conclusion:
        `整机结论：合格。六点凸点高度均在 ${MIN_HEIGHT.toFixed(2)}–${MAX_HEIGHT.toFixed(2)} 毫米内，` +
        `极差 ${formatHeight(spread)} 毫米（限值 ${formatHeight(MAX_SPREAD)} 毫米），可以投入铭牌压点生产。`
    };
  }

  return {
    verdict: 'adjust',
    readings: judgments,
    threshold,
    conclusion: `整机结论：需调机。${causes.join('；')}。请调整设备后重新试压校准，暂不要投入铭牌生产。`
  };
}
