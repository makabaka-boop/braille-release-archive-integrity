import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

// 与 src/lib/braille.ts 固定编码表一致：点号方 -> 可识读字符
const DOTS_TO_CHAR: Record<string, string> = {
  '1': '一',
  '12': '二',
  '14': '三',
  '145': '四',
  '15': '五',
  '124': '六',
  '1245': '七',
  '125': '八',
  '24': '九',
  '245': '零',
  '2': '，',
  '256': '。',
  '36': '-'
};

async function currentDots(page: Page): Promise<string> {
  const dots = await page.getByTestId('training-cell').locator('.cell').getAttribute('data-dots');
  expect(dots, '题卡必须渲染出点号方').toBeTruthy();
  return dots as string;
}

async function currentCorrectChar(page: Page): Promise<string> {
  const dots = await currentDots(page);
  const char = DOTS_TO_CHAR[dots];
  expect(char, `固定编码表中应存在点号 ${dots} 对应的字符`).toBeTruthy();
  return char;
}

function dotNote(dots: string): string {
  return `第 ${dots.split('').join('、')} 点凸起`;
}

/** 作答当前题：默认选正确字符；deliberatelyWrong 时改选任一错误选项。 */
async function answerCurrentQuestion(page: Page, deliberatelyWrong = false): Promise<string> {
  const correct = await currentCorrectChar(page);
  let target = correct;
  if (deliberatelyWrong) {
    const chars = await page
      .getByTestId('training-option')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-char')));
    const wrong = chars.find((char) => char !== null && char !== correct);
    expect(wrong, '四个选项中应存在错误选项').toBeTruthy();
    target = wrong as string;
  }
  await page.locator(`[data-testid="training-option"][data-char="${target}"]`).click();
  await page.getByTestId('training-submit').click();
  return correct;
}

test.describe('进入识读训练工作区', () => {
  test('工作区独立于既有三种模式，开局前无题卡', async ({ page }) => {
    // 默认仍是单稿预检
    await expect(page.getByTestId('phrase-input')).toBeVisible();
    await expect(page.getByTestId('training-start')).toHaveCount(0);

    await page.getByTestId('mode-training').click();
    await expect(page.getByTestId('training-start')).toBeVisible();
    await expect(page.getByTestId('training-start')).toBeEnabled();
    // 既有三个工作区的控件都不与识读训练同时出现
    await expect(page.getByTestId('phrase-input')).toHaveCount(0);
    await expect(page.getByTestId('base-input')).toHaveCount(0);
    await expect(page.getByTestId('point-grid')).toHaveCount(0);
    // 未开局：没有题卡、没有成绩、没有报错
    await expect(page.getByTestId('training-question')).toHaveCount(0);
    await expect(page.getByTestId('training-score')).toHaveCount(0);
    await expect(page.getByTestId('training-error')).toHaveCount(0);
  });
});

