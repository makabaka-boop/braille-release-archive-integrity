import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('双稿核对主流程', () => {
  test('切换模式、粘贴两稿、发起核对并逐项查看差异', async ({ page }) => {
    // 默认进入单稿预检模式
    await expect(page.getByTestId('phrase-input')).toBeVisible();
    await expect(page.getByTestId('base-input')).toHaveCount(0);

    await page.getByTestId('mode-compare').click();
    await expect(page.getByTestId('base-input')).toBeVisible();
    await expect(page.getByTestId('target-input')).toBeVisible();
    await expect(page.getByTestId('phrase-input')).toHaveCount(0);

    // 制版稿的数字段被空格拆开：多出一方空方与一方数字符
    await page.getByTestId('base-input').fill('12，三。');
    await page.getByTestId('target-input').fill('1 2，三。');
    await page.getByTestId('compare-button').click();

    const diff = page.getByTestId('compare-diff');
    await expect(diff).toBeVisible();
    await expect(page.getByTestId('compare-identical')).toHaveCount(0);

    // 首个差异被明确标出：第 3 项，制版稿第 2 字（空格）插入的空方
    await expect(page.getByTestId('diff-summary')).toContainText('首个差异位于第 3 项');
    await expect(page.getByTestId('diff-summary')).toContainText('插入 2 方');
    const firstDiff = diff.locator('.diff-entry.is-first-diff');
    await expect(firstDiff).toHaveCount(1);
    await expect(firstDiff).toHaveAttribute('data-op', 'insert');
    await expect(firstDiff).toContainText('首个差异');
    await expect(firstDiff).toContainText('制版稿第 2 字');
    await expect(firstDiff.locator('.cell')).toHaveClass(/is-empty/);
    await expect(firstDiff.locator('.dots-label')).toHaveText('空方');

    // 拆段后重新插入的数字符同样可辨认
    const insertedSign = diff.locator('.diff-entry[data-op="insert"]', { hasText: '制版稿第 3 字' });
    await expect(insertedSign.locator('.cell')).toHaveAttribute('data-dots', '3456');
    await expect(insertedSign.locator('.cell')).toHaveAttribute('data-number-sign', 'true');

    // 逐项对应关系完整：审核稿 6 方 + 2 方插入 = 8 行
    await expect(page.getByTestId('diff-entry')).toHaveCount(8);
  });

  test('两稿完全一致时给出明确结论', async ({ page }) => {
    await page.getByTestId('mode-compare').click();
    await page.getByTestId('base-input').fill('12，三。');
    await page.getByTestId('target-input').fill('12，三。');
    await page.getByTestId('compare-button').click();

    const identical = page.getByTestId('compare-identical');
    await expect(identical).toBeVisible();
    await expect(identical).toContainText('完全一致');
    await expect(identical).toContainText('共 6 方');
    await expect(page.getByTestId('compare-diff')).toHaveCount(0);
  });

  test('单字符删除在差异表中标出来源位置', async ({ page }) => {
    await page.getByTestId('mode-compare').click();
    await page.getByTestId('base-input').fill('一二三');
    await page.getByTestId('target-input').fill('一三');
    await page.getByTestId('compare-button').click();

    const deleted = page.getByTestId('compare-diff').locator('.diff-entry[data-op="delete"]');
    await expect(deleted).toHaveCount(1);
    await expect(deleted).toContainText('审核稿第 2 字');
    await expect(deleted.locator('.cell')).toHaveAttribute('data-dots', '12');
    await expect(page.getByTestId('diff-summary')).toContainText('删除 1 方');
  });
});

test.describe('双稿核对输入受阻', () => {
  test('非法稿件只在对应输入旁反馈，不产生差异表', async ({ page }) => {
    await page.getByTestId('mode-compare').click();
    await page.getByTestId('base-input').fill('12楼');
    await page.getByTestId('target-input').fill('12');
    await page.getByTestId('compare-button').click();

    // 仅审核稿一侧报错并给出字符位置
    await expect(page.getByTestId('base-errors')).toBeVisible();
    await expect(page.getByTestId('base-errors')).toContainText('楼');
    await expect(page.getByTestId('base-errors')).toContainText('第 3 个字符');
    await expect(page.getByTestId('target-errors')).toHaveCount(0);

    // 停止比对：没有差异表，也没有一致结论
    await expect(page.getByTestId('compare-diff')).toHaveCount(0);
    await expect(page.getByTestId('compare-identical')).toHaveCount(0);
  });

  test('空稿件同样只反馈对应输入并停止比对', async ({ page }) => {
    await page.getByTestId('mode-compare').click();
    await page.getByTestId('base-input').fill('一二三');
    // 制版稿留空
    await page.getByTestId('compare-button').click();

    await expect(page.getByTestId('target-errors')).toBeVisible();
    await expect(page.getByTestId('target-errors')).toContainText('空文本');
    await expect(page.getByTestId('base-errors')).toHaveCount(0);
    await expect(page.getByTestId('compare-diff')).toHaveCount(0);
  });
});

test.describe('模式往返', () => {
  test('核对后返回单稿模式，既有预览仍正常', async ({ page }) => {
    // 先在单稿模式生成预览
    await page.getByTestId('phrase-input').fill('12，三。');
    await page.getByTestId('width-input').fill('4');
    await expect(page.getByTestId('preview')).toBeVisible();

    // 切到双稿核对并完成一次核对
    await page.getByTestId('mode-compare').click();
    await page.getByTestId('base-input').fill('一');
    await page.getByTestId('target-input').fill('二');
    await page.getByTestId('compare-button').click();
    await expect(page.getByTestId('compare-diff')).toBeVisible();

    // 返回单稿模式：输入保留、行宽排版与总方数照常
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('preview')).toBeVisible();
    await expect(page.getByTestId('total-cells')).toContainText('总方数：6 方');
    await expect(page.getByTestId('total-cells')).toContainText('共 2 行');
    const lines = page.getByTestId('plate-line');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0).locator('.cell')).toHaveCount(4);
    await expect(lines.nth(1).locator('.cell')).toHaveCount(2);

    // 单稿错误阻断行为不变
    await page.getByTestId('phrase-input').fill('12楼');
    await expect(page.getByTestId('errors')).toBeVisible();
    await expect(page.getByTestId('preview')).toHaveCount(0);
  });
});
