import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, paymentSnapshot, opinionIsCurrent, AMOUNT_LIMIT, SENSITIVE_KEYWORDS,
} from '../src/policy.js';

const base = {
  id: 'PAY-SYN-001',
  amount: 100,
  purpose: '合作资料核验演练',
  version: 1,
  attachment: { name: 'a.txt', sha256: 'a'.repeat(64) },
};

test('合规资料判定为可交另一授权人复核', () => {
  const verdict = evaluate(base);
  assert.equal(verdict.decision, 'review');
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.snapshot.length, 64);
});

test('超过阈值、缺附件、敏感关键词都必须人工', () => {
  assert.equal(evaluate({ ...base, amount: AMOUNT_LIMIT + 1 }).decision, 'manual');
  assert.equal(evaluate({ ...base, attachment: null }).decision, 'manual');
  assert.equal(evaluate({ ...base, purpose: `紧急${base.purpose}` }).decision, 'manual');
  assert.ok(SENSITIVE_KEYWORDS.includes('紧急'));
  assert.equal(evaluate({ ...base, amount: 0 }).decision, 'manual');
  assert.equal(evaluate(base, { channel: 'manual' }).decision, 'manual');
});

test('金额或附件变化都会改变快照，且与列表位置无关', () => {
  const a = paymentSnapshot(base).sha256;
  assert.equal(paymentSnapshot({ ...base, row: 3 }).sha256, a);
  assert.notEqual(paymentSnapshot({ ...base, amount: 101 }).sha256, a);
  assert.notEqual(
    paymentSnapshot({ ...base, attachment: { ...base.attachment, sha256: 'b'.repeat(64) } }).sha256, a);
  assert.notEqual(
    paymentSnapshot({ ...base, attachment: { ...base.attachment, name: '改名.txt' } }).sha256, a);
});

test('复核意见只对写下时的版本与快照有效', () => {
  const opinion = { version: 1, snapshot: paymentSnapshot(base).sha256 };
  assert.equal(opinionIsCurrent(opinion, base), true);
  assert.equal(opinionIsCurrent(opinion, { ...base, version: 2 }), false);
  assert.equal(
    opinionIsCurrent(opinion, { ...base, amount: 101 }), false);
  assert.equal(opinionIsCurrent(null, base), false);
});
