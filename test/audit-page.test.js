import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startPortal } from '../src/portal.js';

test('只读审计页展示两人各自处理的版本与失效意见', { timeout: 30000 }, async () => {
  const portal = await startPortal();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const makerContext = await browser.newContext();
    const reviewerContext = await browser.newContext();
    try {
      const maker = await makerContext.newPage();
      await maker.goto(portal.url);
      await maker.locator('#user').selectOption('maker-A');
      await maker.getByRole('button', { name: '登录', exact: true }).click();
      await maker.waitForFunction(() => document.querySelector('#identity').textContent.includes('maker-A'));
      await maker.locator('#amount').fill('150');
      await maker.locator('#edit').click();
      await maker.waitForFunction(() => document.querySelector('#version').textContent.includes('版本 2'));

      const reviewer = await reviewerContext.newPage();
      await reviewer.goto(portal.url);
      await reviewer.locator('#user').selectOption('reviewer-B');
      await reviewer.locator('#login').click();
      await reviewer.waitForFunction(() => document.querySelector('#identity').textContent.includes('reviewer-B'));
      await reviewer.locator('#confirm').check();
      await reviewer.locator('#approve').click();
      await reviewer.waitForFunction(() => document.querySelector('#notice').textContent.includes('复核意见已登记'));

      // 制单员再改一次金额，旧意见应在审计页标记为失效。
      await maker.locator('#amount').fill('180');
      await maker.locator('#edit').click();
      await maker.waitForFunction(() => document.querySelector('#version').textContent.includes('版本 3'));

      const auditPage = await browser.newPage();
      await auditPage.goto(`${portal.url}/audit.html`);
      await auditPage.waitForFunction(() => document.querySelectorAll('#events tbody tr').length >= 4);
      const rows = await auditPage.locator('#opinions tbody tr').allInnerTexts();
      assert.ok(rows.some(row => row.includes('reviewer-B') && row.includes('v2') && row.includes('已随资料变更失效')));
      const events = await auditPage.locator('#events tbody').innerText();
      assert.ok(events.includes('edit') && events.includes('approve'));
      // 审计页没有任何写操作入口。
      assert.equal(await auditPage.locator('button').count(), 1);
      assert.equal(await auditPage.getByRole('button', { name: '登录' }).count(), 0);
    } finally {
      await makerContext.close();
      await reviewerContext.close();
    }
  } finally {
    await browser.close();
    await portal.close();
  }
});
