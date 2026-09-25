import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReleaseSlip, type CalibrationGateView, type ReleaseSlip } from '../../src/lib/release';
import {
  __resetReleaseMemoryForTests,
  appendReleaseSlip,
  clearReleaseState,
  loadReleaseState
} from '../../src/lib/releaseStorage';

const STORAGE_KEY = 'braille-plate:release:v1';

const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
const passGate: CalibrationGateView = {
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
    threshold: { min: 0.7, max: 0.8, spread: 0.1, spreadLimit: 0.15, spreadOk: true, rangeMin: 0.6, rangeMax: 0.9 },
    conclusion: '整机结论：合格。'
  },
  judgedRaws: legalReadings.slice(),
  currentReadings: legalReadings.slice(),
  protected: false,
  recordVersion: 2
};

let seq = 0;
function makeSlip(text = '12，三。', width: string | number = '4'): ReleaseSlip {
  seq += 1;
  const sources = { now: () => new Date(Date.UTC(2026, 8, 24, 10, 30, seq)), random: () => seq / 256 };
  return createReleaseSlip({ text, rawWidth: width, gate: passGate }, sources).slip!;
}

function setStored(value: unknown) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

describe('releaseStorage 放行单只追加存档', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetReleaseMemoryForTests();
    vi.restoreAllMocks();
  });

  it('首次加载无单据且不保护', () => {
    const state = loadReleaseState();
    expect(state.slips).toEqual([]);
    expect(state.warning).toBeNull();
    expect(state.protected).toBe(false);
  });

  it('成功签发的单据追加保存，刷新后按签发顺序恢复并冻结', () => {
    const first = makeSlip();
    const second = makeSlip('一二三', '8');
    expect(appendReleaseSlip(first)).toBe(true);
    expect(appendReleaseSlip(second)).toBe(true);

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(1);
    expect(stored.slips).toHaveLength(2);

    const restored = loadReleaseState();
    expect(restored.protected).toBe(false);
    expect(restored.slips.map((slip) => slip.id)).toEqual([first.id, second.id]);
    expect(Object.isFrozen(restored.slips[0])).toBe(true);
    expect(restored.slips[1].snapshot.draft.width).toBe(8);
  });

  it('重复签发同标识单据幂等，不重复追加', () => {
    const slip = makeSlip();
    expect(appendReleaseSlip(slip)).toBe(true);
    expect(appendReleaseSlip(slip)).toBe(true);
    expect(loadReleaseState().slips).toHaveLength(1);
  });

  it('非法单据不写入', () => {
    expect(appendReleaseSlip({ id: 'bad' } as unknown as ReleaseSlip)).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('JSON 损坏、字段损坏、未知版本、单据不可信：告警保护且保留最近一次完整记录', () => {
    const slip = makeSlip();
    appendReleaseSlip(slip);

    window.localStorage.setItem(STORAGE_KEY, '{不是合法 JSON');
    const jsonDamage = loadReleaseState();
    expect(jsonDamage.protected).toBe(true);
    expect(jsonDamage.warning?.kind).toBe('corrupted-json');
    // 最近一次完整记录仍可只读复核
    expect(jsonDamage.slips.map((s) => s.id)).toEqual([slip.id]);

    setStored({ version: 1, slips: 'nope' });
    const fieldDamage = loadReleaseState();
    expect(fieldDamage.protected).toBe(true);
    expect(fieldDamage.warning?.kind).toBe('corrupted-record');

    setStored({ version: 9, slips: [] });
    const unknownVersion = loadReleaseState();
    expect(unknownVersion.protected).toBe(true);
    expect(unknownVersion.warning?.kind).toBe('unknown-version');

    const tampered = structuredClone(slip);
    tampered.snapshot.draft.text = '被篡改';
    setStored({ version: 1, slips: [tampered] });
    const invalidSlip = loadReleaseState();
    expect(invalidSlip.protected).toBe(true);
    expect(invalidSlip.warning?.kind).toBe('invalid-slip');
    // 内存中的最近一次完整记录仍保留
    expect(invalidSlip.slips.map((s) => s.id)).toEqual([slip.id]);
  });

  it('保护态下追加写入被拒绝，原存档逐字不变', () => {
    window.localStorage.setItem(STORAGE_KEY, '{坏 JSON');
    const original = window.localStorage.getItem(STORAGE_KEY);
    expect(appendReleaseSlip(makeSlip())).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it('写入配额失败时返回 false，原存档不变；恢复后仍可追加', () => {
    const existing = makeSlip();
    appendReleaseSlip(existing);
    const original = window.localStorage.getItem(STORAGE_KEY);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(appendReleaseSlip(makeSlip('一二三'))).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
    vi.restoreAllMocks();

    const another = makeSlip('三四五');
    expect(appendReleaseSlip(another)).toBe(true);
    expect(loadReleaseState().slips.map((s) => s.id)).toEqual([existing.id, another.id]);
  });

  it('clearReleaseState 清空历史与内存缓存', () => {
    appendReleaseSlip(makeSlip());
    expect(clearReleaseState()).toBe(true);
    const state = loadReleaseState();
    expect(state.slips).toEqual([]);
    expect(state.protected).toBe(false);
  });
});
