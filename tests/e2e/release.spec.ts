import { expect, test } from '@playwright/test';

const DRAFT_KEY = 'braille-plate:draft:v1';
const CALIBRATION_KEY = 'braille-plate:calibration:v1';
const RELEASE_KEY = 'braille-plate:release:v1';
const legalReadings = ['0.70', '0.72', '0.74', '0.76', '0.78', '0.80'];

async function fillDraft(page: import('@playwright/test').Page, text: string, width: string) {
  await page.getByTestId('mode-single').click();
  await page.getByTestId('phrase-input').fill(text);
  await page.getByTestId('width-input').fill(width);
}

async function judgeCalibration(page: import('@playwright/test').Page, values: string[]) {
  await page.getByTestId('mode-calibration').click();
  for (const [index, value] of values.entries()) {
    await page.getByTestId(`height-input-${index + 1}`).fill(value);
  }
  await page.getByTestId('calibration-judge').click();
}

async function judgePass(page: import('@playwright/test').Page, values = legalReadings) {
  await judgeCalibration(page, values);
  await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
}

test.describe('压点放行：合格签发', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('预检合法且六点合格才能签发，放行单展示独立标识与完整来源快照', async ({ page }) => {
    await fillDraft(page, '12，三。', '4');
    // 未校准时放行按钮禁用
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('gate-calibration-blockers')).toContainText('尚未完成六点试压判定');

    await judgePass(page);
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('gate-draft-ok')).toBeVisible();
    await expect(page.getByTestId('gate-calibration-pass')).toContainText('合格');
    await expect(page.getByTestId('release-issue')).toBeEnabled();

    await page.getByTestId('release-issue').click();

    const active = page.getByTestId('release-active');
    await expect(active).toBeVisible();
    const idText = await active.getByTestId('slip-id').textContent();
    expect(idText).toMatch(/放行单号：PF-\d{8}-\d{6}-[0-9a-f]{8}/);
    const slipId = (idText ?? '').replace('放行单号：', '');

    // 来源快照：原文 / 行宽 / 总方数 / 逐方排版（2 行：4 方 + 2 方）
    await expect(active.getByTestId('slip-draft-text')).toContainText('12，三。');
    await expect(active.getByTestId('slip-draft-width')).toContainText('每行方数：4');
    await expect(active.getByTestId('slip-draft-width')).toContainText('总方数：6');
    await expect(active.locator('[data-testid="slip-line"]')).toHaveCount(2);
    const dots = active.locator('.cell');
    await expect(dots).toHaveCount(6);
    await expect(dots.first()).toHaveAttribute('data-dots', '3456');

    // 来源快照：六点合格判定与逐点读数
    await expect(active.locator('[data-testid="slip-point-row"]')).toHaveCount(6);
    await expect(active.getByTestId('slip-threshold')).toContainText('极差 0.10 毫米');
    await expect(active.getByTestId('slip-conclusion')).toContainText('整机结论：合格');
    const raws = active.locator('[data-testid="slip-point-raw"]');
    await expect(raws).toHaveText(legalReadings);

    // 历史区出现同一张只读单据
    const historyItem = page.getByTestId('release-history-item').first();
    await expect(historyItem).toHaveAttribute('data-slip-id', slipId);
  });

  test('需调机、受阻读数、非法文字各自阻断放行', async ({ page }) => {
    // 需调机
    await fillDraft(page, '一二三', '4');
    await judgeCalibration(page, ['0.70', '0.71', '0.72', '0.73', '0.74', '0.91']);
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'adjust');
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('gate-calibration-blockers')).toContainText('需调机');

    // 修正为合格后仍因单稿非法而阻断
    await judgeCalibration(page, legalReadings);
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
    await page.getByTestId('mode-single').click();
    await page.getByTestId('phrase-input').fill('12楼');
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('gate-draft-blockers')).toContainText('不在允许范围内');

    // 受阻读数
    await page.getByTestId('mode-calibration').click();
    await page.getByTestId('height-input-1').fill('');
    await page.getByTestId('calibration-judge').click();
    await expect(page.getByTestId('calibration-blocked')).toBeVisible();
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('gate-calibration-blockers')).toContainText('无效读数');
  });
});

