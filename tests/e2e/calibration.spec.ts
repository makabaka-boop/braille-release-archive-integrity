import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const HEIGHT_INPUTS = Array.from({ length: 6 }, (_, i) => `height-input-${i + 1}`);

async function fillHeights(page: import('@playwright/test').Page, values: string[]) {
  for (const [index, value] of values.entries()) {
    await page.getByTestId(`height-input-${index + 1}`).fill(value);
  }
}

test.describe('进入试压校准工作区', () => {
  test('工作区独立于单稿预检与双稿核对', async ({ page }) => {
    // 默认仍是单稿预检
    await expect(page.getByTestId('phrase-input')).toBeVisible();
    await expect(page.getByTestId('point-grid')).toHaveCount(0);

    await page.getByTestId('mode-calibration').click();
    await expect(page.getByTestId('point-grid')).toBeVisible();
    await expect(page.getByTestId('height-input-1')).toBeVisible();
    await expect(page.getByTestId('height-input-6')).toBeVisible();
    // 既有两种工作模式的控件都不与校准工作区同时出现
    await expect(page.getByTestId('phrase-input')).toHaveCount(0);
    await expect(page.getByTestId('base-input')).toHaveCount(0);

    // 未执行判定前没有结果面板
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);
    await expect(page.getByTestId('calibration-blocked')).toHaveCount(0);
  });
});

test.describe('六点合格判定', () => {
  test('填写六点并执行判定，得到合格整机结论与逐点实测值', async ({ page }) => {
    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80']);
    await page.getByTestId('calibration-judge').click();

    const result = page.getByTestId('calibration-result');
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('data-verdict', 'pass');
    await expect(result).toContainText('试压校准：合格');
    await expect(page.getByTestId('calibration-conclusion')).toContainText('整机结论：合格');
    await expect(page.getByTestId('calibration-conclusion')).toContainText('极差 0.10 毫米');

    const values = result.getByTestId('point-value');
    await expect(values).toHaveCount(6);
    await expect(values).toHaveText(['0.70', '0.72', '0.74', '0.76', '0.78', '0.80']);
    for (let i = 1; i <= 6; i += 1) {
      await expect(result.getByTestId(`point-status-${i}`)).toHaveText('合格');
    }

    await expect(page.getByTestId('threshold-summary')).toContainText('最小');
    await expect(page.getByTestId('threshold-summary')).toContainText('0.70 毫米');
    await expect(page.getByTestId('threshold-summary')).toContainText('0.80 毫米');
  });

  test('边界值 0.60、0.75（极差恰好 0.15）合格', async ({ page }) => {
    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['0.60', '0.75', '0.75', '0.75', '0.75', '0.75']);
    await page.getByTestId('calibration-judge').click();

    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
    await expect(page.getByTestId('calibration-conclusion')).toContainText('极差 0.15 毫米');
  });
});

test.describe('草稿刷新恢复与结果保留', () => {
  test('未提交草稿刷新后自动恢复', async ({ page }) => {
    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['0.71', '0.73', '', '0.77', '0.79', '0.81']);

    await page.reload();

    // 刷新后默认回到单稿预检；重新进入试压校准工作区时草稿自动恢复（包括空缺项）
    await page.getByTestId('mode-calibration').click();
    await expect(page.getByTestId('height-input-1')).toHaveValue('0.71');
    await expect(page.getByTestId('height-input-2')).toHaveValue('0.73');
    await expect(page.getByTestId('height-input-3')).toHaveValue('');
    await expect(page.getByTestId('height-input-4')).toHaveValue('0.77');
    await expect(page.getByTestId('height-input-5')).toHaveValue('0.79');
    await expect(page.getByTestId('height-input-6')).toHaveValue('0.81');
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);
  });

  test('成功判定后刷新保留本次结果，继续修改后结果失效', async ({ page }) => {
    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80']);
    await page.getByTestId('calibration-judge').click();
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');

    await page.reload();

    await page.getByTestId('mode-calibration').click();
    await expect(page.getByTestId('calibration-result')).toBeVisible();
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
    await expect(page.getByTestId('height-input-1')).toHaveValue('0.70');

    // 改动任一读数，上次成功判定立即失效，回到未提交草稿
    await page.getByTestId('height-input-3').fill('0.65');
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);

    await page.reload();
    await page.getByTestId('mode-calibration').click();
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);
    await expect(page.getByTestId('height-input-3')).toHaveValue('0.65');
  });
});

