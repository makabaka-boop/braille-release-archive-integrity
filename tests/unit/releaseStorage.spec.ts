import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReleaseSlip, type CalibrationGateView, type ReleaseSlip } from '../../src/lib/release';
import {
  __resetReleaseMemoryForTests,
  appendReleaseSlip,
  clearReleaseState,
  loadReleaseState,
  mergeReleaseSlip
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
    expect(appendReleaseSlip(first).outcome).toBe('appended');
    expect(appendReleaseSlip(second).outcome).toBe('appended');

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(1);
    expect(stored.slips).toHaveLength(2);

    const restored = loadReleaseState();
    expect(restored.protected).toBe(false);
    expect(restored.slips.map((slip) => slip.id)).toEqual([first.id, second.id]);
    expect(Object.isFrozen(restored.slips[0])).toBe(true);
    expect(restored.slips[1].snapshot.draft.width).toBe(8);
  });

  it('重复签发同标识且内容一致的单据幂等，不重复追加', () => {
    const slip = makeSlip();
    expect(appendReleaseSlip(slip).outcome).toBe('appended');
    const again = appendReleaseSlip(structuredClone(slip));
    expect(again.outcome).toBe('duplicate');
    if (again.outcome === 'duplicate') {
      expect(again.existing.id).toBe(slip.id);
    }
    expect(loadReleaseState().slips).toHaveLength(1);
  });

  it('相同编号但快照内容不同：明确编号冲突，拒绝写入且历史原件逐字保留', () => {
    const original = makeSlip('一二三', '4');
    expect(appendReleaseSlip(original).outcome).toBe('appended');
    const beforeRaw = window.localStorage.getItem(STORAGE_KEY);

    // 另一份单据内容不同（不同原文），但被赋予相同编号
    const colliding = structuredClone(makeSlip('四五六', '4'));
    colliding.id = original.id;
    expect(colliding.id).toBe(original.id);

    const result = appendReleaseSlip(colliding);
    expect(result.outcome).toBe('id-conflict');
    if (result.outcome === 'id-conflict') {
      expect(result.existing.id).toBe(original.id);
      expect(result.error).toContain('编号冲突');
    }

    // 原存档一个字节都不变，历史只有原件且内容仍是“一二三”
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(beforeRaw);
    const state = loadReleaseState();
    expect(state.slips).toHaveLength(1);
    expect(state.slips[0].snapshot.draft.text).toBe('一二三');
    expect(state.slips[0].id).toBe(original.id);
  });

  it('历史只增不删：超过 200 次签发后最早的单据仍然可查，无静默消失', () => {
    const slips: ReleaseSlip[] = [];
    for (let i = 0; i < 205; i += 1) {
      slips.push(makeSlip(i % 2 === 0 ? '一二三' : '四五六', '4'));
    }
    for (const slip of slips) {
      expect(appendReleaseSlip(slip).outcome).toBe('appended');
    }

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.slips).toHaveLength(205);
    const state = loadReleaseState();
    expect(state.protected).toBe(false);
    expect(state.slips).toHaveLength(205);
    // 最早的第 1 张与最新的第 205 张都在，顺序就是签发顺序
    expect(state.slips[0].id).toBe(slips[0].id);
    expect(state.slips[0].snapshot.draft.text).toBe('一二三');
    expect(state.slips[204].id).toBe(slips[204].id);
    expect(state.slips[204].snapshot.draft.text).toBe('一二三');
    // 每份编号唯一、内容与签发时一致
    expect(new Set(state.slips.map((slip) => slip.id)).size).toBe(205);
    state.slips.forEach((slip, index) => {
      expect(slip.snapshot.draft.text).toBe(index % 2 === 0 ? '一二三' : '四五六');
    });
  });

  it('双页签交错写入：另一页签在本页签读取后写入的单据不会被覆盖', () => {
    // 页签 A 先签发一张
    const a1 = makeSlip('一二三', '4');
    expect(appendReleaseSlip(a1).outcome).toBe('appended');

    // 页签 B 基于自己看到的列表 [a1] 追加自己的单据并整体写回磁盘
    const b1 = makeSlip('四五六', '6');
    setStored({ version: 1, slips: [a1, b1] });

    // 页签 A 内存中的基线可能仍是 [a1]，但再次签发必须以磁盘最新状态合并，
    // 绝不能用 [a1, a2] 覆盖掉 b1。
    const a2 = makeSlip('七八九', '8');
    const result = appendReleaseSlip(a2);
    expect(result.outcome).toBe('appended');

    const state = loadReleaseState();
    expect(state.slips.map((slip) => slip.id)).toEqual([a1.id, b1.id, a2.id]);
    expect(state.slips[1].snapshot.draft.text).toBe('四五六');
    expect(state.slips[2].snapshot.draft.width).toBe(8);
  });

  it('交错写入时两页签各自连续追加，所有单据按到达顺序保留', () => {
    const a1 = makeSlip('一', '4');
    appendReleaseSlip(a1);

    // 模拟 A、B 两页签你一张我一张：B 每次带着磁盘上已有的全部单据写回
    const b1 = makeSlip('二', '4');
    setStored({ version: 1, slips: [a1, b1] });
    const a2 = makeSlip('三', '4');
    expect(appendReleaseSlip(a2).outcome).toBe('appended');
    const b2 = makeSlip('四', '4');
    const current = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    setStored({ version: 1, slips: [...current.slips, b2] });
    const a3 = makeSlip('五', '4');
    expect(appendReleaseSlip(a3).outcome).toBe('appended');

    const ids = loadReleaseState().slips.map((slip) => slip.id);
    expect(ids).toEqual([a1.id, b1.id, a2.id, b2.id, a3.id]);
  });

  it('mergeReleaseSlip 纯合并契约：追加 / 幂等 / 编号冲突', () => {
    const first = makeSlip();
    const second = makeSlip('一二三', '8');

    const appended = mergeReleaseSlip([first], second);
    expect(appended.outcome).toBe('appended');
    if (appended.outcome === 'appended') {
      expect(appended.slips.map((slip) => slip.id)).toEqual([first.id, second.id]);
    }

    const duplicate = mergeReleaseSlip([first, second], structuredClone(first));
    expect(duplicate.outcome).toBe('duplicate');
    if (duplicate.outcome === 'duplicate') {
      expect(duplicate.existing).toBe(first);
      expect(duplicate.slips).toHaveLength(2);
    }

    const colliding = structuredClone(first);
    colliding.snapshot.draft.text = '被改写';
    const conflict = mergeReleaseSlip([first, second], colliding as ReleaseSlip);
    expect(conflict.outcome).toBe('id-conflict');
  });

  it('非法单据不写入', () => {
    expect(appendReleaseSlip({ id: 'bad' } as unknown as ReleaseSlip).outcome).toBe('invalid-slip');
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
    const result = appendReleaseSlip(makeSlip());
    expect(result.outcome).toBe('protected');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it('写入配额失败时返回 write-failed，原存档不变；恢复后仍可追加', () => {
    const existing = makeSlip();
    appendReleaseSlip(existing);
    const original = window.localStorage.getItem(STORAGE_KEY);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    const failed = appendReleaseSlip(makeSlip('一二三'));
    expect(failed.outcome).toBe('write-failed');
    if (failed.outcome === 'write-failed') {
      expect(failed.error).toContain('写入失败');
    }
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
    vi.restoreAllMocks();

    const another = makeSlip('三四五');
    expect(appendReleaseSlip(another).outcome).toBe('appended');
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
