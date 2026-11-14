import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startPortal } from '../src/portal.js';
import { DualReviewWorkflow, WorkflowHalt, HaltReason, RoleSession } from '../src/assistant.js';
import { digest } from '../src/archive.js';

const attachment = name => {
  const path = `fixtures/attachments/${name}`;
  return readFile(path).then(bytes => ({ name, path, sha256: digest(bytes) }));
};

test('两个独立浏览器上下文持有各自登录态，cookie 互不复制', async () => {
  const portal = await startPortal();
  const workflow = new DualReviewWorkflow(portal.url);
  try {
    await workflow.start();
    await workflow.loginBoth();
    const [makerCookies, reviewerCookies] = await Promise.all([
      workflow.maker.context.cookies(),
      workflow.reviewer.context.cookies(),
    ]);
    assert.equal(makerCookies.length, 1);
    assert.equal(reviewerCookies.length, 1);
    assert.notEqual(makerCookies[0].value, reviewerCookies[0].value);
    // 身份只认真实服务端会话，不看页面按钮状态。
    const makerIdentity = await workflow.maker.assertIdentity();
    assert.deepEqual(makerIdentity, { id: 'maker-A', name: '制单员甲', role: 'maker' });
    const reviewerIdentity = await workflow.reviewer.assertIdentity();
    assert.deepEqual(reviewerIdentity, { id: 'reviewer-B', name: '复核员乙', role: 'reviewer' });
  } finally {
    await workflow.close();
    await portal.close();
  }
});

test('制单后修改资料：旧页面复核被拒，重新审阅新版本后才登记', async () => {
  const portal = await startPortal();
  const workflow = new DualReviewWorkflow(portal.url);
  try {
    await workflow.start();
    await workflow.loginBoth();

    const first = await workflow.makerPrepare({
      amount: 100, purpose: '合作资料核验演练',
      attachment: await attachment('付款资料-SYN-001.txt'),
    });
    workflow.route(first);
    const observed = await workflow.reviewerObserve();
    // 先完成一次对旧版本的复核；制单员随后的修改必须让这条意见失效。
    const firstResult = await workflow.reviewerSubmit({ observed });
    assert.equal(firstResult.payment.approved, true);

    await workflow.makerPrepare({
      amount: 260, purpose: '合作资料核验演练',
      attachment: await attachment('付款资料-SYN-002-修订版.txt'),
    });
    await assert.rejects(
      workflow.reviewerSubmit({ observed }),
      error => error instanceof WorkflowHalt && error.reason === HaltReason.VERSION_STALE);

    const current = await workflow.reviewerObserve();
    assert.notEqual(current.snapshot, observed.snapshot);
    const result = await workflow.reviewerSubmit({ observed: current });
    assert.equal(result.opinion.version, current.version);
    assert.equal(result.opinion.snapshot, current.snapshot);
    assert.equal(result.payment.approved, true);

    const audit = await workflow.auditTrail();
    assert.ok(audit.opinions.some(opinion => opinion.current === false));
    assert.ok(audit.opinions.some(opinion => opinion.current === true && opinion.user === 'reviewer-B'));
    assert.ok(audit.audit.some(event => event.user === 'maker-A' && event.action === 'edit'));
    assert.ok(audit.audit.some(event => event.user === 'reviewer-B' && event.action === 'review-stale'));
  } finally {
    await workflow.close();
    await portal.close();
  }
});

test('敏感事项暂停等人工；角色回退与会话过期都能停止并在重登后重新核对', async () => {
  const portal = await startPortal();
  const workflow = new DualReviewWorkflow(portal.url);
  try {
    await workflow.start();
    await workflow.loginBoth();

    const sensitive = await workflow.makerPrepare({
      amount: 5000, purpose: '合作资料核验演练',
      attachment: await attachment('付款资料-SYN-002-修订版.txt'),
    });
    assert.throws(() => workflow.route(sensitive),
      error => error instanceof WorkflowHalt && error.reason === HaltReason.MANUAL_REQUIRED);

    // 角色回退：复核人上下文被换成制单人的会话时，特权操作前必须被拦下。
    await workflow.reviewer.logout();
    await workflow.reviewer.request.post(`${portal.url}/api/login`, { data: { user: 'maker-A' } });
    await assert.rejects(workflow.reviewer.assertIdentity(),
      error => error instanceof WorkflowHalt && error.reason === HaltReason.ROLE_MISMATCH);

    // 重新以正确身份登录后恢复，并重新核对版本。
    await workflow.reviewer.login();
    const reobserved = await workflow.reviewerObserve();
    assert.equal(reobserved.version, sensitive.version);

    // 会话过期：清空服务端会话后引擎停止，重登再核对。
    portal.sessions.clear();
    await assert.rejects(workflow.reviewer.assertIdentity(),
      error => error instanceof WorkflowHalt && error.reason === HaltReason.SESSION_EXPIRED);
    const afterRelogin = await workflow.resumeAfterRelogin();
    assert.equal(afterRelogin.snapshot, reobserved.snapshot);

    const hold = await workflow.reviewer.request.post(`${portal.url}/api/review`, {
      data: {
        version: afterRelogin.version, snapshot: afterRelogin.snapshot, confirmed: true,
        decision: 'hold', channel: 'manual', note: '人工暂缓',
      },
    });
    assert.equal(hold.status(), 200);
  } finally {
    await workflow.close();
    await portal.close();
  }
});

test('附件字节与登记摘要不一致时制单被拒绝', async () => {
  const portal = await startPortal();
  const workflow = new DualReviewWorkflow(portal.url);
  try {
    await workflow.start();
    await workflow.loginBoth();
    await assert.rejects(workflow.makerPrepare({
      amount: 100,
      purpose: '合作资料核验演练',
      attachment: { name: 'x.txt', path: 'fixtures/attachments/付款资料-SYN-001.txt', sha256: '0'.repeat(64) },
    }), /摘要不一致/);
  } finally {
    await workflow.close();
    await portal.close();
  }
});

test('协作引擎不允许复制 cookie 或以按钮可点性判断身份（静态守卫）', async () => {
  const source = await readFile('src/assistant.js', 'utf8');
  // 只拦截真实 API 调用（点号调用形态），允许注释里解释“禁止使用”。
  assert.doesNotMatch(source, /\.\s*addCookies\s*\(/);
  assert.doesNotMatch(source, /\.\s*is(Enabled|Disabled)\s*\(/);
  assert.ok(source.includes('/api/identity'));
  assert.ok(RoleSession.toString().includes('newContext'));
});
