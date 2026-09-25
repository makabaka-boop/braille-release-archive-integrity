import { createApp, nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CalibrationWorkspace from '../../src/components/CalibrationWorkspace.vue';
import { __resetCalibrationSessionForTests, useCalibrationSession } from '../../src/lib/calibrationSession';

const STORAGE_KEY = 'braille-plate:calibration:v1';

function mountCalibration() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(CalibrationWorkspace);
  app.mount(container);
  return {
    container,
    unmount() {
      app.unmount();
      container.remove();
    }
  };
}

function setInput(index: number, value: string) {
  const input = document.querySelector(`[data-testid="height-input-${index + 1}"]`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return nextTick();
}

async function clickJudge() {
  const button = document.querySelector('[data-testid="calibration-judge"]') as HTMLButtonElement;
  button.click();
  await nextTick();
}

const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

async function fillLegalReadings() {
  for (const [index, value] of legalReadings.entries()) {
    await setInput(index, value);
  }
}

describe('CalibrationWorkspace 异常存档保护', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.restoreAllMocks();
    __resetCalibrationSessionForTests();
  });

  it('不一致存档只显示草稿和告警；修改不覆盖，重新有效判定后才写入新快照', async () => {
    const archive = {
      version: 2,
      draft: { readings: legalReadings },
      judgedRaws: ['0.60', '0.62', '0.64', '0.66', '0.68', '0.70']
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(archive));
    const original = window.localStorage.getItem(STORAGE_KEY);
    const mounted = mountCalibration();

    expect(document.querySelector('[data-testid="calibration-result"]')).toBeNull();
    expect(document.querySelector('[data-testid="calibration-archive-warning"]')?.textContent).toContain('不一致');

    await setInput(0, '0.65');
    expect(document.querySelector('[data-testid="calibration-storage-error"]')?.textContent).toContain('不会写入或覆盖原存档');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);

    await fillLegalReadings();
    await clickJudge();

    expect(document.querySelector('[data-testid="calibration-result"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="calibration-archive-warning"]')).toBeNull();
    expect(document.querySelector('[data-testid="calibration-storage-error"]')).toBeNull();
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(2);
    expect(stored.draft.readings).toEqual(legalReadings);
    expect(stored.judgedRaws).toEqual(legalReadings);

    mounted.unmount();
  });

  it('写入配额失败时显示失败告警并保留最近一次可恢复存档，之后重新判定成功才解除保护', async () => {
    const archive = { version: 2, draft: { readings: ['', '', '', '', '', ''] }, judgedRaws: null };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(archive));
    const original = window.localStorage.getItem(STORAGE_KEY);
    const mounted = mountCalibration();

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });

    await fillLegalReadings();
    await clickJudge();

    expect(document.querySelector('[data-testid="calibration-result"]')?.getAttribute('data-verdict')).toBe('pass');
    expect(document.querySelector('[data-testid="calibration-storage-error"]')?.textContent).toContain('原始存档仍保留');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(original);

    setItemSpy.mockRestore();
    await clickJudge();

    expect(document.querySelector('[data-testid="calibration-storage-error"]')).toBeNull();
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.version).toBe(2);
    expect(stored.judgedRaws).toEqual(legalReadings);

    mounted.unmount();
  });
});

describe('CalibrationSession 单例监听脱离组件生命周期', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    __resetCalibrationSessionForTests();
  });

  it('工作区卸载再重挂后，改动任一读数仍会让上次判定立即失效并保存草稿', async () => {
    let mounted = mountCalibration();
    await fillLegalReadings();
    await clickJudge();
    expect(document.querySelector('[data-testid="calibration-result"]')?.getAttribute('data-verdict')).toBe('pass');

    // 离开校准工作区（组件卸载）后再回来：单例的自动保存/失效监听必须仍然有效
    mounted.unmount();
    mounted = mountCalibration();
    await nextTick();
    await nextTick();
    expect(document.querySelector('[data-testid="calibration-result"]')?.getAttribute('data-verdict')).toBe('pass');

    const session = useCalibrationSession();
    session.readings.value[2] = '0.65';
    await nextTick();
    await nextTick();

    expect(document.querySelector('[data-testid="calibration-result"]')).toBeNull();
    // 改动已作为新草稿保存，刷新后按未判定草稿恢复（而不是旧的合格快照）
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored.judgedRaws).toBeNull();
    expect(stored.draft.readings[2]).toBe('0.65');

    mounted.unmount();
  });
});
