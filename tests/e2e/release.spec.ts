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

test.describe('压点放行：历史只增不减、双页签交错与编号冲突', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  /** 直接改写共享单稿草稿并模拟跨标签同步，放行页闸门据此重算（内容逐字可控）。 */
  async function setDraftViaStorage(page: import('@playwright/test').Page, text: string) {
    await page.evaluate(
      ([key, value]) => {
        window.localStorage.setItem(key, JSON.stringify(value));
        window.dispatchEvent(new StorageEvent('storage', { key }));
      },
      [DRAFT_KEY, { version: 1, text, width: '4' }] as [string, unknown]
    );
  }

  test('超过 200 次签发：历史累计 205 份，第 1 张不消失且每份内容与签发时一致', async ({ page }) => {
    test.setTimeout(300_000);
    await fillDraft(page, '000，三。', '4');
    await judgePass(page);
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-issue')).toBeEnabled();

    const total = 205;
    const texts: string[] = [];
    for (let i = 0; i < total; i += 1) {
      // 每张放行单固化不同原文：1 至 4 个循环数字 + 固定后缀（均为合法字符）
      const text = `${i % 10}`.repeat(1 + (i % 4)) + '，三。';
      texts.push(text);
      await setDraftViaStorage(page, text);
      await page.getByTestId('release-issue').click();
      await expect(page.getByTestId('release-write-error')).toHaveCount(0);
      // 首张、跨 200 临界的第 201 张与最后一张：当前放行单内容必须就是本次原件
      if (i === 0 || i === 200 || i === total - 1) {
        await expect(page.getByTestId('release-active').getByTestId('slip-draft-text')).toContainText(text);
      }
    }

    // 历史区渲染全部 205 份（第 201 张没有顶掉第 1 张）
    await expect(page.getByTestId('release-history-item')).toHaveCount(total);
    await expect(page.locator('.release-history h2')).toContainText(`${total} 份`);

    // 存档层逐份核对：编号互不相同，每份固化原文与签发输入按顺序逐字一致
    const archiveCheck = await page.evaluate((key) => {
      const record = JSON.parse(window.localStorage.getItem(key) ?? '{"slips":[]}');
      return {
        count: record.slips.length,
        ids: record.slips.map((slip: { id: string }) => slip.id),
        draftTexts: record.slips.map((slip: { snapshot: { draft: { text: string } } }) => slip.snapshot.draft.text)
      };
    }, RELEASE_KEY);
    expect(archiveCheck.count).toBe(total);
    expect(new Set(archiveCheck.ids).size).toBe(total);
    expect(archiveCheck.draftTexts).toEqual(texts);

    // 第 1 张可在界面只读复核，内容是最早的原件；中间一张（i=104）同样可查
    const oldest = page.getByTestId('release-history-item').nth(total - 1);
    await expect(oldest.getByTestId('slip-draft-text')).toContainText('000，三。');
    await expect(page.getByTestId('release-history-item').nth(100).getByTestId('slip-draft-text')).toContainText(
      '4444，三。'
    );

    // 刷新后全部 205 份仍可只读复核（含最早一张）
    await page.reload();
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-history-item')).toHaveCount(total);
    await expect(page.getByTestId('release-history-item').nth(total - 1).getByTestId('slip-draft-text')).toContainText(
      '000，三。'
    );
  });

  test('双页签交错写入：一页签的旧整表覆盖另一页签已签发单据时自动补齐，两边历史一致', async ({ page, context }) => {
    await fillDraft(page, '12，三。', '4');
    await judgePass(page);
    await page.getByTestId('mode-release').click();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
    const firstId = await page
      .getByTestId('release-history-item')
      .first()
      .getAttribute('data-slip-id');

    // 第二个页签打开时能看到第一张（共享 localStorage）
    const other = await context.newPage();
    await other.goto('/');
    await other.getByTestId('mode-release').click();
    await other.getByTestId('release-issue').click();
    await expect(other.getByTestId('release-active')).toBeVisible();
    const secondId = await other
      .getByTestId('release-history-item')
      .first()
      .getAttribute('data-slip-id');
    expect(secondId).not.toBe(firstId);

    // 模拟交错覆盖：第二页签用“只含自己单据”的旧整表覆盖主存档（等同读旧列表后写整表）
    await page.evaluate(
      ([key, id]) => {
        const record = JSON.parse(window.localStorage.getItem(key) ?? '{"slips":[]}');
        const onlySecond = record.slips.filter((slip: { id: string }) => slip.id === id);
        window.localStorage.setItem(key, JSON.stringify({ version: 1, slips: onlySecond }));
        window.dispatchEvent(new StorageEvent('storage', { key }));
      },
      [RELEASE_KEY, secondId] as [string, string]
    );

    // 第一页签的认领修复把丢失的第一张补写回来，并给出明确修复提示
    await expect(page.getByTestId('release-archive-notice')).toContainText('已自动把本页签签发的单据合并补写');
    await expect(page.getByTestId('release-history-item')).toHaveCount(2);
    const idsAfterHeal = await page
      .getByTestId('release-history-item')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-slip-id')));
    expect(idsAfterHeal.sort()).toEqual([firstId, secondId].sort());

    // 浏览器只把 storage 事件投递给“其它”页签；第一页签的补写完成后，
    // 显式通知第二页签重新同步（真实跨页签场景该事件由浏览器自动投递）。
    await other.evaluate((key) => {
      window.dispatchEvent(new StorageEvent('storage', { key }));
    }, RELEASE_KEY);
    await expect(other.getByTestId('release-history-item')).toHaveCount(2);

    // 两份单据内容仍是各自签发原件，未互相覆盖
    await expect(page.locator(`[data-slip-id="${firstId}"]`).getByTestId('slip-draft-text')).toContainText(
      '12，三。'
    );
    await expect(page.locator(`[data-slip-id="${secondId}"]`).getByTestId('slip-draft-text')).toContainText(
      '12，三。'
    );
    await other.close();
  });

  test('受控相同编号但内容不同：第二次被明确拒绝并告警，历史保留编号原件，当前不成为伪签发', async ({ context }) => {
    // 在页面脚本运行前冻结时间与随机源，使两次签发恰好生成相同编号；
    // 冻结时间设为未来整点，避免与真实当前秒碰撞。冻结只作用于第一次导航，
    // 随后用 reload 标记解除。
    await context.addInitScript(() => {
      if (window.sessionStorage.getItem('test:freeze-clock') !== '1') {
        return;
      }
      const frozen = new Date('2026-11-15T08:30:00.000Z').getTime();
      class FrozenDate extends Date {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(frozen);
          } else {
            // @ts-expect-error 测试内构造参数转发
            super(...args);
          }
        }
        static now() {
          return frozen;
        }
      }
      // @ts-expect-error 测试内替换全局构造器
      window.Date = FrozenDate;
      Math.random = () => (0x12345678 + 0.5) / 0x100000000;
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.evaluate(() => window.sessionStorage.setItem('test:freeze-clock', '1'));

    await fillDraft(page, '12，三。', '4');
    await judgePass(page);
    await page.getByTestId('mode-release').click();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
    const firstId = await page
      .getByTestId('release-history-item')
      .first()
      .getAttribute('data-slip-id');
    expect(firstId).toMatch(/PF-\d{8}-\d{6}-12345678/);

    // 改成不同原文后再次签发：编号相同但快照内容不同
    await setDraftViaStorage(page, '99，九。');
    await page.getByTestId('release-issue').click();

    // 明确的编号冲突告警；历史仍是第一次的原件
    await expect(page.getByTestId('release-write-error')).toContainText('编号与历史单据相同但内容不一致');
    await expect(page.getByTestId('release-history-item')).toHaveCount(1);
    const only = page.getByTestId('release-history-item').first();
    await expect(only).toHaveAttribute('data-slip-id', firstId ?? '');
    await expect(only.getByTestId('slip-draft-text')).toContainText('12，三。');
    // 当前可放行区不把不同内容当作已签发单据
    await expect(page.getByTestId('release-active')).toHaveCount(0);

    // 草稿保持“99，九。”，合格校准存档仍在；解除冻结后重新加载，签发得到新编号
    await page.evaluate(() => window.sessionStorage.removeItem('test:freeze-clock'));
    await page.reload();
    await page.getByTestId('mode-release').click();
    await expect(page.getByTestId('release-issue')).toBeEnabled();
    await page.getByTestId('release-issue').click();
    await expect(page.getByTestId('release-active')).toBeVisible();
    await expect(page.getByTestId('release-history-item')).toHaveCount(2);
    const latestId = await page
      .getByTestId('release-history-item')
      .first()
      .getAttribute('data-slip-id');
    expect(latestId).not.toBe(firstId);
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