test.describe('压点放行：改动立即失效，历史只读保留', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  async function issueOne(page: import('@playwright/test').Page) {
    await fillDraft(page, '12，三。', '4');
    await judgePass(page);
    await page.getByTestId('mode-release').click();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
  }

  test('签发后修改文字：当前授权失效，历史单据仍是原快照且可只读复核', async ({ page }) => {
    await issueOne(page);
    const firstHistoryId = await page
      .getByTestId('release-history-item')
      .first()
      .getAttribute('data-slip-id');

    await page.getByTestId('mode-single').click();
    await page.getByTestId('phrase-input').fill('12，四。');
    await page.getByTestId('mode-release').click();

    await expect(page.getByTestId('release-active')).toHaveCount(0);
    await expect(page.getByTestId('release-invalidated')).toBeVisible();
    await expect(page.getByTestId('release-invalidated')).toContainText('当前可放行状态已失效');

    // 历史单据未被草稿覆盖：仍显示原文“三”
    const historyCard = page.getByTestId('release-history-item').first();
    await expect(historyCard.getByTestId('slip-draft-text')).toContainText('12，三。');
    await expect(historyCard).toHaveCount(1);

    // 改回原文也不会自动恢复授权
    await page.getByTestId('mode-single').click();
    await page.getByTestId('phrase-input').fill('12，三。');
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-active')).toHaveCount(0);
    await expect(page.getByTestId('release-invalidated')).toBeVisible();

    // 重新签发产生新单据；历史变为两份，第一份原文不变
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
    await expect(page.getByTestId('release-history-item')).toHaveCount(2);
    const oldest = page.getByTestId('release-history-item').nth(1);
    await expect(oldest.getByTestId('slip-draft-text')).toContainText('12，三。');
    expect(await oldest.getAttribute('data-slip-id')).toBe(firstHistoryId);
  });

  test('签发后修改行宽或任一校准读数，当前授权立即失效', async ({ page }) => {
    await issueOne(page);

    await page.getByTestId('mode-single').click();
    await page.getByTestId('width-input').fill('8');
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-active')).toHaveCount(0);
    await expect(page.getByTestId('release-invalidated')).toBeVisible();

    // 恢复行宽并重新签发
    await page.getByTestId('mode-single').click();
    await page.getByTestId('width-input').fill('4');
    await page.getByTestId('mode-release').click();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();

    // 再改动第 3 点读数
    await page.getByTestId('mode-calibration').click();
    await page.getByTestId('height-input-3').fill('0.65');
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-active')).toHaveCount(0);
    await expect(page.getByTestId('release-invalidated')).toBeVisible();
    // 本标签改读数会让上次合格判定立即失效，必须重新判定才能放行
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('gate-calibration-blockers')).toContainText('尚未完成六点试压判定');

    // 历史单据固化的第 3 点读数仍是签发时的 0.74，未被草稿覆盖（两张单据均如此）
    for (const card of await page.getByTestId('release-history-item').all()) {
      await expect(card.getByTestId('slip-point-raw').nth(2)).toHaveText('0.74');
    }
  });
});

