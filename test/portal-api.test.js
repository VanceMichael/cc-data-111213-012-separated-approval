import test from 'node:test';
import assert from 'node:assert/strict';
import { startPortal } from '../src/portal.js';
import { paymentSnapshot } from '../src/policy.js';

const jsonPost = (url, path, data, cookie) => fetch(`${url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(data),
});
const login = async (url, user) => {
  const response = await jsonPost(url, '/api/login', { user, channel: 'test' });
  return response.headers.get('set-cookie').split(';')[0];
};

async function withPortal(run) {
  const portal = await startPortal();
  try { await run(portal); } finally { await portal.close(); }
}

test('制单与复核必须是两个独立会话，制单人不能自审', async () => {
  await withPortal(async portal => {
    const maker = await login(portal.url, 'maker-A');
    const reviewer = await login(portal.url, 'reviewer-B');
    assert.notEqual(maker, reviewer);

    const payment = await (await jsonPost(portal.url, '/api/payment',
      { amount: 120, channel: 'test' }, maker)).json();
    assert.equal(payment.version, 2);

    const selfReview = await jsonPost(portal.url, '/api/review',
      { version: payment.version, snapshot: payment.snapshot, confirmed: true }, maker);
    assert.equal(selfReview.status, 403);
    assert.match((await selfReview.json()).error, /独立复核/);

    const anonymous = await jsonPost(portal.url, '/api/review',
      { version: 2, snapshot: payment.snapshot, confirmed: true });
    assert.equal(anonymous.status, 401);

    const ok = await jsonPost(portal.url, '/api/review',
      { version: payment.version, snapshot: payment.snapshot, confirmed: true, decision: 'agree' }, reviewer);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.opinion.version, 2);
    assert.equal(body.opinion.channel, 'automated');
  });
});

test('金额或附件变更使旧复核意见失效，旧版本提交被 409 拒绝', async () => {
  await withPortal(async portal => {
    const maker = await login(portal.url, 'maker-A');
    const reviewer = await login(portal.url, 'reviewer-B');
    const first = await (await jsonPost(portal.url, '/api/payment',
      { amount: 100, channel: 'test' }, maker)).json();
    const agree = await jsonPost(portal.url, '/api/review',
      { version: first.version, snapshot: first.snapshot, confirmed: true }, reviewer);
    assert.equal(agree.status, 200);

    const changed = await (await jsonPost(portal.url, '/api/payment',
      { amount: 260, attachment: { name: '新附件.txt', sha256: 'c'.repeat(64) }, channel: 'test' }, maker)).json();
    assert.equal(changed.version, first.version + 1);
    assert.notEqual(changed.snapshot, first.snapshot);
    assert.equal(changed.approved, false);

    const stale = await jsonPost(portal.url, '/api/review',
      { version: first.version, snapshot: first.snapshot, confirmed: true }, reviewer);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /失效/);

    const opinions = await (await fetch(`${portal.url}/api/review`, {
      headers: { cookie: reviewer },
    })).json();
    assert.equal(opinions.length, 1);
    assert.equal(opinions[0].current, false);
    const audit = await (await fetch(`${portal.url}/api/audit`)).json();
    assert.ok(audit.audit.some(event => event.action === 'review-stale'));
  });
});

test('快照由服务端按当前内容复算，伪造快照无法通过复核', async () => {
  await withPortal(async portal => {
    const maker = await login(portal.url, 'maker-A');
    const reviewer = await login(portal.url, 'reviewer-B');
    const payment = await (await jsonPost(portal.url, '/api/payment',
      { amount: 100, channel: 'test' }, maker)).json();
    const forged = await jsonPost(portal.url, '/api/review',
      { version: payment.version, snapshot: 'f'.repeat(64), confirmed: true }, reviewer);
    assert.equal(forged.status, 409);
    const valid = await jsonPost(portal.url, '/api/review',
      { version: payment.version, snapshot: paymentSnapshot(payment).sha256, confirmed: true }, reviewer);
    assert.equal(valid.status, 200);
  });
});

test('敏感事项拒绝自动通道同意，但接受人工暂缓；未确认版本也被拒绝', async () => {
  await withPortal(async portal => {
    const maker = await login(portal.url, 'maker-A');
    const reviewer = await login(portal.url, 'reviewer-B');
    const sensitive = await (await jsonPost(portal.url, '/api/payment',
      { amount: 5000, channel: 'test' }, maker)).json();
    assert.equal(sensitive.policy.decision, 'manual');

    const blocked = await jsonPost(portal.url, '/api/review',
      { version: sensitive.version, snapshot: sensitive.snapshot, confirmed: true, decision: 'agree' }, reviewer);
    assert.equal(blocked.status, 403);
    assert.match((await blocked.json()).error, /人工/);

    const unconfirmed = await jsonPost(portal.url, '/api/review',
      { version: sensitive.version, snapshot: sensitive.snapshot, confirmed: false }, reviewer);
    assert.equal(unconfirmed.status, 409);

    const manual = await jsonPost(portal.url, '/api/review',
      { version: sensitive.version, snapshot: sensitive.snapshot, confirmed: true, decision: 'hold', channel: 'manual' }, reviewer);
    assert.equal(manual.status, 200);
    assert.equal((await manual.json()).opinion.channel, 'manual');
  });
});

test('注销后身份接口 401；审计接口只读', async () => {
  await withPortal(async portal => {
    const cookie = await login(portal.url, 'reviewer-B');
    assert.equal((await fetch(`${portal.url}/api/identity`, { headers: { cookie } })).status, 200);
    await jsonPost(portal.url, '/api/logout', {}, cookie);
    assert.equal((await fetch(`${portal.url}/api/identity`, { headers: { cookie } })).status, 401);

    const auditGet = await fetch(`${portal.url}/api/audit`);
    assert.equal(auditGet.status, 200);
    const auditPost = await jsonPost(portal.url, '/api/audit', {});
    assert.equal(auditPost.status, 405);
  });
});