test.describe('需调机与无效读数', () => {
  test('单点超上限得到需调机而非输入错误，并列出越界原因', async ({ page }) => {
    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['0.70', '0.71', '0.72', '0.73', '0.74', '0.91']);
    await page.getByTestId('calibration-judge').click();

    const result = page.getByTestId('calibration-result');
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('data-verdict', 'adjust');
    await expect(result).toContainText('试压校准：需调机');
    await expect(page.getByTestId('calibration-conclusion')).toContainText('整机结论：需调机');
    // 第 6 点标出越界原因，其余点仍为合格
    await expect(page.getByTestId('point-status-6')).toContainText('高于合格上限 0.90 毫米');
    for (let i = 1; i <= 5; i += 1) {
      await expect(page.getByTestId(`point-status-${i}`)).toHaveText('合格');
    }
    // 阈值不合格不是输入受阻
    await expect(page.getByTestId('calibration-blocked')).toHaveCount(0);
    for (const testId of HEIGHT_INPUTS) {
      await expect(page.getByTestId(testId)).toHaveAttribute('aria-invalid', 'false');
    }
  });

  test('离散度超限时即便各点在范围内也需调机', async ({ page }) => {
    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['0.62', '0.68', '0.70', '0.72', '0.74', '0.78']);
    await page.getByTestId('calibration-judge').click();

    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'adjust');
    await expect(page.getByTestId('calibration-conclusion')).toContainText('极差 0.16 毫米');
  });

  test('空值、非数字、超过两位小数与非正数在对应点位就地提示并停止判定', async ({ page }) => {
    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['', 'abc', '0.712', '0', '0.74', '0.75']);
    await page.getByTestId('calibration-judge').click();

    await expect(page.getByTestId('calibration-blocked')).toBeVisible();
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);

    await expect(page.getByTestId('height-error-1')).toContainText('缺项');
    await expect(page.getByTestId('height-error-2')).toContainText('无法识别');
    await expect(page.getByTestId('height-error-3')).toContainText('两位小数');
    await expect(page.getByTestId('height-error-4')).toContainText('必须为正数');
    await expect(page.getByTestId('height-error-5')).toHaveCount(0);
    await expect(page.getByTestId('height-error-6')).toHaveCount(0);

    await expect(page.getByTestId('height-input-1')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('height-input-5')).toHaveAttribute('aria-invalid', 'false');

    // 修正全部读数后可正常得到合格结论
    await page.getByTestId('height-input-1').fill('0.70');
    await page.getByTestId('height-input-2').fill('0.72');
    await page.getByTestId('height-input-3').fill('0.73');
    await page.getByTestId('height-input-4').fill('0.74');
    await page.getByTestId('calibration-judge').click();
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
    await expect(page.getByTestId('calibration-blocked')).toHaveCount(0);
  });
});