test.describe('压点放行：旧存档不能当作当前授权', () => {
  test('兼容恢复的旧版(v1)校准结论必须重新判定才能放行', async ({ page }) => {
    // 预置一份旧版（无 version）合格校准存档
    await page.goto('/');
    await page.evaluate(
      ([key, readings]) => {
        window.localStorage.setItem(key, JSON.stringify({ draft: { readings }, judgedRaws: readings }));
      },
      [CALIBRATION_KEY, legalReadings] as [string, string[]]
    );
    await fillDraft(page, '12，三。', '4');
    await page.getByTestId('mode-release').click();

    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('gate-calibration-blockers')).toContainText('旧版校准存档');

    // 在校准工作区重新执行一次判定后即可放行
    await page.getByTestId('mode-calibration').click();
    await page.getByTestId('calibration-judge').click();
    await expect(page.getByTestId('calibration-result')).toHaveAttribute('data-verdict', 'pass');
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-issue')).toBeEnabled();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
  });

  test('刷新后历史放行单只读可复核，但不自动成为当前授权，需重新签发', async ({ page }) => {
    await page.goto('/');
    await fillDraft(page, '12，三。', '4');
    await judgePass(page);
    await page.getByTestId('mode-release').click();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
    const slipId = await page
      .getByTestId('release-history-item')
      .first()
      .getAttribute('data-slip-id');

    await page.reload();
    await page.getByTestId('mode-release').click();

    // 没有当前授权，只提示重新签发
    await expect(page.getByTestId('release-active')).toHaveCount(0);
    await expect(page.getByTestId('release-need-reissue')).toContainText('不自动作为当前授权');
    // 历史完整、只读、来源快照仍可复核
    const historyCard = page.getByTestId('release-history-item').first();
    await expect(historyCard).toHaveAttribute('data-slip-id', slipId ?? '');
    await expect(historyCard.getByTestId('slip-draft-text')).toContainText('12，三。');
    await expect(historyCard.locator('[data-testid="slip-point-row"]')).toHaveCount(6);

    // 当前单稿与校准仍然满足条件时，可以签发一张新单
    await expect(page.getByTestId('release-issue')).toBeEnabled();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
    await expect(page.getByTestId('release-history-item')).toHaveCount(2);
  });
});

