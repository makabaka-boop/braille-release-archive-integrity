import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDraft } from '../../src/lib/calibration';
import { clearCalibrationState, loadCalibrationState, saveCalibrationState } from '../../src/lib/calibrationStorage';

const STORAGE_KEY = 'braille-plate:calibration:v1';

function setStored(value: unknown) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

describe('calibrationStorage 草稿与判定快照持久化', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('首次加载返回六点空草稿且无结果', () => {
    const state = loadCalibrationState();
    expect(state.draft).toEqual(createDraft());
    expect(state.judgedRaws).toBeNull();
    expect(state.result).toBeNull();
    expect(state.warning).toBeNull();
    expect(state.protected).toBe(false);
  });

  it('合法未提交草稿保存后刷新可恢复（含空缺项）', () => {
    const draft = { readings: ['0.71', '', '0.73', '0.74', '0.75', '0.76'] };
    expect(saveCalibrationState(draft, null)).toBe(true);

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(2);

    const restored = loadCalibrationState();
    expect(restored.draft).toEqual(draft);
    expect(restored.result).toBeNull();
    expect(restored.protected).toBe(false);
  });

  it('成功判定保存后从同一六点快照重新恢复合格结果', () => {
    const readings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
    expect(saveCalibrationState({ readings }, readings)).toBe(true);

    const restored = loadCalibrationState();
    expect(restored.judgedRaws).toEqual(readings);
    expect(restored.result?.verdict).toBe('pass');
    if (restored.result?.verdict === 'pass') {
      expect(restored.result.threshold.spread).toBe(0.1);
      expect(restored.result.readings.map((point) => point.value)).toEqual([0.7, 0.72, 0.74, 0.76, 0.78, 0.8]);
    }
  });

  it('需调机判定同样作为完整快照保留', () => {
    const readings = ['0.70', '0.71', '0.72', '0.73', '0.74', '0.91'];
    expect(saveCalibrationState({ readings }, readings)).toBe(true);

    const restored = loadCalibrationState();
    expect(restored.judgedRaws).toEqual(readings);
    expect(restored.result?.verdict).toBe('adjust');
  });

  it('兼容既有合法 v1 判定记录和 v1 草稿记录', () => {
    const readings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
    setStored({ draft: { readings }, judgedRaws: readings });
    expect(loadCalibrationState().result?.verdict).toBe('pass');

    const partial = ['0.71', '', '0.73'];
    setStored({ draft: { readings: partial }, judgedRaws: null });
    const restored = loadCalibrationState();
    expect(restored.draft.readings).toEqual(['0.71', '', '0.73', '', '', '']);
    expect(restored.result).toBeNull();
    expect(restored.warning?.kind).toBe('old-format');
    expect(restored.protected).toBe(true);
  });

  it('草稿与判定读数不一致时不显示结论，并保护原存档', () => {
    const draft = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
    const judged = ['0.60', '0.62', '0.64', '0.66', '0.68', '0.70'];
    setStored({ version: 2, draft: { readings: draft }, judgedRaws: judged });

    const restored = loadCalibrationState();
    expect(restored.draft.readings).toEqual(draft);
    expect(restored.judgedRaws).toBeNull();
    expect(restored.result).toBeNull();
    expect(restored.warning?.kind).toBe('inconsistent-snapshot');
    expect(restored.protected).toBe(true);
  });

  it('少于六项时只显示可取证部分，不静默补空形成有效记录', () => {
    const values = ['0.70', '0.72', '0.74', '0.75', '0.76'];
    setStored({ version: 2, draft: values, judgedRaws: null });

    const restored = loadCalibrationState();
    expect(restored.draft.readings).toEqual(['0.70', '0.72', '0.74', '0.75', '0.76', '']);
    expect(restored.result).toBeNull();
    expect(restored.warning?.kind).toBe('short-record');
    expect(restored.protected).toBe(true);
  });

  it('多于六项时不截断判定，展示前六项取证并保护原存档', () => {
    const values = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80', '0.99'];
    setStored({ version: 2, draft: values, judgedRaws: null });

    const restored = loadCalibrationState();
    expect(restored.draft.readings).toEqual(['0.70', '0.72', '0.74', '0.76', '0.78', '0.80']);
    expect(restored.result).toBeNull();
    expect(restored.warning?.kind).toBe('overlong-record');
    expect(restored.protected).toBe(true);
  });

  it('旧版损坏、未知版本、字段类型损坏或 JSON 损坏时告警且不显示结论', () => {
    setStored({ draft: ['0.7', '0.71', '0.72', '0.73', '0.74'], judgedRaws: null });
    const oldDamage = loadCalibrationState();
    expect(oldDamage.warning?.kind).toBe('old-format');
    expect(oldDamage.protected).toBe(true);
    expect(oldDamage.result).toBeNull();

    const readings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
    setStored({ version: 3, draft: { readings }, judgedRaws: readings });
    const unknown = loadCalibrationState();
    expect(unknown.warning?.kind).toBe('unknown-version');
    expect(unknown.result).toBeNull();
    expect(unknown.protected).toBe(true);

    setStored({ version: 2, draft: { readings: [1, 2, 3, 4, 5, 6] }, judgedRaws: null });
    const fieldDamage = loadCalibrationState();
    expect(fieldDamage.warning?.kind).toBe('corrupted-record');
    expect(fieldDamage.protected).toBe(true);

    window.localStorage.setItem(STORAGE_KEY, '{不是合法 JSON');
    const jsonDamage = loadCalibrationState();
    expect(jsonDamage.warning?.kind).toBe('corrupted-record');
    expect(jsonDamage.draft).toEqual(createDraft());
    expect(jsonDamage.protected).toBe(true);
  });

  it('完整六点但判定读数重新计算受阻时，不恢复有效结论', () => {
    const readings = ['', 'abc', '0.74', '0.76', '0.78', '0.80'];
    setStored({ version: 2, draft: { readings }, judgedRaws: readings });

    const restored = loadCalibrationState();
    expect(restored.result).toBeNull();
    expect(restored.judgedRaws).toBeNull();
    expect(restored.warning?.kind).toBe('invalid-judgment');
    expect(restored.protected).toBe(true);
  });

  it('保存契约非法时拒绝写入', () => {
    setStored({ version: 2, draft: { readings: createDraft().readings }, judgedRaws: null });
    const original = window.localStorage.getItem(STORAGE_KEY);

    expect(saveCalibrationState({ readings: ['0.7'] }, null)).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);

    const readings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
    expect(saveCalibrationState({ readings }, ['0.60', ...readings.slice(1)])).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it('写入因配额或权限失败时返回 false，原始存档逐字不变', () => {
    setStored({ version: 2, draft: { readings: createDraft().readings }, judgedRaws: null });
    const original = window.localStorage.getItem(STORAGE_KEY);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    const readings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
    expect(saveCalibrationState({ readings }, readings)).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it('clearCalibrationState 清空草稿与结果', () => {
    saveCalibrationState({ readings: ['0.7', '0.71', '0.72', '0.73', '0.74', '0.75'] }, null);
    expect(clearCalibrationState()).toBe(true);
    expect(loadCalibrationState().draft).toEqual(createDraft());
    expect(loadCalibrationState().result).toBeNull();
  });

  it('删除失败时返回 false 且原存档不变', () => {
    saveCalibrationState({ readings: ['0.7', '0.71', '0.72', '0.73', '0.74', '0.75'] }, null);
    const original = window.localStorage.getItem(STORAGE_KEY);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(clearCalibrationState()).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
  });
});