test.describe('异常存档恢复与写入安全', () => {
  const STORAGE_KEY = 'braille-plate:calibration:v1';
  const legalDraft = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];
  const otherJudged = ['0.60', '0.62', '0.64', '0.66', '0.68', '0.70'];

  async function seedArchive(page: import('@playwright/test').Page, archive: unknown) {
    await page.evaluate(
      ([key, value]) => {
        window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      },
      [STORAGE_KEY, archive] as [string, unknown]
    );
    await page.reload();
    await page.getByTestId('mode-calibration').click();
  }

  async function expectInputs(page: import('@playwright/test').Page, values: string[]) {
    for (const [index, value] of values.entries()) {
      await expect(page.getByTestId(`height-input-${index + 1}`)).toHaveValue(value);
    }
  }

  async function rawArchive(page: import('@playwright/test').Page) {
    return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
  }

  test('不一致快照显示草稿但不恢复结论，修改和刷新均不覆盖原文', async ({ page }) => {
    const archive = { version: 2, draft: { readings: legalDraft }, judgedRaws: otherJudged };
    await seedArchive(page, archive);
    const original = JSON.stringify(archive);

    await expectInputs(page, legalDraft);
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);
    await expect(page.getByTestId('calibration-blocked')).toHaveCount(0);
    await expect(page.getByTestId('calibration-archive-warning')).toContainText('不一致');

    await page.getByTestId('height-input-1').fill('0.65');
    await expect(page.getByTestId('calibration-storage-error')).toContainText('不会写入或覆盖原存档');
    expect(await rawArchive(page)).toBe(original);

    await page.reload();
    await page.getByTestId('mode-calibration').click();
    await expectInputs(page, legalDraft);
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);
    expect(await rawArchive(page)).toBe(original);
  });

  test('少于六项不补空形成结论，超过六项不截断改变点号', async ({ page }) => {
    const shortArchive = { version: 2, draft: ['0.70', '0.72', '0.74', '0.76', '0.78'], judgedRaws: null };
    await seedArchive(page, shortArchive);
    const shortOriginal = JSON.stringify(shortArchive);

    await expectInputs(page, ['0.70', '0.72', '0.74', '0.76', '0.78', '']);
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);
    await expect(page.getByTestId('calibration-archive-warning')).toContainText('少于六点');

    await page.getByTestId('height-input-6').fill('0.81');
    await page.reload();
    await page.getByTestId('mode-calibration').click();
    await expectInputs(page, ['0.70', '0.72', '0.74', '0.76', '0.78', '']);
    expect(await rawArchive(page)).toBe(shortOriginal);

    const longArchive = {
      version: 2,
      draft: ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80', '0.99'],
      judgedRaws: null
    };
    await seedArchive(page, longArchive);
    await expectInputs(page, legalDraft);
    await expect(page.getByTestId('calibration-archive-warning')).toContainText('多于六点');
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);

    await page.getByTestId('height-input-6').fill('0.65');
    await page.reload();
    await page.getByTestId('mode-calibration').click();
    await expectInputs(page, legalDraft);
    expect(await rawArchive(page)).toBe(JSON.stringify(longArchive));
  });

  test('合法旧版六点快照保持兼容，未知版本不显示有效结论', async ({ page }) => {
    const legacy = { draft: { readings: legalDraft }, judgedRaws: legalDraft };
    await seedArchive(page, legacy);
    await expectInputs(page, legalDraft);
    await expect(page.getByTestId('calibration-result')).toBeVisible();
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
    await expect(page.getByTestId('calibration-archive-warning')).toHaveCount(0);

    const unknown = { version: 3, draft: { readings: legalDraft }, judgedRaws: legalDraft };
    await seedArchive(page, unknown);
    await expectInputs(page, legalDraft);
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);
    await expect(page.getByTestId('calibration-archive-warning')).toContainText('版本无法识别');
    expect(await rawArchive(page)).toBe(JSON.stringify(unknown));
  });

  test('损坏 JSON 明确告警并显示空六点，一次输入不会覆盖取证记录', async ({ page }) => {
    const brokenJson = '{不是合法 JSON';
    await seedArchive(page, brokenJson);

    await expectInputs(page, ['', '', '', '', '', '']);
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);
    await expect(page.getByTestId('calibration-archive-warning')).toContainText('字段缺失或类型已损坏');

    await page.getByTestId('height-input-1').fill('0.70');
    await expect(page.getByTestId('calibration-storage-error')).toContainText('不会写入或覆盖原存档');
    expect(await rawArchive(page)).toBe(brokenJson);
  });

  test('保存判定时写入失败会告警，刷新后仍保留原存档', async ({ page }) => {
    const archive = { version: 2, draft: { readings: ['', '', '', '', '', ''] }, judgedRaws: null };
    await seedArchive(page, archive);
    const original = JSON.stringify(archive);

    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      };
    });

    await fillHeights(page, legalDraft);
    await page.getByTestId('calibration-judge').click();

    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
    await expect(page.getByTestId('calibration-storage-error')).toContainText('原始存档仍保留');
    expect(await rawArchive(page)).toBe(original);

    await page.reload();
    await page.getByTestId('mode-calibration').click();
    await expectInputs(page, ['', '', '', '', '', '']);
    await expect(page.getByTestId('calibration-result')).toHaveCount(0);
    await expect(page.getByTestId('calibration-storage-error')).toHaveCount(0);
    expect(await rawArchive(page)).toBe(original);
  });
});

test.describe('与既有模式隔离', () => {
  test('校准需调机不影响单稿预检预览', async ({ page }) => {
    // 先在试压校准得到“需调机”
    await page.getByTestId('mode-calibration').click();
    await fillHeights(page, ['0.70', '0.71', '0.72', '0.73', '0.74', '0.91']);
    await page.getByTestId('calibration-judge').click();
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'adjust');

    // 回到单稿预检：排版预览、总方数与错误阻断完全保持原行为
    await page.getByTestId('mode-single').click();
    await expect(page.getByTestId('phrase-input')).toBeVisible();
    await page.getByTestId('phrase-input').fill('12，三。');
    await page.getByTestId('width-input').fill('4');
    await expect(page.getByTestId('preview')).toBeVisible();
    await expect(page.getByTestId('total-cells')).toContainText('总方数：6 方');
    const lines = page.getByTestId('plate-line');
    await expect(lines).toHaveCount(2);

    // 再回到校准工作区，本次需调机结果仍在
    await page.getByTestId('mode-calibration').click();
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'adjust');

    // 双稿核对同样未受影响
    await page.getByTestId('mode-compare').click();
    await page.getByTestId('base-input').fill('12，三。');
    await page.getByTestId('target-input').fill('12，三。');
    await page.getByTestId('compare-button').click();
    await expect(page.getByTestId('compare-identical')).toBeVisible();
  });
});
