import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('错误字符阻止全部输出', () => {
  test('允许字符可以预览，非法字符出现即阻止全部输出', async ({ page }) => {
    const input = page.getByTestId('phrase-input');

    await input.fill('12，三。');
    await expect(page.getByTestId('preview')).toBeVisible();
    await expect(page.getByTestId('errors')).toHaveCount(0);

    await input.fill('12楼');
    await expect(page.getByTestId('errors')).toBeVisible();
    await expect(page.getByTestId('preview')).toHaveCount(0);
    await expect(page.getByTestId('errors')).toContainText('楼');
  });

  test('半角逗号、英文字母、换行均为非法字符', async ({ page }) => {
    const input = page.getByTestId('phrase-input');

    await input.fill('1,2');
    await expect(page.getByTestId('errors')).toContainText('不在允许范围内');
    await expect(page.getByTestId('preview')).toHaveCount(0);

    await input.fill('AB');
    await expect(page.getByTestId('errors')).toBeVisible();

    await input.fill('一\n二');
    await expect(page.getByTestId('errors')).toBeVisible();
  });
});

test.describe('空文本与非法行宽', () => {
  test('空文本阻止全部输出', async ({ page }) => {
    await page.getByTestId('phrase-input').fill('');
    await expect(page.getByTestId('errors')).toBeVisible();
    await expect(page.getByTestId('errors')).toContainText('空文本');
    await expect(page.getByTestId('preview')).toHaveCount(0);
  });

  test('行宽超出 4-20 范围时阻止全部输出', async ({ page }) => {
    await page.getByTestId('phrase-input').fill('一二三');

    const width = page.getByTestId('width-input');
    await width.fill('3');
    await expect(page.getByTestId('errors')).toContainText('非法行宽');
    await expect(page.getByTestId('preview')).toHaveCount(0);

    await width.fill('21');
    await expect(page.getByTestId('errors')).toContainText('非法行宽');

    await width.fill('12.5');
    await expect(page.getByTestId('errors')).toContainText('非法行宽');

    await width.fill('12');
    await expect(page.getByTestId('preview')).toBeVisible();
  });
});

test.describe('制版点位逐方核对', () => {
  test('数字符、数字点位、标点点位与逐方标签正确', async ({ page }) => {
    // 12，三。 -> 3456 | 1 | 12 | 2(，) | 14(三) | 256(。)
    await page.getByTestId('phrase-input').fill('12，三。');
    await page.getByTestId('width-input').fill('20');

    const preview = page.getByTestId('preview');
    await expect(preview).toBeVisible();
    await expect(page.getByTestId('total-cells')).toContainText('总方数：6 方');

    const cells = preview.locator('.cell');
    await expect(cells).toHaveCount(6);
    const expectedDots = ['3456', '1', '12', '2', '14', '256'];
    for (const [index, dots] of expectedDots.entries()) {
      await expect(cells.nth(index)).toHaveAttribute('data-dots', dots);
    }
    await expect(cells.first()).toHaveAttribute('data-number-sign', 'true');
    await expect(cells.nth(1)).toHaveAttribute('data-number-sign', 'false');
  });

  test('六点网格中实际凸起点位与点号一致', async ({ page }) => {
    // 数字符 3456：点 3、4、5、6 凸起，点 1、2 不凸起
    await page.getByTestId('phrase-input').fill('0');
    const firstCell = page.getByTestId('preview').locator('.cell').first();
    await expect(firstCell).toHaveAttribute('data-dots', '3456');

    for (const dot of [3, 4, 5, 6]) {
      await expect(firstCell.locator(`.dot[data-dot="${dot}"]`)).toHaveClass(/raised/);
    }
    for (const dot of [1, 2]) {
      await expect(firstCell.locator(`.dot[data-dot="${dot}"]`)).not.toHaveClass(/raised/);
    }

    // 半角 0 沿用“零”的编码 245
    const zeroCell = page.getByTestId('preview').locator('.cell').nth(1);
    await expect(zeroCell).toHaveAttribute('data-dots', '245');
  });

  test('连续数字被非数字字符断开后重新插入数字符', async ({ page }) => {
    // 1 2（空格断开）-> 3456 1 空方 3456 12，共 5 方
    await page.getByTestId('phrase-input').fill('1 2');
    await page.getByTestId('width-input').fill('20');

    const cells = page.getByTestId('preview').locator('.cell');
    await expect(cells).toHaveCount(5);
    const expectedDots = ['3456', '1', '', '3456', '12'];
    for (const [index, dots] of expectedDots.entries()) {
      await expect(cells.nth(index)).toHaveAttribute('data-dots', dots);
    }
    await expect(cells.nth(2)).toHaveClass(/is-empty/);
  });

  test('达到行宽换行、不补齐末行', async ({ page }) => {
    // 6 方、每行 4 方：第一行 4 方，第二行 2 方（不补 2 个空方）
    await page.getByTestId('phrase-input').fill('12，三。');
    await page.getByTestId('width-input').fill('4');

    const lines = page.getByTestId('plate-line');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0).locator('.cell')).toHaveCount(4);
    await expect(lines.nth(1).locator('.cell')).toHaveCount(2);
    await expect(page.getByTestId('total-cells')).toContainText('共 2 行');
  });
});

