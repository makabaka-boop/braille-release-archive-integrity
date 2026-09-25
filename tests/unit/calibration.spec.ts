import { describe, expect, it } from 'vitest';
import {
  MAX_HEIGHT,
  MAX_SPREAD,
  MIN_HEIGHT,
  POINT_COUNT,
  createDraft,
  judgeCalibration,
  parsePointReading,
  type CalibrationDraft
} from '../../src/lib/calibration';

function readings(...values: number[]): string[] {
  return values.map((value) => value.toFixed(2));
}

function draftOf(...values: Array<string | number>): CalibrationDraft {
  return { readings: values.map((value) => String(value)) };
}

describe('校准草稿契约', () => {
  it('createDraft 固定为六点空读数', () => {
    const draft = createDraft();
    expect(draft.readings).toHaveLength(POINT_COUNT);
    expect(draft.readings).toEqual(['', '', '', '', '', '']);
  });

  it('不足六项或多于六项都拒绝，绝不补空或截断改变点号对应关系', () => {
    expect(() => judgeCalibration(['0.7', '0.71', '0.72', '0.73', '0.74'])).toThrow(TypeError);
    expect(() => judgeCalibration(draftOf('0.7', '0.71', '0.72', '0.73', '0.74', '0.75', '9.99'))).toThrow(TypeError);
  });

  it('接受 CalibrationDraft 对象与字符串数组两种入参', () => {
    expect(judgeCalibration(draftOf(0.7, 0.72, 0.74, 0.76, 0.78, 0.8)).verdict).toBe('pass');
    expect(judgeCalibration(readings(0.7, 0.72, 0.74, 0.76, 0.78, 0.8)).verdict).toBe('pass');
  });
});

describe('单点合格范围边界', () => {
  it('下限 0.60 与上限 0.90 含边界均合格', () => {
    // 同时出现 0.60 与 0.90 时极差为 0.30，故各测一边的边界包含性。
    const atMin = judgeCalibration(readings(MIN_HEIGHT, 0.66, 0.68, 0.7, 0.72, 0.74));
    expect(atMin.verdict).toBe('pass');
    if (atMin.verdict === 'pass') {
      expect(atMin.readings[0].inRange).toBe(true);
      expect(atMin.threshold.min).toBe(MIN_HEIGHT);
    }

    const atMax = judgeCalibration(readings(0.76, 0.78, 0.8, 0.82, 0.84, MAX_HEIGHT));
    expect(atMax.verdict).toBe('pass');
    if (atMax.verdict === 'pass') {
      expect(atMax.readings[5].inRange).toBe(true);
      expect(atMax.threshold.max).toBe(MAX_HEIGHT);
    }
  });

  it('0.599 无法录入为三位小数（超过两位小数），0.59 判定为低于下限', () => {
    const threeDecimals = parsePointReading('0.599', 0);
    expect(threeDecimals.error?.kind).toBe('too-many-decimals');
    expect(threeDecimals.value).toBeNull();

    const below = judgeCalibration(readings(0.59, 0.7, 0.71, 0.72, 0.73, 0.74));
    expect(below.verdict).toBe('adjust');
    if (below.verdict === 'adjust') {
      expect(below.readings[0].inRange).toBe(false);
      expect(below.readings[0].outReason?.kind).toBe('below-min');
      expect(below.readings[1].inRange).toBe(true);
      expect(below.conclusion).toContain('需调机');
      expect(below.conclusion).toContain('低于合格下限');
    }
  });

  it('0.91 判定为高于上限，其余点照常合格', () => {
    const result = judgeCalibration(readings(0.7, 0.71, 0.72, 0.73, 0.74, 0.91));
    expect(result.verdict).toBe('adjust');
    if (result.verdict === 'adjust') {
      expect(result.readings[5].outReason?.kind).toBe('above-max');
      expect(result.threshold.spreadOk).toBe(false);
      expect(result.conclusion).toContain('高于合格上限');
    }
  });

  it('所有点在范围内但极差恰好 0.15 时合格', () => {
    const result = judgeCalibration(readings(0.75, 0.78, 0.81, 0.84, 0.87, MAX_HEIGHT));
    expect(result.verdict).toBe('pass');
    if (result.verdict === 'pass') {
      expect(result.threshold.spread).toBe(MAX_SPREAD);
      expect(result.threshold.spreadOk).toBe(true);
    }
  });
});

