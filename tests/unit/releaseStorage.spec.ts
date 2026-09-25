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

/** 第 n 张使用互不相同的合法原文（仅数字 + 标点，均在允许字符集内）。 */
function distinctText(n: number): string {
  return `${n % 10}`.repeat(1 + (n % 4)) + '，三。';
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
    expect(state.notice).toBeNull();
  });

  it('成功签发的单据追加保存，刷新后按签发顺序恢复并冻结', () => {
    const first = makeSlip();
    const second = makeSlip('一二三', '8');
    expect(appendReleaseSlip(first)).toEqual({ ok: true });
    expect(appendReleaseSlip(second)).toEqual({ ok: true });

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(1);
    expect(stored.slips).toHaveLength(2);

    const restored = loadReleaseState();
    expect(restored.protected).toBe(false);
    expect(restored.slips.map((slip) => slip.id)).toEqual([first.id, second.id]);
    expect(Object.isFrozen(restored.slips[0])).toBe(true);
    expect(restored.slips[1].snapshot.draft.width).toBe(8);
  });

  it('历史只增不减：超过 200 张后第 1 张仍然可查，累计 205 张全部保留', () => {
    const slips: ReleaseSlip[] = [];
    for (let i = 0; i < 205; i += 1) {
      const slip = makeSlip(distinctText(i), '4');
      slips.push(slip);
      expect(appendReleaseSlip(slip)).toEqual({ ok: true });
    }

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.slips).toHaveLength(205);

    const restored = loadReleaseState();
    expect(restored.slips).toHaveLength(205);
    // 最早的单据没有被静默顶掉
    expect(restored.slips[0].id).toBe(slips[0].id);
    expect(restored.slips[0].snapshot.draft.text).toBe(slips[0].snapshot.draft.text);
    // 每张单据内容与签发时逐字一致（当前放行单与历史原件一致的可复核基础）
    for (let i = 0; i < slips.length; i += 1) {
      expect(restored.slips[i].id).toBe(slips[i].id);
      expect(restored.slips[i].snapshot.draft.text).toBe(slips[i].snapshot.draft.text);
    }
  });

  it('重复签发同标识且内容相同的单据幂等，不重复追加', () => {
    const slip = makeSlip();
    expect(appendReleaseSlip(slip)).toEqual({ ok: true });
    expect(appendReleaseSlip(slip)).toEqual({ ok: true });
    expect(loadReleaseState().slips).toHaveLength(1);
  });

  it('受控相同编号但内容不同：明确拒绝写入，历史原单据逐字保留且不成为伪签发', () => {
    const first = makeSlip('12，三。');
    expect(appendReleaseSlip(first)).toEqual({ ok: true });

    // 另一份合法单据（不同原文、不同快照）恰好拿到相同编号
    const legitDifferent = makeSlip('99，九。');
    expect(legitDifferent.id).not.toBe(first.id);
    const conflicting = { ...structuredClone(legitDifferent), id: first.id };

    const outcome = appendReleaseSlip(conflicting as ReleaseSlip);
    expect(outcome).toEqual({ ok: false, kind: 'id-conflict' });

    // 存档仍是一份，且是第一次签发的原件（内容未被第二次覆盖）
    const restored = loadReleaseState();
    expect(restored.slips).toHaveLength(1);
    expect(restored.slips[0].id).toBe(first.id);
    expect(restored.slips[0].snapshot.draft.text).toBe('12，三。');
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.slips[0].snapshot.draft.text).toBe('12，三。');
  });

  it('非法单据不写入', () => {
    expect(appendReleaseSlip({ id: 'bad' } as unknown as ReleaseSlip)).toEqual({
      ok: false,
      kind: 'write-failed'
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('双页签交错写入：写间隙被另一页签的旧整表覆盖时自动合并，两张单据最终都在历史', () => {
    // 模拟“本页签”先读到空列表；在它写回 [A] 的同一时刻，
    // “另一页签”用自己读到的旧空列表追加 B 后整表覆盖为 [B]。
    const slipA = makeSlip('12，三。');
    const slipB = makeSlip('一二三', '8');

    let overwriteOnce = true;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    setItemSpy.mockImplementation(function (this: Storage, key: string, value: string) {
      setItemSpy.mockRestore();
      Storage.prototype.setItem.call(this, key, value);
      if (key === STORAGE_KEY && overwriteOnce) {
        overwriteOnce = false;
        // 另一页签的写入基于更旧的列表，整体覆盖掉本页签刚追加的 A
        const othersTable = JSON.stringify({ version: 1, slips: [slipB] });
        Storage.prototype.setItem.call(this, key, othersTable);
      }
    });

    expect(appendReleaseSlip(slipA)).toEqual({ ok: true });

    const ids = loadReleaseState().slips.map((slip) => slip.id).sort();
    expect(ids).toEqual([slipA.id, slipB.id].sort());
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.slips).toHaveLength(2);
  });

  it('跨页签 storage 事件发现本页签单据被旧列表覆盖：补写修复并给出一次性提示', () => {
    const mine = makeSlip('12，三。');
    expect(appendReleaseSlip(mine)).toEqual({ ok: true });

    // 另一页签用不含本页签单据的旧整表覆盖
    const theirs = makeSlip('一二三', '8');
    setStored({ version: 1, slips: [theirs] });
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));

    const repaired = loadReleaseState();
    expect(repaired.slips.map((slip) => slip.id).sort()).toEqual([mine.id, theirs.id].sort());
    expect(repaired.notice?.kind).toBe('cross-tab-repaired');
    // 一次性提示：下次加载不再重复
    expect(loadReleaseState().notice).toBeNull();
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
    expect(appendReleaseSlip(makeSlip())).toEqual({ ok: false, kind: 'write-failed' });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it('写入配额失败时返回失败，原存档不变；恢复后仍可追加', () => {
    const existing = makeSlip();
    appendReleaseSlip(existing);
    const original = window.localStorage.getItem(STORAGE_KEY);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(appendReleaseSlip(makeSlip('一二三'))).toEqual({ ok: false, kind: 'write-failed' });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);
    vi.restoreAllMocks();

    const another = makeSlip('三四五');
    expect(appendReleaseSlip(another)).toEqual({ ok: true });
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