test.describe('单稿排版与输入状态', () => {
  test('行宽 20 且内容足量时，一个逻辑行在预览中保持单排', async ({ page }) => {
    // 23 个中文数字 -> 23 方：第 1 行 20 方，第 2 行 3 方
    await page.getByTestId('phrase-input').fill('一二三四五六七八九零一二三四五六七八九零一二三');
    await page.getByTestId('width-input').fill('20');

    const lines = page.getByTestId('plate-line');
    await expect(lines).toHaveCount(2);

    const firstLineCells = lines.first().locator('.cell');
    await expect(firstLineCells).toHaveCount(20);

    // 同一逻辑行的所有方必须排在同一视觉排（顶端对齐一致，不发生折行）
    const tops = await firstLineCells.evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().top))
    );
    expect(new Set(tops).size).toBe(1);
  });

  test('快速行宽按钮以 aria-pressed 暴露当前选中项', async ({ page }) => {
    const group = page.getByRole('group', { name: '快速选择每行方数' });
    const choice = (label: string) => group.getByRole('button', { name: label });

    // 默认行宽 12：仅对应按钮处于按下状态
    await expect(choice('每行 12 方')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('每行 20 方')).toHaveAttribute('aria-pressed', 'false');

    await choice('每行 20 方').click();
    await expect(page.getByTestId('width-input')).toHaveValue('20');
    await expect(choice('每行 20 方')).toHaveAttribute('aria-pressed', 'true');
    await expect(choice('每行 12 方')).toHaveAttribute('aria-pressed', 'false');
  });

  test('非法字符阻止预览时，短句输入框获得错误状态并关联警告', async ({ page }) => {
    const input = page.getByTestId('phrase-input');

    await input.fill('12，三。');
    await expect(input).toHaveAttribute('aria-invalid', 'false');
    await expect(input).not.toHaveAttribute('aria-describedby', /.+/);

    await input.fill('12楼');
    await expect(page.getByTestId('errors')).toBeVisible();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAttribute('aria-describedby', 'single-errors');
    await expect(page.locator('#single-errors')).toContainText('楼');
  });

  test('非法行宽阻止预览时，行宽输入框获得错误状态并关联警告', async ({ page }) => {
    await page.getByTestId('phrase-input').fill('一二三');
    const width = page.getByTestId('width-input');

    await width.fill('3');
    await expect(width).toHaveAttribute('aria-invalid', 'true');
    await expect(width).toHaveAttribute('aria-describedby', 'single-errors');
    // 短句本身合法，短句输入框不应被标错
    await expect(page.getByTestId('phrase-input')).toHaveAttribute('aria-invalid', 'false');

    await width.fill('12');
    await expect(width).toHaveAttribute('aria-invalid', 'false');
  });
});

test.describe('纯浏览器约束', () => {
  test('不请求任何在线转换接口', async ({ page }) => {
    const externalRequests: string[] = [];
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('http') && !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
        externalRequests.push(url);
      }
      return route.continue();
    });

    await page.getByTestId('phrase-input').fill('12，三。- 四');
    await page.getByTestId('width-input').fill('8');
    await expect(page.getByTestId('preview')).toBeVisible();

    expect(externalRequests).toEqual([]);
  });
});
