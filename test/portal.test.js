import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startPortal} from '../src/portal.js';
test('本地门户现有人工操作可执行且保持业务边界',{timeout:25000},async()=>{
  const portal=await startPortal();
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{const page=await browser.newPage();await page.goto(portal.url);await page.waitForFunction(()=>document.querySelector('#notice').textContent.length>0);

await page.locator('#user').selectOption('maker-A'); await page.getByRole('button',{name:'登录',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('#identity').textContent.includes('maker-A'));
await page.locator('#confirm').check(); await page.locator('#approve').click();
await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('独立复核'));
const second=await browser.newContext();
try { const reviewer=await second.newPage();await reviewer.goto(portal.url);await reviewer.locator('#user').selectOption('reviewer-B');await reviewer.locator('#login').click();
await reviewer.waitForFunction(()=>document.querySelector('#identity').textContent.includes('reviewer-B'));
assert.ok((await page.locator('#identity').textContent()).includes('maker-A'));
} finally { await second.close(); }

  }finally{await browser.close();await portal.close();}
});