test.describe('识读训练主流程', () => {
  test('开始训练并连续作答十题至成绩页，汇总答对数与错题', async ({ page }) => {
    await page.getByTestId('mode-training').click();
    await page.getByTestId('training-start').click();

    // 开局后：题卡、进度、四个选项与提交按钮就绪
    await expect(page.getByTestId('training-question')).toBeVisible();
    await expect(page.getByTestId('training-progress')).toHaveText('第 1 / 10 题');
    await expect(page.getByTestId('training-option')).toHaveCount(4);
    await expect(page.getByTestId('training-submit')).toBeDisabled();

    const seenDots: string[] = [];
    const wrongAt = 4; // 第 4 题故意答错
    let wrongQuestionCorrect = '';

    for (let index = 1; index <= 10; index += 1) {
      await expect(page.getByTestId('training-progress')).toHaveText(`第 ${index} / 10 题`);
      const dots = await currentDots(page);
      seenDots.push(dots);

      const correct = await answerCurrentQuestion(page, index === wrongAt);
      const expectRight = index !== wrongAt;

      // 提交后立即显示正误、正确字符与点号说明
      const feedback = page.getByTestId('training-feedback');
      await expect(feedback).toBeVisible();
      await expect(feedback).toHaveAttribute('data-correct', expectRight ? 'true' : 'false');
      await expect(page.getByTestId('training-verdict')).toHaveText(expectRight ? '回答正确' : '回答错误');
      await expect(page.getByTestId('training-answer')).toContainText(`正确字符：${correct}`);
      await expect(page.getByTestId('training-dots')).toContainText(dotNote(dots));
      await expect(page.getByTestId('training-dots')).toContainText(`点号 ${dots}`);

      if (!expectRight) {
        wrongQuestionCorrect = correct;
      }

      await page.getByTestId('training-next').click();
    }

    // 十张题卡互不重复
    expect(new Set(seenDots).size).toBe(10);

    // 成绩页：答对 9 题，错题 1 题并指明正确字符
    const score = page.getByTestId('training-score');
    await expect(score).toBeVisible();
    await expect(page.getByTestId('training-score-summary')).toContainText('共 10 题');
    await expect(page.getByTestId('training-score-summary')).toContainText('答对 9 题');
    await expect(page.getByTestId('training-score-summary')).toContainText('答错 1 题');
    const wrongItems = page.getByTestId('training-wrong-item');
    await expect(wrongItems).toHaveCount(1);
    await expect(wrongItems.first()).toContainText(`第 ${wrongAt} 题`);
    await expect(wrongItems.first()).toContainText(`正确字符 ${wrongQuestionCorrect}`);
    await expect(page.getByTestId('training-question')).toHaveCount(0);

    // 局次结束后可以再次开局
    await expect(page.getByTestId('training-start')).toBeEnabled();
    await expect(page.getByTestId('training-start')).toHaveText('再练一局');
  });

  test('全部答对时成绩页给出满分且无错题列表', async ({ page }) => {
    await page.getByTestId('mode-training').click();
    await page.getByTestId('training-start').click();

    for (let index = 1; index <= 10; index += 1) {
      await answerCurrentQuestion(page);
      await page.getByTestId('training-next').click();
    }

    await expect(page.getByTestId('training-score-summary')).toContainText('答对 10 题');
    await expect(page.getByTestId('training-all-correct')).toBeVisible();
    await expect(page.getByTestId('training-wrong-item')).toHaveCount(0);
  });

  test('前九题答对、末题答错：成绩如实显示 9 对 1 错且错题区呈现末题', async ({ page }) => {
    await page.getByTestId('mode-training').click();
    await page.getByTestId('training-start').click();

    const seenDots: string[] = [];
    let lastCorrect = '';
    for (let index = 1; index <= 10; index += 1) {
      const correct = await answerCurrentQuestion(page, index === 10);
      seenDots.push(await currentDots(page));
      if (index === 10) {
        lastCorrect = correct;
      }
      await page.getByTestId('training-next').click();
    }

    // 十张题卡互不重复
    expect(new Set(seenDots).size).toBe(10);

    await expect(page.getByTestId('training-score')).toBeVisible();
    await expect(page.getByTestId('training-score-summary')).toContainText('共 10 题');
    await expect(page.getByTestId('training-score-summary')).toContainText('答对 9 题');
    await expect(page.getByTestId('training-score-summary')).toContainText('答错 1 题');
    const wrongItems = page.getByTestId('training-wrong-item');
    await expect(wrongItems).toHaveCount(1);
    await expect(wrongItems.first()).toContainText('第 10 题');
    await expect(wrongItems.first()).toContainText(`正确字符 ${lastCorrect}`);
  });
});

