import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluate, paymentSnapshot, AMOUNT_LIMIT, SENSITIVE_KEYWORDS } from './policy.js';
import { digest } from './archive.js';

// 暂停原因是显式枚举：调用方必须按原因决定是“等人重新登录”还是“等人工确认”，
// 引擎不会在会话过期、角色回退或敏感事项上自动重试或自行批准。
export const HaltReason = Object.freeze({
  SESSION_EXPIRED: 'session-expired',
  ROLE_MISMATCH: 'role-mismatch',
  VERSION_STALE: 'version-stale',
  MANUAL_REQUIRED: 'manual-required',
});

export class WorkflowHalt extends Error {
  constructor(reason, details = {}) {
    super(`工作流暂停：${reason}`);
    this.name = 'WorkflowHalt';
    this.reason = reason;
    this.details = details;
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// 一个 RoleSession 对应一个独立浏览器上下文（独立 cookie jar / storage）。
// 两个角色各自 new 一个 RoleSession，从不共享上下文，也不互相复制 cookie。
export class RoleSession {
  constructor(browser, { portalUrl, user, role, label }) {
    this.user = user;
    this.role = role;
    this.label = label;
    // 每次都新建独立上下文：这是隔离的唯一来源，禁止 addCookies/context 复用。
    this.contextPromise = browser.newContext();
    this.portalUrl = portalUrl;
    this.events = [];
  }

  async open() {
    this.context = await this.contextPromise;
    this.page = await this.context.newPage();
    // 每个角色的请求都绑定在自己的上下文里，cookie 由浏览器在真实登录后自行保管。
    this.request = this.context.request;
  }

  // 身份以服务端 /api/identity 的 JSON 为准，不读取页面按钮是否可点、也不读 DOM 文案。
  async assertIdentity() {
    const response = await this.request.get(`${this.portalUrl}/api/identity`);
    if (response.status() === 401) {
      throw new WorkflowHalt(HaltReason.SESSION_EXPIRED, { user: this.user, role: this.role });
    }
    if (!response.ok()) throw new Error(`身份核验失败：${response.status()}`);
    const identity = await response.json();
    if (identity.id !== this.user || identity.role !== this.role) {
      // 共享电脑上常见的“浏览器还挂着别人的登录态”在这里被拦下，而不是被沿用。
      throw new WorkflowHalt(HaltReason.ROLE_MISMATCH, {
        expected: { id: this.user, role: this.role },
        actual: { id: identity.id, role: identity.role },
      });
    }
    return identity;
  }

  // 登录走门户真实表单，会话 cookie 由 HttpOnly 响应头下发；引擎不手工构造或复制任何 cookie。
  async login() {
    await this.page.goto(this.portalUrl);
    await this.page.locator('#user').selectOption(this.user);
    await this.page.getByRole('button', { name: '登录', exact: true }).click();
    await this.page.waitForResponse(response => response.url().endsWith('/api/login') && response.request().method() === 'POST');
    const identity = await this.assertIdentity();
    this.events.push({ at: new Date().toISOString(), event: 'login', user: this.user, role: this.role });
    return identity;
  }

  async logout() {
    await this.request.post(`${this.portalUrl}/api/logout`, { data: {} });
    this.events.push({ at: new Date().toISOString(), event: 'logout', user: this.user });
  }

  async fetchPayment() {
    await this.assertIdentity();
    const response = await this.request.get(`${this.portalUrl}/api/payment`);
    if (!response.ok()) throw new Error(`读取资料失败：${response.status()} ${(await response.json()).error || ''}`);
    return response.json();
  }

  async close() {
    if (this.context) await this.context.close();
  }
}

// 双人复核辅助流程：制单员整理资料 → 规则分流 → 另一授权人确认具体版本；
// 敏感事项、会话异常与版本失效一律停下来等人，绝不自动批准付款。
export class DualReviewWorkflow {
  constructor(portalUrl, options = {}) {
    this.portalUrl = portalUrl;
    this.headless = options.headless ?? true;
    this.report = {
      startedAt: new Date().toISOString(),
      portal: portalUrl,
      limit: AMOUNT_LIMIT,
      sensitiveKeywords: SENSITIVE_KEYWORDS,
      steps: [],
      halts: [],
      result: null,
    };
  }

  async start() {
    this.browser = await chromium.launch({
      headless: this.headless,
      args: ['--no-sandbox'],
    });
    // 关键隔离点：两个独立 BrowserContext，各自独立 cookie/storage，互不复制。
    this.maker = new RoleSession(this.browser, {
      portalUrl: this.portalUrl, user: 'maker-A', role: 'maker', label: '制单员甲',
    });
    this.reviewer = new RoleSession(this.browser, {
      portalUrl: this.portalUrl, user: 'reviewer-B', role: 'reviewer', label: '复核员乙',
    });
    await Promise.all([this.maker.open(), this.reviewer.open()]);
    return this;
  }

  log(step) {
    const entry = { at: new Date().toISOString(), ...step };
    this.report.steps.push(entry);
    return entry;
  }

  async loginBoth() {
    // 分别在各自上下文里走真实登录，不共享、不转存任何会话凭据。
    await this.maker.login();
    await this.reviewer.login();
    const makerCookie = await this.maker.context.cookies();
    const reviewerCookie = await this.reviewer.context.cookies();
    this.log({ event: 'contexts-established', makerCookies: makerCookie.length, reviewerCookies: reviewerCookie.length,
      isolated: !makerCookie.some(cookie => reviewerCookie.some(other => other.value === cookie.value)) });
  }

  // 制单员整理资料：先在本地核验附件字节与摘要，再提交新版本。
  async makerPrepare({ amount, purpose, attachment }) {
    await this.maker.assertIdentity();
    let attachmentPayload = null;
    if (attachment) {
      const bytes = await readFile(attachment.path);
      const actual = digest(bytes);
      if (attachment.sha256 && actual !== attachment.sha256) {
        throw new Error(`附件字节与登记摘要不一致：${attachment.path}`);
      }
      attachmentPayload = { name: attachment.name, path: attachment.path, sha256: actual };
    }
    const response = await this.maker.request.post(`${this.portalUrl}/api/payment`, {
      data: { amount, purpose, attachment: attachmentPayload, channel: 'automated' },
    });
    if (!response.ok()) throw new Error(`制单被拒绝：${(await response.json()).error}`);
    const payment = await response.json();
    this.log({ event: 'maker-prepared', user: this.maker.user, version: payment.version,
      snapshot: payment.snapshot, amount, purpose, attachment: attachmentPayload?.name });
    return payment;
  }

  // 规则分流只决定“能不能交另一授权人确认”，敏感事项直接暂停等人工。
  route(payment, channel = 'automated') {
    const verdict = evaluate(payment, { channel });
    this.log({ event: 'policy-evaluated', version: payment.version, snapshot: payment.snapshot, ...verdict });
    if (verdict.decision === 'manual') {
      const halt = new WorkflowHalt(HaltReason.MANUAL_REQUIRED, {
        version: payment.version, snapshot: payment.snapshot, reasons: verdict.reasons,
      });
      this.report.halts.push({ reason: halt.reason, details: halt.details, at: new Date().toISOString() });
      throw halt;
    }
    return verdict;
  }

  // 复核人重新拉取当前资料，确认自己审阅的是哪个（版本, 快照），而不是列表第几行。
  async reviewerObserve() {
    await this.reviewer.assertIdentity();
    const payment = await this.reviewer.fetchPayment();
    // 引擎本地独立复算快照，确认服务端数据与规则模块口径一致后才允许提交。
    if (paymentSnapshot(payment).sha256 !== payment.snapshot) {
      throw new Error('复核上下文复算的快照与门户返回不一致，停止提交');
    }
    this.log({ event: 'reviewer-observed', user: this.reviewer.user,
      version: payment.version, snapshot: payment.snapshot, approved: payment.approved });
    return payment;
  }

  async reviewerSubmit({ observed, decision = 'agree', channel = 'automated', note = '' }) {
    await this.reviewer.assertIdentity();
    const response = await this.reviewer.request.post(`${this.portalUrl}/api/review`, {
      data: {
        version: observed.version,
        snapshot: observed.snapshot,
        confirmed: true,
        decision,
        channel,
        note,
      },
    });
    if (response.status() === 409) {
      const data = await response.json();
      const halt = new WorkflowHalt(HaltReason.VERSION_STALE, {
        reviewedVersion: observed.version,
        reviewedSnapshot: observed.snapshot,
        current: data.current ? { version: data.current.version, snapshot: data.current.snapshot } : null,
        serverMessage: data.error,
      });
      this.report.halts.push({ reason: halt.reason, details: halt.details, at: new Date().toISOString() });
      throw halt;
    }
    if (!response.ok()) {
      const data = await response.json().catch(() => ({}));
      throw new Error(`复核被拒绝：${response.status()} ${data.error || ''}`);
    }
    const result = await response.json();
    this.log({ event: 'review-submitted', user: this.reviewer.user, decision,
      opinion: result.opinion.id, version: result.opinion.version, snapshot: result.opinion.snapshot });
    return result;
  }

  // 恢复流程：重新登录两个角色并对同一份资料重新核对，旧的暂停状态不会被静默继承。
  async resumeAfterRelogin() {
    await this.loginBoth();
    const payment = await this.reviewerObserve();
    this.log({ event: 'resumed-after-relogin', version: payment.version, snapshot: payment.snapshot });
    return payment;
  }

  async auditTrail() {
    const response = await this.reviewer.request.get(`${this.portalUrl}/api/audit`);
    if (!response.ok()) throw new Error('审计数据读取失败');
    return response.json();
  }

  async close() {
    const errors = [];
    for (const session of [this.maker, this.reviewer]) {
      try { await session?.close(); } catch (error) { errors.push(error); }
    }
    await this.browser?.close();
    this.report.closedAt = new Date().toISOString();
    if (errors.length) throw errors[0];
  }
}
