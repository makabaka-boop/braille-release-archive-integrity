import { createApp, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReleaseWorkspace from '../../src/components/ReleaseWorkspace.vue';
import { useCalibrationSession, __resetCalibrationSessionForTests } from '../../src/lib/calibrationSession';
import { useDraftSession, __resetDraftSessionForTests } from '../../src/lib/draftSession';
import { __resetReleaseSessionForTests } from '../../src/lib/releaseSession';
import { __resetReleaseMemoryForTests } from '../../src/lib/releaseStorage';

const DRAFT_KEY = 'braille-plate:draft:v1';
const CALIBRATION_KEY = 'braille-plate:calibration:v1';
const RELEASE_KEY = 'braille-plate:release:v1';

const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

function mountRelease() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(ReleaseWorkspace);
  app.mount(container);
  return {
    container,
    unmount() {
      app.unmount();
      container.remove();
    }
  };
}

function $(selector: string): Element | null {
  return document.querySelector(selector);
}

async function tick(times = 2) {
  for (let i = 0; i < times; i += 1) {
    await nextTick();
  }
}

/** 通过共享会话驱动界面，等价于在单稿预检页与校准工作区的真实操作。 */
function sessions() {
  return { draft: useDraftSession(), calibration: useCalibrationSession() };
}

async function preparePass(text = '12，三。', width = '4', values: string[] = legalReadings) {
  const { draft, calibration } = sessions();
  draft.text.value = text;
  draft.width.value = String(width);
  calibration.readings.value = values.slice();
  await tick(1);
  calibration.runJudge();
  await tick(2);
  return { draft, calibration };
}

function dispatchStorage(key: string) {
  window.dispatchEvent(new StorageEvent('storage', { key }));
}