test.describe('压点放行：跨标签页更新', () => {
  test('另一标签写入新的合格校准后本标签才能放行；写入损坏记录不能授权', async ({ page, context }) => {
    await page.goto('/');
    await fillDraft(page, '12，三。', '4');
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-issue')).toBeDisabled();

    // 用第二个标签写入当前版本合格判定
    const other = await context.newPage();
    await other.goto('/');
    await other.evaluate(
      ([key, readings]) => {
        window.localStorage.setItem(key, JSON.stringify({ version: 2, draft: { readings }, judgedRaws: readings }));
      },
      [CALIBRATION_KEY, legalReadings] as [string, string[]]
    );
    await other.close();

    // storage 事件只对仍开启的原标签生效；直接触发一次事件模拟跨标签同步
    await page.evaluate((key) => {
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, CALIBRATION_KEY);

    await expect(page.getByTestId('gate-calibration-pass')).toContainText('合格');
    await expect(page.getByTestId('release-issue')).toBeEnabled();

    // 另一标签把校准存档改坏
    await page.evaluate((key) => {
      window.localStorage.setItem(key, '{损坏 JSON');
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, CALIBRATION_KEY);
    await expect(page.getByTestId('release-issue')).toBeDisabled();
    await expect(page.getByTestId('gate-calibration-blockers')).toContainText('保护');
  });

  test('已签发后另一标签改动单稿文字，当前授权立即失效；历史仍只读', async ({ page }) => {
    await page.goto('/');
    await fillDraft(page, '12，三。', '4');
    await judgePass(page);
    await page.getByTestId('mode-release').click();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();

    await page.evaluate((key) => {
      window.localStorage.setItem(key, JSON.stringify({ version: 1, text: '三四五', width: '4' }));
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, DRAFT_KEY);

    await expect(page.getByTestId('release-active')).toHaveCount(0);
    await expect(page.getByTestId('release-invalidated')).toBeVisible();
    // 历史快照仍是旧文
    await expect(page.getByTestId('release-history-item').first().getByTestId('slip-draft-text')).toContainText(
      '12，三。'
    );
  });

  test('另一标签签发的新单只进入历史，不自动成为本标签当前授权', async ({ page, context }) => {
    await page.goto('/');
    await fillDraft(page, '12，三。', '4');
    await judgePass(page);
    await page.getByTestId('mode-release').click();

    // 第二个标签完成一次真实签发
    const other = await context.newPage();
    await other.goto('/');
    await other.getByTestId('mode-release').click();
    await other.getByTestId('release-issue').click();
    await expect(other.getByTestId('release-active')).toBeVisible();
    const otherId = await other
      .getByTestId('release-history-item')
      .first()
      .getAttribute('data-slip-id');
    await other.close();

    // 通知原标签放行存档已更新
    await page.evaluate((key) => {
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, RELEASE_KEY);

    await expect(page.getByTestId('release-active')).toHaveCount(0);
    await expect(page.getByTestId('release-need-reissue')).toContainText('不自动作为当前授权');
    await expect(page.getByTestId('release-history-item').first()).toHaveAttribute('data-slip-id', otherId ?? '');
  });
});

test.describe('压点放行：失败保护', () => {
  test('放行存档损坏时告警、保留最近一次完整记录只读复核且拒绝写入', async ({ page }) => {
    await page.goto('/');
    await fillDraft(page, '12，三。', '4');
    await judgePass(page);
    await page.getByTestId('mode-release').click();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), RELEASE_KEY);
    expect(stored).not.toBeNull();

    // 存档被外部改坏
    await page.evaluate((key) => {
      window.localStorage.setItem(key, '{不是合法 JSON');
    }, RELEASE_KEY);
    await page.reload();
    await page.getByTestId('mode-release').click();

    await expect(page.getByTestId('release-archive-warning')).toContainText('无法安全恢复');
    // 最近一次完整记录仍可只读复核
    await expect(page.getByTestId('release-history-item')).toHaveCount(1);
    await expect(page.getByTestId('release-history-item').first().getByTestId('slip-draft-text')).toContainText(
      '12，三。'
    );
    await expect(page.getByTestId('release-issue')).toBeDisabled();

    // 尝试签发不会覆盖损坏存档原文
    const before = await page.evaluate((key) => window.localStorage.getItem(key), RELEASE_KEY);
    await page.getByTestId('release-issue').click({ force: true }).catch(() => undefined);
    const after = await page.evaluate((key) => window.localStorage.getItem(key), RELEASE_KEY);
    expect(after).toBe(before);
  });

  test('写入配额失败时告警、不产生伪签发、原存档保留；恢复后可正常签发', async ({ page }) => {
    await page.goto('/');
    await fillDraft(page, '12，三。', '4');
    await judgePass(page);
    await page.getByTestId('mode-release').click();

    await page.evaluate(() => {
      Storage.prototype.setItem = (key: string) => {
        if (key === 'braille-plate:release:v1') {
          throw new DOMException('quota exceeded', 'QuotaExceededError');
        }
      };
    });

    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-write-error')).toContainText('历史放行单与原存档仍保留');
    await expect(page.getByTestId('release-active')).toHaveCount(0);
    await expect(page.getByTestId('release-history-item')).toHaveCount(0);

    await page.reload();
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-write-error')).toHaveCount(0);
    await expect(page.getByTestId('release-issue')).toBeEnabled();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
  });
});

test.describe('压点放行：既有模式输入与结论不变', () => {
  test('原单稿预检、双稿核对与识读训练行为不受放行流程影响', async ({ page }) => {
    await page.goto('/');
    // 单稿预检行为完全保持
    await page.getByTestId('phrase-input').fill('12，三。');
    await page.getByTestId('width-input').fill('4');
    await expect(page.getByTestId('preview')).toBeVisible();
    await expect(page.getByTestId('total-cells')).toContainText('总方数：6 方');
    await expect(page.getByTestId('plate-line')).toHaveCount(2);

    // 放行页只读展示同一份单稿
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('gate-draft-text')).toContainText('12，三。');
    await expect(page.getByTestId('gate-draft-width')).toContainText('4');

    // 双稿核对不受影响
    await page.getByTestId('mode-compare').click();
    await page.getByTestId('base-input').fill('12，三。');
    await page.getByTestId('target-input').fill('12，三。');
    await page.getByTestId('compare-button').click();
    await expect(page.getByTestId('compare-identical')).toBeVisible();

    // 放行流程没有引入任何在线请求（由 precheck 规格单独覆盖，这里确认模式切换可用）
    await page.getByTestId('mode-training').click();
    await expect(page.getByTestId('training-start')).toBeVisible();
  });
});
