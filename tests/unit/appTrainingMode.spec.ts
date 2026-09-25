import { createApp } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../../src/App.vue';

/**
 * 直接挂载真实 App，按模式按钮在“识读训练 ↔ 单稿预检”间切换，
 * 验证离开训练工作区（组件卸载）即结束未完成局次，返回时不残留旧局状态。
 */
function mountApp() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const app = createApp(App);
  app.mount(container);
  return {
    container,
    unmount() {
      app.unmount();
      container.remove();
    }
  };
}

function $(selector: string): HTMLElement | null {
  return document.querySelector(selector);
}

async function click(testid: string) {
  ($(`[data-testid="${testid}"]`) as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
}

describe('App 模式切换：训练未完成局次隔离', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('作答一题并选中选项后切到单稿预检再返回：回到待开局状态', async () => {
    const app = mountApp();

    await click('mode-training');
    expect($('[data-testid="training-start"]')).toBeTruthy();

    await click('training-start');
    expect($('[data-testid="training-progress"]')?.textContent).toContain('第 1 / 10 题');

    // 选中一个选项
    ($('[data-testid="training-option"]') as HTMLButtonElement).click();
    await Promise.resolve();

    // 切到单稿预检
    await click('mode-single');
    expect($('[data-testid="phrase-input"]')).toBeTruthy();
    expect($('[data-testid="training-start"]')).toBeNull();

    // 再切回训练：旧局次必须已结束
    await click('mode-training');
    expect($('[data-testid="training-question"]')).toBeNull();
    expect($('[data-testid="training-score"]')).toBeNull();
    const startButton = $('[data-testid="training-start"]') as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);

    // 能立即重新开局
    await click('training-start');
    expect($('[data-testid="training-progress"]')?.textContent).toContain('第 1 / 10 题');
    expect($('[data-testid="training-option"].picked')).toBeNull();

    app.unmount();
  });

  it('提交后停留在反馈阶段切换离开再返回：反馈与原题号均不残留', async () => {
    const app = mountApp();

    await click('mode-training');
    await click('training-start');
    ($('[data-testid="training-option"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await click('training-submit');
    expect($('[data-testid="training-feedback"]')).toBeTruthy();

    await click('mode-single');
    await click('mode-training');

    expect($('[data-testid="training-feedback"]')).toBeNull();
    expect($('[data-testid="training-question"]')).toBeNull();
    const startButton = $('[data-testid="training-start"]') as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);

    app.unmount();
  });
});