describe('ReleaseWorkspace 合格签发、失效与只读复核', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.restoreAllMocks();
    __resetReleaseSessionForTests();
    __resetReleaseMemoryForTests();
    __resetCalibrationSessionForTests();
    __resetDraftSessionForTests();
  });

  it('单稿非法或未判定合格时签发按钮禁用，并列明阻断原因', async () => {
    const { draft, calibration } = sessions();
    draft.text.value = '12楼';
    draft.width.value = '4';
    const mounted = mountRelease();
    await tick();

    const issue = $('[data-testid="release-issue"]') as HTMLButtonElement;
    expect(issue.disabled).toBe(true);
    expect($('[data-testid="gate-draft-blockers"]')?.textContent).toContain('不在允许范围内');
    expect($('[data-testid="gate-calibration-blockers"]')?.textContent).toContain('尚未完成');

    draft.text.value = '12，三。';
    await tick();
    expect($('[data-testid="gate-draft-ok"]')).not.toBeNull();
    // 校准仍未判定
    expect(issue.disabled).toBe(true);
    void calibration;
    mounted.unmount();
  });

  it('合格签发后展示独立标识与来源快照，历史同步出现且只读', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();

    const issue = $('[data-testid="release-issue"]') as HTMLButtonElement;
    expect(issue.disabled).toBe(false);
    issue.click();
    await tick();

    const active = $('[data-testid="release-active"]') as Element;
    expect(active).not.toBeNull();
    const slipId = active.querySelector('[data-testid="slip-id"]')?.textContent ?? '';
    expect(slipId).toMatch(/PF-\d{8}-\d{6}-[0-9a-f]{8}/);

    // 来源快照：原文、行宽、逐方编码、排版（只在当前授权卡片内计数）
    expect(active.querySelector('[data-testid="slip-draft-text"]')?.textContent).toContain('12，三。');
    expect(active.querySelector('[data-testid="slip-draft-width"]')?.textContent).toContain('每行方数：4');
    expect(active.querySelectorAll('[data-testid="slip-line"]')).toHaveLength(2);
    expect(active.querySelectorAll('[data-testid="slip-point-row"]')).toHaveLength(6);
    expect(active.querySelector('[data-testid="slip-threshold"]')?.textContent).toContain('极差 0.10 毫米');

    // 历史区有同一张只读单据
    const historyItems = document.querySelectorAll('[data-testid="release-history-item"]');
    expect(historyItems).toHaveLength(1);
    expect(historyItems[0].getAttribute('data-slip-id')).toMatch(/^PF-/);

    // 快照字段冻结（不可变）
    const stored = JSON.parse(window.localStorage.getItem(RELEASE_KEY) ?? '{}');
    expect(stored.slips[0].snapshot.calibration.verdict).toBe('pass');

    mounted.unmount();
  });

  it('需调机或受阻读数下不能签发', async () => {
    const adjustReadings = legalReadings.slice();
    adjustReadings[5] = '0.91';
    await preparePass('一二三', '4', adjustReadings);
    const mounted = mountRelease();
    await tick();
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);
    expect($('[data-testid="gate-calibration-blockers"]')?.textContent).toContain('需调机');
    mounted.unmount();
  });

  it('签发后修改文字、行宽或任一点读数：当前授权立即失效，历史仍只读保留', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick();
    const issuedId = document.querySelectorAll('[data-testid="slip-id"]')[0].textContent ?? '';
    expect($('[data-testid="release-active"]')).not.toBeNull();

    const { draft } = sessions();
    draft.text.value = '12，四。';
    await tick(2);
    expect($('[data-testid="release-active"]')).toBeNull();
    expect($('[data-testid="release-invalidated"]')?.textContent).toContain('已失效');
    // 历史单据未被草稿覆盖，仍是原文
    const historyText = $('[data-testid="slip-draft-text"]')?.textContent ?? '';
    expect(historyText).toContain('12，三。');
    expect(document.querySelectorAll('[data-testid="release-history-item"]')).toHaveLength(1);

    // 改回原文也不会自动恢复授权
    draft.text.value = '12，三。';
    await tick(2);
    expect($('[data-testid="release-active"]')).toBeNull();

    // 重新签发产生新单据，历史变为两份
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick();
    expect(document.querySelectorAll('[data-testid="release-history-item"]')).toHaveLength(2);
    void issuedId;
    mounted.unmount();
  });

  it('签发后改动任一校准读数同样立即失效', async () => {
    const { calibration } = await preparePass();
    const mounted = mountRelease();
    await tick();
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick();
    expect($('[data-testid="release-active"]')).not.toBeNull();

    calibration.readings.value[0] = '0.65';
    await tick(3);
    expect($('[data-testid="release-active"]')).toBeNull();
    expect($('[data-testid="release-invalidated"]')).not.toBeNull();
    // 历史单据固化的读数仍为签发时的 0.70
    const firstRaw = document.querySelector('[data-testid="release-history-item"] [data-testid="slip-point-raw"]')?.textContent;
    expect(firstRaw).toBe('0.70');
    mounted.unmount();
  });

  it('旧版校准存档即使兼容恢复结论也不能放行，必须重新判定', async () => {
    window.localStorage.setItem(
      CALIBRATION_KEY,
      JSON.stringify({ draft: { readings: legalReadings }, judgedRaws: legalReadings })
    );
    const { draft } = sessions();
    draft.text.value = '12，三。';
    draft.width.value = '4';
    const mounted = mountRelease();
    await tick(2);

    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);
    expect($('[data-testid="gate-calibration-blockers"]')?.textContent).toContain('旧版校准存档');

    // 重新执行一次判定（写入当前版本）后可签发
    sessions().calibration.runJudge();
    await tick(2);
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(false);
    mounted.unmount();
  });

  it('刷新恢复旧放行单不自动当作当前授权，只提示重新签发；历史只读可复核', async () => {
    await preparePass();
    const first = mountRelease();
    await tick();
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick();
    first.unmount();

    // 模拟真正的页面刷新：JS 上下文重建，放行会话单例不复存在
    // （单稿 / 校准会话仍可从 localStorage 恢复，与真实刷新一致）。
    __resetReleaseSessionForTests();
    const second = mountRelease();
    await tick(2);
    expect($('[data-testid="release-active"]')).toBeNull();
    expect($('[data-testid="release-need-reissue"]')?.textContent).toContain('不自动作为当前授权');
    expect(document.querySelectorAll('[data-testid="release-history-item"]')).toHaveLength(1);
    second.unmount();
  });

  it('跨标签页收到新的合格校准更新后才允许放行；旧单据不自动授权', async () => {
    const { draft } = sessions();
    draft.text.value = '12，三。';
    draft.width.value = '4';
    const mounted = mountRelease();
    await tick();
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);

    // 另一标签写入当前版本合格判定
    window.localStorage.setItem(
      CALIBRATION_KEY,
      JSON.stringify({ version: 2, draft: { readings: legalReadings }, judgedRaws: legalReadings })
    );
    dispatchStorage(CALIBRATION_KEY);
    await tick(2);

    expect($('[data-testid="gate-calibration-pass"]')?.textContent).toContain('合格');
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(false);

    // 跨标签收到损坏 / 旧版更新不能成为授权
    window.localStorage.setItem(CALIBRATION_KEY, '{坏 JSON');
    dispatchStorage(CALIBRATION_KEY);
    await tick(2);
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);
    expect($('[data-testid="gate-calibration-blockers"]')?.textContent).toContain('保护');
    mounted.unmount();
  });

  it('跨标签页修改单稿文字会让当前授权立即失效', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick();
    expect($('[data-testid="release-active"]')).not.toBeNull();

    // 另一标签保存了新的单稿草稿（完整、版本相符）
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, text: '三四五', width: '4' }));
    dispatchStorage(DRAFT_KEY);
    await tick(2);
    expect($('[data-testid="release-active"]')).toBeNull();
    expect($('[data-testid="release-invalidated"]')).not.toBeNull();
    mounted.unmount();
  });

  it('放行存档损坏：告警、保留最近一次完整记录只读复核，且拒绝新写入', async () => {
    await preparePass();
    const first = mountRelease();
    await tick();
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick();
    first.unmount();

    window.localStorage.setItem(RELEASE_KEY, '{损坏');
    const second = mountRelease();
    await tick(2);
    expect($('[data-testid="release-archive-warning"]')?.textContent).toContain('无法安全恢复');
    // 最近一次完整记录仍只读可复核
    expect(document.querySelectorAll('[data-testid="release-history-item"]')).toHaveLength(1);
    expect(($('[data-testid="release-issue"]') as HTMLButtonElement).disabled).toBe(true);

    const before = window.localStorage.getItem(RELEASE_KEY);
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick();
    expect(window.localStorage.getItem(RELEASE_KEY)).toBe(before);
    second.unmount();
  });

  it('放行单写入失败：明确告警、原存档保留、不产生伪签发', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();

    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if (key === RELEASE_KEY) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
    });

    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick(2);
    expect($('[data-testid="release-write-error"]')?.textContent).toContain('历史放行单与原存档仍保留');
    expect($('[data-testid="release-active"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="release-history-item"]')).toHaveLength(0);

    spy.mockRestore();
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick(2);
    expect($('[data-testid="release-active"]')).not.toBeNull();
    expect($('[data-testid="release-write-error"]')).toBeNull();
    mounted.unmount();
  });

  it('编号冲突通过界面签发时：明确告警、历史保留原件且不出现新当前授权', async () => {
    await preparePass('12，三。', '4');
    const mounted = mountRelease();
    await tick();
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick();
    expect($('[data-testid="release-active"]')).not.toBeNull();

    // 模拟“下一张单据恰好拿到相同编号但内容不同”：拦截存储层追加结果为编号冲突。
    const storageModule = await import('../../src/lib/releaseStorage');
    const spy = vi.spyOn(storageModule, 'appendReleaseSlip').mockReturnValue({ ok: false, kind: 'id-conflict' });

    sessions().draft.text.value = '99，九。';
    await tick(2);
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick(3);

    expect($('[data-testid="release-write-error"]')?.textContent).toContain('编号与历史单据相同但内容不一致');
    expect(document.querySelectorAll('[data-testid="release-history-item"]')).toHaveLength(1);
    expect($('[data-testid="release-history-item"] [data-testid="slip-draft-text"]')?.textContent).toContain(
      '12，三。'
    );
    // 冲突件没有成为当前授权
    expect($('[data-testid="release-active"]')).toBeNull();

    spy.mockRestore();
    mounted.unmount();
  });

  it('跨页签旧整表覆盖本页签单据后自动补齐：历史含两张并显示修复提示', async () => {
    await preparePass();
    const mounted = mountRelease();
    await tick();
    ($('[data-testid="release-issue"]') as HTMLButtonElement).click();
    await tick();
    const mineId =
      document.querySelector('[data-testid="release-active"] [data-testid="slip-id"]')?.textContent ?? '';
    expect(mineId).not.toBe('');

    // 另一页签签发一张，随后用“不含本页签单据”的旧整表覆盖
    const { createReleaseSlip } = await import('../../src/lib/release');
    const passView = {
      verdict: 'pass' as const,
      result: sessions().calibration.result.value!,
      judgedRaws: sessions().calibration.judgedRaws.value,
      currentReadings: sessions().calibration.readings.value,
      protected: false,
      recordVersion: 2
    };
    const theirs = createReleaseSlip(
      { text: '一二三', rawWidth: '4', gate: passView },
      { now: () => new Date(Date.UTC(2026, 8, 25)), random: () => 0.42 }
    ).slip!;
    window.localStorage.setItem(RELEASE_KEY, JSON.stringify({ version: 1, slips: [theirs] }));
    window.dispatchEvent(new StorageEvent('storage', { key: RELEASE_KEY }));
    await tick(3);

    // 两张单据都在历史中，且有一次性修复提示
    expect(document.querySelectorAll('[data-testid="release-history-item"]')).toHaveLength(2);
    expect($('[data-testid="release-archive-notice"]')?.textContent).toContain('合并补写');

    // 再触发一次存储事件不会重复提示（一次性通知已被消费）
    window.dispatchEvent(new StorageEvent('storage', { key: RELEASE_KEY }));
    await tick(2);
    expect($('[data-testid="release-archive-notice"]')).toBeNull();
    mounted.unmount();
  });
});