test.describe('作答与开局约束', () => {
  test('当前题只允许提交一次，重复提交被拦截', async ({ page }) => {
    await page.getByTestId('mode-training').click();
    await page.getByTestId('training-start').click();

    const correct = await currentCorrectChar(page);
    await page.locator(`[data-testid="training-option"][data-char="${correct}"]`).click();
    await page.getByTestId('training-submit').click();
    await expect(page.getByTestId('training-feedback')).toBeVisible();

    // 提交后：提交按钮与全部选项均被禁用，无法重复提交或改选
    await expect(page.getByTestId('training-submit')).toBeDisabled();
    const options = page.getByTestId('training-option');
    await expect(options).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      await expect(options.nth(index)).toBeDisabled();
    }

    // 反馈保持唯一且进度不前进
    await expect(page.getByTestId('training-feedback')).toHaveCount(1);
    await expect(page.getByTestId('training-progress')).toHaveText('第 1 / 10 题');
  });

  test('局次完成前阻止重复开局，离开工作区直接结束未完成局次', async ({ page }) => {
    await page.getByTestId('mode-training').click();
    await page.getByTestId('training-start').click();
    await expect(page.getByTestId('training-question')).toBeVisible();

    // 完成前：开始按钮被禁用并给出提示，不能重复开局
    await expect(page.getByTestId('training-start')).toBeDisabled();
    await expect(page.getByTestId('training-hint')).toBeVisible();

    // 选中选项但不提交，直接离开：返回时已选答案与题号都不得残留
    const correct = await currentCorrectChar(page);
    await page.locator(`[data-testid="training-option"][data-char="${correct}"]`).click();
    await expect(page.locator('[data-testid="training-option"].picked')).toHaveCount(1);
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('phrase-input')).toBeVisible();

    await page.getByTestId('mode-training').click();
    await expect(page.getByTestId('training-question')).toHaveCount(0);
    await expect(page.getByTestId('training-score')).toHaveCount(0);
    await expect(page.getByTestId('training-start')).toBeEnabled();

    // 重新开局：从第 1 题开始，且没有遗留的选中标记
    await page.getByTestId('training-start').click();
    await expect(page.getByTestId('training-progress')).toHaveText('第 1 / 10 题');
    await expect(page.locator('[data-testid="training-option"].picked')).toHaveCount(0);

    // 提交后停留在反馈阶段离开：再次返回仍是待开局状态
    await answerCurrentQuestion(page);
    await expect(page.getByTestId('training-feedback')).toBeVisible();
    await page.getByTestId('mode-single').click();
    await page.getByTestId('mode-training').click();
    await expect(page.getByTestId('training-question')).toHaveCount(0);
    await expect(page.getByTestId('training-feedback')).toHaveCount(0);
    await expect(page.getByTestId('training-start')).toBeEnabled();
  });

  test('训练局次不做本地保存', async ({ page }) => {
    await page.getByTestId('mode-training').click();
    await page.getByTestId('training-start').click();
    await answerCurrentQuestion(page);

    const storedKeys = await page.evaluate(() => Object.keys(window.localStorage));
    expect(storedKeys).toEqual([]);
  });
});

test.describe('与既有工作区隔离', () => {
  test('训练作答后切回单稿预检，原有输入与预览未受影响', async ({ page }) => {
    // 先在单稿预检生成预览
    await page.getByTestId('phrase-input').fill('12，三。');
    await page.getByTestId('width-input').fill('20');
    await expect(page.getByTestId('preview')).toBeVisible();
    await expect(page.getByTestId('total-cells')).toContainText('总方数：6 方');

    // 到识读训练完成两题作答
    await page.getByTestId('mode-training').click();
    await page.getByTestId('training-start').click();
    for (let index = 0; index < 2; index += 1) {
      await answerCurrentQuestion(page);
      await page.getByTestId('training-next').click();
    }
    await expect(page.getByTestId('training-progress')).toHaveText('第 3 / 10 题');

    // 切回单稿预检：输入保留、逐方预览与总方数完全保持原行为
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('phrase-input')).toHaveValue('12，三。');
    await expect(page.getByTestId('width-input')).toHaveValue('20');
    await expect(page.getByTestId('preview')).toBeVisible();
    await expect(page.getByTestId('total-cells')).toContainText('总方数：6 方');
    const cells = page.getByTestId('preview').locator('.cell');
    await expect(cells).toHaveCount(6);
    await expect(cells.first()).toHaveAttribute('data-dots', '3456');

    // 单稿错误阻断行为不变
    await page.getByTestId('phrase-input').fill('12楼');
    await expect(page.getByTestId('errors')).toBeVisible();
    await expect(page.getByTestId('preview')).toHaveCount(0);
  });
});
