import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import TrainingWorkspace from '../../src/components/TrainingWorkspace.vue';

// 用一个宿主组件模拟 App.vue 的模式切换：trainingActive 为 true 时挂载工作区，
// 为 false 时 v-if 卸载（即从“识读训练”切到其他模式）。
const Host = defineComponent({
  props: {
    trainingActive: { type: Boolean, required: true }
  },
  setup(props) {
    return () => (props.trainingActive ? h(TrainingWorkspace) : h('div', { 'data-testid': 'other-mode' }));
  }
});

function mountHost(initial = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const active = ref(initial);
  const app = createApp(defineComponent({
    setup: () => () => h(Host, { trainingActive: active.value })
  }));
  app.mount(container);
  return {
    container,
    setActive(value: boolean) {
      active.value = value;
    },
    unmount() {
      app.unmount();
      container.remove();
    }
  };
}

function clickButton(testid: string) {
  const button = document.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null;
  expect(button).toBeTruthy();
  button!.click();
  return nextTick();
}

describe('识读训练工作区：离开后未完成局次不得残留', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('作答中切换离开再返回：旧题号与已选答案清空、开始按钮恢复可用', async () => {
    const host = mountHost(true);

    await clickButton('training-start');
    expect(document.querySelector('[data-testid="training-progress"]')?.textContent).toContain('第 1 / 10 题');

    // 选中一个选项但不提交
    const firstOption = document.querySelector('[data-testid="training-option"]') as HTMLButtonElement;
    firstOption.click();
    await nextTick();
    expect(firstOption.classList.contains('picked')).toBe(true);

    // 切换到其他模式（组件卸载），再切回（重新挂载）
    host.setActive(false);
    await nextTick();
    host.setActive(true);
    await nextTick();

    // 旧局次不得残留
    expect(document.querySelector('[data-testid="training-question"]')).toBeNull();
    expect(document.querySelector('[data-testid="training-score"]')).toBeNull();
    const startButton = document.querySelector('[data-testid="training-start"]') as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);

    // 可以立即重新开始一局
    await clickButton('training-start');
    expect(document.querySelector('[data-testid="training-question"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="training-progress"]')?.textContent).toContain('第 1 / 10 题');
    const options = document.querySelectorAll('[data-testid="training-option"]');
    expect(options).toHaveLength(4);
    expect(document.querySelector('[data-testid="training-option"].picked')).toBeNull();

    host.unmount();
  });

  it('提交后停留在反馈阶段切换离开再返回：反馈不残留且可重新开局', async () => {
    const host = mountHost(true);

    await clickButton('training-start');
    const firstOption = document.querySelector('[data-testid="training-option"]') as HTMLButtonElement;
    firstOption.click();
    await nextTick();
    await clickButton('training-submit');
    expect(document.querySelector('[data-testid="training-feedback"]')).toBeTruthy();

    host.setActive(false);
    await nextTick();
    host.setActive(true);
    await nextTick();

    expect(document.querySelector('[data-testid="training-question"]')).toBeNull();
    expect(document.querySelector('[data-testid="training-feedback"]')).toBeNull();
    const startButton = document.querySelector('[data-testid="training-start"]') as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);

    host.unmount();
  });
});
