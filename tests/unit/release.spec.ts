import { describe, expect, it } from 'vitest';
import {
  CURRENT_CALIBRATION_RECORD_VERSION,
  buildCalibrationSnapshot,
  buildDraftSnapshot,
  createReleaseId,
  createReleaseSlip,
  evaluateReleaseGate,
  freezeSnapshot,
  isWellFormedSlip,
  type CalibrationGateView
} from '../../src/lib/release';

const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

function passGate(overrides: Partial<CalibrationGateView> = {}): CalibrationGateView {
  return {
    verdict: 'pass',
    result: {
      verdict: 'pass',
      readings: legalReadings.map((raw, index) => ({
        index,
        label: `${index + 1} 号点`,
        raw,
        value: Number(raw),
        inRange: true,
        outReason: null
      })),
      threshold: {
        min: 0.7,
        max: 0.8,
        spread: 0.1,
        spreadLimit: 0.15,
        spreadOk: true,
        rangeMin: 0.6,
        rangeMax: 0.9
      },
      conclusion: '整机结论：合格。'
    },
    judgedRaws: legalReadings.slice(),
    currentReadings: legalReadings.slice(),
    protected: false,
    recordVersion: CURRENT_CALIBRATION_RECORD_VERSION,
    ...overrides
  };
}

const fixedSources = {
  now: () => new Date('2026-09-24T10:30:15.000Z'),
  random: () => 0xab12cd34 / 0xffffffff
};

describe('release 放行领域服务：闸门判定', () => {
  it('合法单稿 + 当前合格判定 + 读数一致 + 当前版本：可放行且无阻断', () => {
    const gate = evaluateReleaseGate('12，三。', '4', passGate());
    expect(gate.canRelease).toBe(true);
    expect(gate.blockers).toEqual([]);
  });

  it('非法文字、空文本、非法行宽分别以单稿原因阻断', () => {
    expect(evaluateReleaseGate('12楼', '4', passGate()).blockers[0]).toMatchObject({
      scope: 'draft',
      kind: 'draft-illegal'
    });
    expect(evaluateReleaseGate('', '4', passGate()).canRelease).toBe(false);
    expect(evaluateReleaseGate('12，三。', '3', passGate()).blockers.some((b) => b.scope === 'draft')).toBe(true);
    expect(evaluateReleaseGate('12，三。', '12.5', passGate()).blockers.some((b) => b.scope === 'draft')).toBe(true);
  });

  it('未判定、受阻、需调机都不能放行', () => {
    expect(evaluateReleaseGate('一二三', '4', passGate({ verdict: null, result: null, judgedRaws: null })).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'calibration-none' })])
    );
    const blocked = evaluateReleaseGate('一二三', '4', passGate({ verdict: 'blocked', result: { verdict: 'blocked', readings: [], conclusion: '' } }));
    expect(blocked.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'calibration-blocked' })]));
    const adjust = evaluateReleaseGate(
      '一二三',
      '4',
      passGate({
        verdict: 'adjust',
        result: {
          verdict: 'adjust',
          readings: [],
          threshold: { min: 0.7, max: 0.91, spread: 0.21, spreadLimit: 0.15, spreadOk: false, rangeMin: 0.6, rangeMax: 0.9 },
          conclusion: '需调机'
        }
      })
    );
    expect(adjust.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'calibration-adjust' })]));
  });

  it('判定后任一点读数改动即判定过期，不能放行', () => {
    const changed = legalReadings.slice();
    changed[2] = '0.65';
    const gate = evaluateReleaseGate('一二三', '4', passGate({ currentReadings: changed }));
    expect(gate.canRelease).toBe(false);
    expect(gate.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'calibration-stale' })]));
  });

  it('受保护存档与旧版（未重新判定）校准都不能放行', () => {
    const protectedGate = evaluateReleaseGate('一二三', '4', passGate({ protected: true }));
    expect(protectedGate.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'calibration-protected' })]));

    const legacyGate = evaluateReleaseGate('一二三', '4', passGate({ recordVersion: 1 }));
    expect(legacyGate.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'calibration-legacy' })]));
    expect(legacyGate.canRelease).toBe(false);
  });

  it('单稿与校准可同时列出多条阻断原因', () => {
    const gate = evaluateReleaseGate('12楼', '3', passGate({ verdict: null, result: null, judgedRaws: null }));
    expect(gate.blockers.length).toBeGreaterThanOrEqual(2);
    expect(gate.blockers[0].scope).toBe('draft');
  });
});

