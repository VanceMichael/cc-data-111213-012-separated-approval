import { createHash } from 'node:crypto';

// 双人复核的纯规则模块：不持有会话、不触碰浏览器、不做任何网络请求。
// 门户服务端与人机协作引擎共用同一份判定逻辑，避免“页面说可以、服务端却拒绝”的分叉。

// 超过该金额的付款属于敏感事项，自动化只能停在人工，不得代为推进。
export const AMOUNT_LIMIT = 1000;
// 用途或附件说明命中这些词的付款需要人工判断，机器不自动批准。
export const SENSITIVE_KEYWORDS = ['现金', '跨境', '紧急'];

// 复核人看到并确认的“具体版本”由版本号和内容快照共同唯一确定。
// 快照只汇总页面/接口实际存在的字段，绝不把列表行位置之类的展示信息算进去。
export function paymentSnapshot(payment = {}) {
  const amount = Number(payment.amount);
  const attachment = payment.attachment
    ? { name: String(payment.attachment.name), sha256: String(payment.attachment.sha256) }
    : null;
  const basis = JSON.stringify({
    id: String(payment.id),
    amount: Number.isFinite(amount) ? amount : 0,
    attachment,
  });
  return {
    basis: JSON.parse(basis),
    sha256: createHash('sha256').update(basis).digest('hex'),
  };
}

// 规则结论只有两种：
// - review：符合规则，可以交给另一位获授权人员确认（仍然需要真人复核，不是自动批准）
// - manual：敏感事项，人机协作在此停止并等待人工确认
export function evaluate(payment = {}, context = {}) {
  const reasons = [];
  const amount = Number(payment.amount);
  if (!Number.isFinite(amount) || amount <= 0) reasons.push('金额不合法');
  if (amount > AMOUNT_LIMIT) reasons.push(`金额超过双人复核辅助阈值 ${AMOUNT_LIMIT}`);
  if (!payment.attachment || !payment.attachment.sha256) reasons.push('缺少可核验附件');
  const text = `${payment.purpose || ''} ${payment.attachment?.name || ''}`;
  const hit = SENSITIVE_KEYWORDS.find(keyword => text.includes(keyword));
  if (hit) reasons.push(`用途或附件命中敏感关键词「${hit}」`);
  if (context.channel === 'manual') reasons.push('人工通道提交的事项需保留人工判断');
  return {
    decision: reasons.length ? 'manual' : 'review',
    reasons,
    limit: AMOUNT_LIMIT,
    snapshot: paymentSnapshot(payment).sha256,
  };
}

// 一条复核意见只对它被写下时的（版本号, 快照）负责。
// 金额或附件一旦改变，门户版本号递增、快照变化，旧意见立即不再对应当前资料。
export function opinionIsCurrent(opinion, payment) {
  if (!opinion || !payment) return false;
  return (
    opinion.version === payment.version &&
    opinion.snapshot === paymentSnapshot(payment).sha256
  );
}