describe('六点离散度（极差）', () => {
  it('极差 0.16 需调机，且各点都在单点范围内', () => {
    const result = judgeCalibration(readings(0.62, 0.68, 0.7, 0.72, 0.74, 0.78));
    expect(result.verdict).toBe('adjust');
    if (result.verdict === 'adjust') {
      expect(result.readings.every((point) => point.inRange)).toBe(true);
      expect(result.threshold).toMatchObject({ min: 0.62, max: 0.78, spread: 0.16 });
      expect(result.threshold.spreadOk).toBe(false);
      expect(result.conclusion).toContain('极差 0.16');
      expect(result.conclusion).toContain('超过限值 0.15');
    }
  });

  it('浮点尾数不影响 0.75-0.60 的极差判定', () => {
    const result = judgeCalibration(readings(0.6, 0.75, 0.75, 0.75, 0.75, 0.75));
    expect(result.verdict).toBe('pass');
    if (result.verdict === 'pass') {
      expect(result.threshold.spread).toBe(0.15);
    }
  });

  it('单点越界与极差超限可同时列出', () => {
    const result = judgeCalibration(readings(0.6, 0.61, 0.62, 0.63, 0.64, 0.91));
    expect(result.verdict).toBe('adjust');
    if (result.verdict === 'adjust') {
      expect(result.readings[5].outReason?.kind).toBe('above-max');
      expect(result.threshold.spread).toBe(0.31);
      expect(result.conclusion).toContain('高于合格上限');
      expect(result.conclusion).toContain('超过限值');
    }
  });
});

describe('无效读数就地受阻', () => {
  it('缺项停止判定并定位到对应点位', () => {
    const result = judgeCalibration(draftOf('0.7', '0.71', '', '0.73', '0.74', '0.75'));
    expect(result.verdict).toBe('blocked');
    if (result.verdict === 'blocked') {
      expect(result.readings[2].error?.kind).toBe('missing');
      expect(result.readings[2].error?.message).toContain('3 号点');
      expect(result.readings[0].error).toBeNull();
      expect(result.conclusion).toContain('已停止判定');
    }
  });

  it.each([
    ['abc', 'non-numeric'],
    ['12px', 'non-numeric'],
    ['0.7.5', 'non-numeric'],
    ['0,75', 'non-numeric'],
    ['1e-1', 'non-numeric'],
    ['.75', 'non-numeric'],
    ['0.75 ', 'missing']
  ] as const)('文本 %s 的错误类型为 %s', (raw, kind) => {
    // 纯空白或缺项由服务层 trim 后识别；'0.75 ' 本身合法，这里单独验证 trim 语义。
    const parsed = parsePointReading(raw, 1);
    if (raw === '0.75 ') {
      expect(parsed.error).toBeNull();
      expect(parsed.value).toBe(0.75);
    } else {
      expect(parsed.error?.kind).toBe(kind);
      expect(parsed.value).toBeNull();
    }
  });

  it('Infinity 与 -Infinity 判定为非有限数', () => {
    const positive = parsePointReading('Infinity', 0);
    expect(positive.error?.kind).toBe('non-finite');
    const negative = judgeCalibration(draftOf('-Infinity', '0.7', '0.71', '0.72', '0.73', '0.74'));
    expect(negative.verdict).toBe('blocked');
    if (negative.verdict === 'blocked') {
      expect(negative.readings[0].error?.kind).toBe('non-finite');
    }
  });

  it('超过两位小数在对应点位提示并停止判定', () => {
    const result = judgeCalibration(draftOf('0.700', '0.7', '0.71', '0.72', '0.73', '0.74'));
    expect(result.verdict).toBe('blocked');
    if (result.verdict === 'blocked') {
      expect(result.readings[0].error?.kind).toBe('too-many-decimals');
      expect(result.readings[0].error?.message).toContain('两位小数');
    }
  });

  it.each(['0', '-0.5', '-1', '0.00'])('非正数 %s 被拒绝', (raw) => {
    const result = judgeCalibration(draftOf(raw, '0.7', '0.71', '0.72', '0.73', '0.74'));
    expect(result.verdict).toBe('blocked');
    if (result.verdict === 'blocked') {
      expect(result.readings[0].error?.kind).toBe('non-positive');
    }
  });

  it('多个无效读数同时在各自点位报告', () => {
    const result = judgeCalibration(draftOf('', 'abc', '0.71', '0.72', '0.73', '0.123'));
    expect(result.verdict).toBe('blocked');
    if (result.verdict === 'blocked') {
      expect(result.readings[0].error?.kind).toBe('missing');
      expect(result.readings[1].error?.kind).toBe('non-numeric');
      expect(result.readings[2].error).toBeNull();
      expect(result.readings[5].error?.kind).toBe('too-many-decimals');
    }
  });

  it('受阻结果不携带阈值字段（输入错误与需调机严格区分）', () => {
    const result = judgeCalibration(draftOf('', '', '', '', '', ''));
    expect(result.verdict).toBe('blocked');
    expect('threshold' in result).toBe(false);
  });
});

describe('parsePointReading 读数解析', () => {
  it('合法值保留两位以内小数与原始文本', () => {
    const parsed = parsePointReading('  0.6 ', 3);
    expect(parsed).toMatchObject({ index: 3, label: '4 号点', raw: '  0.6 ', value: 0.6 });
    expect(parsed.error).toBeNull();
  });

  it('带正号的标准十进制也可解析', () => {
    expect(parsePointReading('+0.8', 0).value).toBe(0.8);
  });
});