describe('release 放行领域服务：快照组装与签发', () => {
  it('放行单固化原文、行宽、逐方编码与排版结果，以及合格判定与六点读数', () => {
    const result = createReleaseSlip({ text: '12，三。', rawWidth: '4', gate: passGate() }, fixedSources);
    expect(result.ok).toBe(true);
    const slip = result.slip!;
    expect(slip.id).toBe('PF-20260924-103015-ab12cd34');
    expect(slip.issuedAt).toBe('2026-09-24T10:30:15.000Z');

    const d = slip.snapshot.draft;
    expect(d.text).toBe('12，三。');
    expect(d.width).toBe(4);
    // 3456 | 1 | 12 | 2(，) | 14(三) | 256(。)
    expect(d.cells).toEqual(['3456', '1', '12', '2', '14', '256']);
    expect(d.totalCells).toBe(6);
    expect(d.lines.map((line) => line.cells)).toEqual([['3456', '1', '12', '2'], ['14', '256']]);

    const c = slip.snapshot.calibration;
    expect(c.verdict).toBe('pass');
    expect(c.raws).toEqual(legalReadings);
    expect(c.readings.map((point) => point.value)).toEqual([0.7, 0.72, 0.74, 0.76, 0.78, 0.8]);
    expect(c.threshold.spread).toBe(0.1);
  });

  it('闸门不通过时不产生放行单，只返回阻断原因', () => {
    const result = createReleaseSlip({ text: '12楼', rawWidth: '4', gate: passGate() });
    expect(result.ok).toBe(false);
    expect(result.slip).toBeUndefined();
    expect(result.blockers?.length).toBeGreaterThan(0);

    const adjust = createReleaseSlip(
      { text: '一二三', rawWidth: '4', gate: passGate({ verdict: 'adjust', result: { verdict: 'adjust', readings: [], threshold: { min: 0.7, max: 0.91, spread: 0.21, spreadLimit: 0.15, spreadOk: false, rangeMin: 0.6, rangeMax: 0.9 }, conclusion: '' } }) },
      fixedSources
    );
    expect(adjust.ok).toBe(false);
    expect(adjust.slip).toBeUndefined();
  });

  it('放行单快照递归冻结，任何字段都不可改写', () => {
    const slip = createReleaseSlip({ text: '一二三', rawWidth: '4', gate: passGate() }, fixedSources).slip!;
    expect(Object.isFrozen(slip)).toBe(true);
    expect(Object.isFrozen(slip.snapshot)).toBe(true);
    expect(Object.isFrozen(slip.snapshot.draft)).toBe(true);
    expect(Object.isFrozen(slip.snapshot.draft.lines)).toBe(true);
    expect(Object.isFrozen(slip.snapshot.calibration)).toBe(true);
    expect(Object.isFrozen(slip.snapshot.calibration.raws)).toBe(true);
    expect(() => {
      (slip as unknown as { id: string }).id = 'HACKED';
    }).toThrow(TypeError);
  });

  it('buildDraftSnapshot 对非法单稿直接抛错，buildCalibrationSnapshot 拒绝非合格判定', () => {
    expect(() => buildDraftSnapshot('12楼', '4')).toThrow(TypeError);
    expect(() =>
      buildCalibrationSnapshot(
        passGate({
          verdict: 'adjust',
          result: {
            verdict: 'adjust',
            readings: [],
            threshold: { min: 0.7, max: 0.91, spread: 0.21, spreadLimit: 0.15, spreadOk: false, rangeMin: 0.6, rangeMax: 0.9 },
            conclusion: ''
          }
        })
      )
    ).toThrow(TypeError);
    expect(() => buildCalibrationSnapshot(passGate({ verdict: null, result: null, judgedRaws: null }))).toThrow(TypeError);
  });

  it('freezeSnapshot 对基本类型与 null 安全', () => {
    expect(freezeSnapshot(1)).toBe(1);
    expect(freezeSnapshot(null)).toBeNull();
  });

  it('默认标识生成器两次结果不相同', () => {
    const first = createReleaseId();
    const second = createReleaseId();
    expect(first).toMatch(/^PF-\d{8}-\d{6}-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });
});

describe('release 放行领域服务：存档结构校验（防篡改 / 防损坏）', () => {
  function validSlip() {
    return createReleaseSlip({ text: '12，三。', rawWidth: '4', gate: passGate() }, fixedSources).slip!;
  }

  it('合法单据通过结构校验', () => {
    expect(isWellFormedSlip(validSlip())).toBe(true);
  });

  it('缺字段、错类型、坏 JSON 来源对象、错误时间戳均不通过', () => {
    expect(isWellFormedSlip(null)).toBe(false);
    expect(isWellFormedSlip({})).toBe(false);
    expect(isWellFormedSlip([])).toBe(false);
    expect(isWellFormedSlip({ id: '', issuedAt: new Date().toISOString(), snapshot: {} })).toBe(false);
    expect(isWellFormedSlip({ id: 'PF-x', issuedAt: 'not-a-date', snapshot: {} })).toBe(false);
    const slip = validSlip() as unknown as Record<string, unknown>;
    expect(isWellFormedSlip({ ...slip, id: 123 })).toBe(false);
  });

  it('篡改快照原文或行宽后不能通过（必须与重算结果一致）', () => {
    const tamperedText = structuredClone(validSlip());
    (tamperedText.snapshot.draft as { text: string }).text = '一二三';
    expect(isWellFormedSlip(tamperedText)).toBe(false);

    const tamperedWidth = structuredClone(validSlip());
    (tamperedWidth.snapshot.draft as { width: number }).width = 8;
    expect(isWellFormedSlip(tamperedWidth)).toBe(false);

    const tamperedCells = structuredClone(validSlip());
    tamperedCells.snapshot.draft.cells[0] = '1';
    expect(isWellFormedSlip(tamperedCells)).toBe(false);

    const tamperedReading = structuredClone(validSlip());
    tamperedReading.snapshot.calibration.raws[0] = '0.61';
    expect(isWellFormedSlip(tamperedReading)).toBe(false);
  });
});
