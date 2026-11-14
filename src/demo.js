import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPortal } from './portal.js';
import { DualReviewWorkflow, WorkflowHalt, HaltReason } from './assistant.js';
import { Archive, digest } from './archive.js';

const attachment = async name => {
  const path = join('fixtures', 'attachments', name);
  const bytes = await readFile(path);
  return { name, path, sha256: digest(bytes) };
};

const summarizeHalt = halt => ({ reason: halt.reason, details: halt.details });

// 完整演示返回结构化报告；每个场景都能在审计页找到两个人各自处理过的版本。
export async function runDemonstration(options = {}) {
  const headless = options.headless ?? true;
  const portal = await startPortal();
  const evidence = await mkdtemp(join(tmpdir(), 'separated-approval-'));
  const archive = new Archive(evidence);
  const workflow = new DualReviewWorkflow(portal.url, { headless });
  const scenarios = [];
  try {
    await workflow.start();
    await workflow.loginBoth();

    // 场景一：制单员修改一笔已待复核（且已有同意意见）的资料，证明复核不会顺着旧页面通过。
    const first = await workflow.makerPrepare({
      amount: 100,
      purpose: '合作资料核验演练',
      attachment: await attachment('付款资料-SYN-001.txt'),
    });
    workflow.route(first);
    const observedV2 = await workflow.reviewerObserve();
    await archive.accept(await readFile(first.attachment.path), {
      scenario: 'stale-page', version: first.version, role: 'reviewer-observed',
    });
    // 复核人先对 v2 登记同意，随后制单员的修改会让这条意见失效。
    const firstAgree = await workflow.reviewerSubmit({ observed: observedV2, note: '首次审阅同意' });

    // 制单员在复核完成后改金额并换附件 → 版本号与快照同时变化，旧意见立即失效。
    const revised = await workflow.makerPrepare({
      amount: 260,
      purpose: '合作资料核验演练',
      attachment: await attachment('付款资料-SYN-002-修订版.txt'),
    });
    const staleAttempt = await workflow.reviewerSubmit({ observed: observedV2 })
      .then(() => null)
      .catch(error => (error instanceof WorkflowHalt ? error : Promise.reject(error)));
    if (!staleAttempt || staleAttempt.reason !== HaltReason.VERSION_STALE) {
      throw new Error('旧页面复核应被服务端以版本失效拒绝');
    }
    scenarios.push({
      name: '旧页面复核被拒',
      expected: '版本与快照双绑定，旧复核意见失效',
      priorAgreement: { version: firstAgree.opinion.version, snapshot: firstAgree.opinion.snapshot },
      halt: summarizeHalt(staleAttempt),
      current: { version: revised.version, snapshot: revised.snapshot },
    });

    // 场景二：正常业务——复核人重新审阅新版本并确认，审计页能说明两人各处理了哪个版本。
    const current = await workflow.reviewerObserve();
    workflow.route(current);
    const approved = await workflow.reviewerSubmit({ observed: current, note: '重新审阅修订版本后同意' });
    scenarios.push({
      name: '正常双人复核',
      expected: '另一授权人确认具体版本后才登记同意',
      opinion: { id: approved.opinion.id, version: approved.opinion.version, snapshot: approved.opinion.snapshot },
    });

    // 场景三：敏感事项（超阈值金额）必须停在人工，辅助流程不得代为确认。
    const sensitive = await workflow.makerPrepare({
      amount: 5000,
      purpose: '合作资料核验演练',
      attachment: await attachment('付款资料-SYN-002-修订版.txt'),
    });
    const manualHalt = (() => {
      try { workflow.route(sensitive); return null; }
      catch (error) { return error instanceof WorkflowHalt ? error : null; }
    })();
    if (!manualHalt || manualHalt.reason !== HaltReason.MANUAL_REQUIRED) {
      throw new Error('敏感事项应触发人工暂停');
    }
    // 即便绕过引擎直接以复核身份提交，服务端同样拒绝自动通道的同意。
    const blocked = await workflow.reviewer.request.post(`${portal.url}/api/review`, {
      data: { version: sensitive.version, snapshot: sensitive.snapshot, confirmed: true, decision: 'agree', channel: 'automated' },
    });
    scenarios.push({
      name: '敏感事项等待人工',
      expected: '引擎暂停且服务端拒绝自动同意',
      halt: summarizeHalt(manualHalt),
      serverStatus: blocked.status(),
      serverError: (await blocked.json()).error,
    });

    // 场景四：会话过期——引擎停止，重新登录后重新核对版本再继续。
    await portal.sessions.clear();
    const expired = await workflow.reviewer.assertIdentity()
      .then(() => null)
      .catch(error => (error instanceof WorkflowHalt ? error : Promise.reject(error)));
    if (!expired || expired.reason !== HaltReason.SESSION_EXPIRED) {
      throw new Error('会话清空后应触发会话过期暂停');
    }
    const reobserved = await workflow.resumeAfterRelogin();
    const manualReview = await workflow.reviewer.request.post(`${portal.url}/api/review`, {
      data: {
        version: reobserved.version, snapshot: reobserved.snapshot, confirmed: true,
        decision: 'hold', channel: 'manual', note: '敏感金额，人工复核暂缓',
      },
    });
    if (!manualReview.ok()) throw new Error('人工通道的暂缓意见应被登记');
    const manualOpinion = await manualReview.json();
    scenarios.push({
      name: '会话过期后重新登录核对',
      expected: '停止 → 重新登录 → 重新拉取版本与快照 → 再登记人工意见',
      halt: summarizeHalt(expired),
      reobserved: { version: reobserved.version, snapshot: reobserved.snapshot },
      manualOpinion: { id: manualOpinion.opinion.id, version: manualOpinion.opinion.version, channel: manualOpinion.opinion.channel },
    });

    const audit = await workflow.auditTrail();
    workflow.report.result = { scenarios, evidence: { directory: evidence, receipts: (await archive.receipts()).length },
      payment: audit.payment, opinions: audit.opinions, auditCount: audit.audit.length };
    return workflow.report;
  } finally {
    await workflow.close();
    await portal.close();
    await rm(evidence, { recursive: true, force: true });
  }
}
