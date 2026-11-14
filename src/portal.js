import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { evaluate, paymentSnapshot, opinionIsCurrent, AMOUNT_LIMIT } from './policy.js';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function startPortal(options = {}) {
  const state = JSON.parse(await readFile('fixtures/state.json', 'utf8'));
  const sessions = new Map();
  const audit = [];
  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const record = (entry) =>
    audit.push({ seq: audit.length + 1, at: new Date().toISOString(), ...entry });

  const paymentView = () => {
    const snapshot = paymentSnapshot(state.payment).sha256;
    const policy = evaluate(state.payment);
    return { ...state.payment, snapshot, policy };
  };
  const opinionsView = () =>
    state.opinions.map(opinion => ({
      ...opinion,
      current: opinionIsCurrent(opinion, state.payment),
    }));

  const submitReview = async (identity, body) => {
    if (identity.role !== 'reviewer' || identity.id === state.payment.maker) {
      return { status: 403, value: { error: '需要独立复核身份' } };
    }
    const expectedSnapshot = paymentSnapshot(state.payment).sha256;
    if (!body.confirmed) return { status: 409, value: { error: '复核人尚未确认当前版本' } };
    if (body.version !== state.payment.version || body.snapshot !== expectedSnapshot) {
      record({
        action: 'review-stale',
        user: identity.id,
        role: identity.role,
        version: body.version,
        snapshot: body.snapshot || null,
        details: { currentVersion: state.payment.version, currentSnapshot: expectedSnapshot },
      });
      return {
        status: 409,
        value: { error: '复核依据的版本已失效，请重新审阅当前版本', current: paymentView() },
      };
    }
    const decision = body.decision === 'hold' ? 'hold' : 'agree';
    const policy = evaluate(state.payment, { channel: body.channel });
    if (decision === 'agree' && policy.decision === 'manual') {
      record({
        action: 'review-blocked',
        user: identity.id,
        role: identity.role,
        version: state.payment.version,
        snapshot: expectedSnapshot,
        details: { reasons: policy.reasons, channel: body.channel || 'browser' },
      });
      return { status: 403, value: { error: '敏感事项必须人工处理，不能由辅助流程确认', policy } };
    }
    const opinion = {
      id: randomUUID(),
      at: new Date().toISOString(),
      user: identity.id,
      role: identity.role,
      version: state.payment.version,
      snapshot: expectedSnapshot,
      decision,
      channel: body.channel === 'manual' ? 'manual' : 'automated',
      note: body.note ? String(body.note) : '',
    };
    state.opinions.push(opinion);
    if (decision === 'agree') state.payment.approved = true;
    record({
      action: decision === 'agree' ? 'approve' : 'hold',
      user: identity.id,
      role: identity.role,
      version: opinion.version,
      snapshot: opinion.snapshot,
      details: { opinion: opinion.id, channel: opinion.channel, reasons: policy.reasons },
    });
    return { status: 200, value: { opinion: { ...opinion, current: true }, payment: paymentView(), policy } };
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const buffers = [];
      for await (const part of request) buffers.push(part);
      const raw = Buffer.concat(buffers);
      let body = {};
      if (raw.length) {
        try { body = JSON.parse(raw); }
        catch { return json(response, { error: '请求体不是合法 JSON' }, 400); }
      }
      const token = /session=([^;]+)/.exec(request.headers.cookie || '')?.[1];
      const identity = sessions.get(token);

      // 演练控制接口：清空会话用于模拟“会话过期”，其余字段仍允许测试直接改写状态。
      if (request.method === 'POST' && url.pathname === '/api/control') {
        if (body.resetSessions) sessions.clear();
        const { resetSessions: _ignored, ...patch } = body;
        Object.assign(state, patch);
        record({ action: 'control', user: identity?.id || null, details: { resetSessions: Boolean(body.resetSessions) } });
        return json(response, { ok: true });
      }

      // 只读审计入口：只接受 GET，不要求登录，也不提供任何写操作。
      if (url.pathname === '/api/audit') {
        if (request.method !== 'GET') return json(response, { error: '审计页只读' }, 405);
        return json(response, {
          payment: paymentView(),
          opinions: opinionsView(),
          audit,
          users: state.users,
        });
      }
      if (url.pathname === '/api/state') {
        return json(response, { ...state, payment: paymentView(), opinions: opinionsView(), identity, audit });
      }

      if (url.pathname === '/api/login' && request.method === 'POST') {
        const user = state.users.find(value => value.id === body.user);
        if (!user) return json(response, { error: '身份不存在' }, 401);
        const session = randomUUID();
        sessions.set(session, user);
        response.setHeader('set-cookie', `session=${session}; HttpOnly; SameSite=Strict; Path=/`);
        record({ action: 'login', user: user.id, role: user.role, details: { channel: body.channel || 'browser' } });
        return json(response, user);
      }
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        if (token) sessions.delete(token);
        response.setHeader('set-cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        record({ action: 'logout', user: identity?.id || null, role: identity?.role || null });
        return json(response, { ok: true });
      }
      if (url.pathname === '/api/identity') {
        return json(response, identity || { error: '请登录' }, identity ? 200 : 401);
      }

      if (url.pathname === '/api/payment') {
        if (!identity) return json(response, { error: '请登录' }, 401);
        if (request.method === 'GET') return json(response, paymentView());
        if (identity.role !== 'maker') return json(response, { error: '仅制单员可改资料' }, 403);
        const before = { ...state.payment };
        const patch = {};
        if (body.amount !== undefined) {
          const amount = Number(body.amount);
          if (!Number.isFinite(amount) || amount <= 0) return json(response, { error: '金额不合法' }, 400);
          patch.amount = amount;
        }
        if (body.purpose !== undefined) patch.purpose = String(body.purpose);
        if (body.attachment !== undefined) {
          if (body.attachment === null) {
            patch.attachment = null;
          } else {
            const sha256 = String(body.attachment.sha256 || '');
            if (!/^[a-f0-9]{64}$/.test(sha256)) return json(response, { error: '附件摘要格式不正确' }, 400);
            patch.attachment = {
              name: String(body.attachment.name || '未命名附件'),
              path: body.attachment.path ? String(body.attachment.path) : undefined,
              sha256,
            };
          }
        }
        state.payment = {
          ...state.payment,
          ...patch,
          version: state.payment.version + 1,
          maker: identity.id,
          approved: false,
        };
        // 金额或附件改变即构成新版本：旧复核意见原样保留，但通过快照比对判定为失效。
        const changed =
          before.amount !== state.payment.amount ||
          digest(Buffer.from(JSON.stringify(before.attachment || null))) !==
            digest(Buffer.from(JSON.stringify(state.payment.attachment || null)));
        record({
          action: 'edit',
          user: identity.id,
          role: identity.role,
          version: state.payment.version,
          snapshot: paymentSnapshot(state.payment).sha256,
          details: { changed, fields: Object.keys(patch), channel: body.channel || 'browser' },
        });
        return json(response, paymentView());
      }

      if (url.pathname === '/api/policy') {
        if (!identity) return json(response, { error: '请登录' }, 401);
        return json(response, evaluate(state.payment, { channel: body.channel }));
      }

      if (url.pathname === '/api/review') {
        if (!identity) return json(response, { error: '请登录' }, 401);
        if (request.method === 'GET') return json(response, opinionsView());
        const result = await submitReview(identity, body);
        return json(response, result.value, result.status);
      }

      // 兼容旧入口：把“确认复核”转写为带版本与快照绑定的 agree 意见。
      if (url.pathname === '/api/approve' && request.method === 'POST') {
        if (!identity || identity.role !== 'reviewer' || identity.id === state.payment.maker) {
          return json(response, { error: '需要独立复核身份' }, 403);
        }
        const result = await submitReview(identity, { ...body, decision: 'agree' });
        return json(response, result.value, result.status);
      }

      const allowed = {
        '/': ['portal.html', 'text/html; charset=utf-8'],
        '/audit.html': ['audit.html', 'text/html; charset=utf-8'],
        '/client.js': ['client.js', 'text/javascript'],
        '/audit.js': ['audit.js', 'text/javascript'],
        '/service-worker.js': ['service-worker.js', 'text/javascript'],
      };
      if (allowed[url.pathname]) {
        const [name, type] = allowed[url.pathname];
        response.setHeader('content-type', type);
        response.setHeader('cache-control', 'no-cache');
        return response.end(await readFile(`fixtures/portal/${name}`));
      }
      json(response, { error: '没有这个入口' }, 404);
    } catch (error) {
      json(response, { error: error.message }, 500);
    }
  });
  await new Promise(resolve => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    audit,
    sessions,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

if (process.argv[1]?.endsWith('/portal.js')) {
  const portIndex = process.argv.indexOf('--port');
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  const portal = await startPortal({ port });
  console.log(`本地门户：${portal.url}`);
  console.log(`只读审计页：${portal.url}/audit.html`);
  console.log(`敏感金额阈值：${AMOUNT_LIMIT}`);
}
