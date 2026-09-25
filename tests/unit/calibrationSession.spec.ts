import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetCalibrationSessionForTests, useCalibrationSession } from '../../src/lib/calibrationSession';

const STORAGE_KEY = 'braille-plate:calibration:v1';
const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

async function flush() {
  await nextTick();
  await nextTick();
}

describe('calibrationSession 跨标签页恢复', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetCalibrationSessionForTests();
  });

  afterEach(() => {
    window.localStorage.clear();
    __resetCalibrationSessionForTests();
  });

  it('收到另一标签的当前版本合格判定时完整恢复为当前授权依据', async () => {
    const session = useCalibrationSession();
    expect(session.result.value).toBeNull();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, draft: { readings: legalReadings }, judgedRaws: legalReadings })
    );
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    await flush();

    expect(session.result.value?.verdict).toBe('pass');
    expect(session.judgedRaws.value).toEqual(legalReadings);
    expect(session.recordVersion.value).toBe(2);
    expect(session.isProtectedArchive.value).toBe(false);
    expect(session.readings.value).toEqual(legalReadings);
  });

  it('收到损坏记录时进入保护态并告警，不把它当作授权依据', async () => {
    // 先有一份当前合格判定
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, draft: { readings: legalReadings }, judgedRaws: legalReadings })
    );
    const session = useCalibrationSession();
    expect(session.result.value?.verdict).toBe('pass');

    window.localStorage.setItem(STORAGE_KEY, '{坏 JSON');
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    await flush();

    expect(session.isProtectedArchive.value).toBe(true);
    expect(session.result.value).toBeNull();
    expect(session.archiveWarning.value).toContain('损坏');
  });

  it('收到旧版(v1)合格记录时标记版本 1（放行闸门据此要求重新判定）', async () => {
    const session = useCalibrationSession();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ draft: { readings: legalReadings }, judgedRaws: legalReadings })
    );
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    await flush();

    // 旧版兼容恢复出结论，但版本标记为 1
    expect(session.result.value?.verdict).toBe('pass');
    expect(session.recordVersion.value).toBe(1);
  });
});
