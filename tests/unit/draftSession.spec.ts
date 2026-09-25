import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetDraftSessionForTests, useDraftSession } from '../../src/lib/draftSession';

const STORAGE_KEY = 'braille-plate:draft:v1';

async function flush() {
  await nextTick();
  await nextTick();
}

describe('draftSession 单稿共享会话', () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetDraftSessionForTests();
  });

  afterEach(() => {
    window.localStorage.clear();
    __resetDraftSessionForTests();
  });

  it('首次创建为空原文、默认行宽 12', () => {
    const session = useDraftSession();
    expect(session.text.value).toBe('');
    expect(session.width.value).toBe('12');
  });

  it('输入变化持久化到当前版本记录，新会话按记录恢复', async () => {
    const session = useDraftSession();
    session.text.value = '12，三。';
    session.width.value = '4';
    await flush();

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(stored).toEqual({ version: 1, text: '12，三。', width: '4' });

    __resetDraftSessionForTests();
    const restored = useDraftSession();
    expect(restored.text.value).toBe('12，三。');
    expect(restored.width.value).toBe('4');
  });

  it('跨标签页 storage 事件只按完整、版本相符的记录同步', async () => {
    const session = useDraftSession();
    session.text.value = '一二三';
    session.width.value = '8';
    await flush();

    // 另一标签写入新草稿
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, text: '四五六', width: '12' }));
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    await flush();
    expect(session.text.value).toBe('四五六');
    expect(session.width.value).toBe('12');

    // 旧版 / 损坏记录不覆盖当前展示
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 9, text: '坏', width: '4' }));
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    await flush();
    expect(session.text.value).toBe('四五六');

    window.localStorage.setItem(STORAGE_KEY, '{坏 JSON');
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    await flush();
    expect(session.text.value).toBe('四五六');
    expect(session.width.value).toBe('12');
  });

  it('其他存储键的 storage 事件不影响单稿', async () => {
    const session = useDraftSession();
    session.text.value = '一二三';
    window.dispatchEvent(new StorageEvent('storage', { key: 'braille-plate:other' }));
    await flush();
    expect(session.text.value).toBe('一二三');
  });

  it('恢复时兼容落库为数值的行宽（number 输入框），统一为字符串', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, text: '一二三', width: 4 }));
    __resetDraftSessionForTests();
    const restored = useDraftSession();
    expect(restored.text.value).toBe('一二三');
    expect(restored.width.value).toBe('4');
  });
});
