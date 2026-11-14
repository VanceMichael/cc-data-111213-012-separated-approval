const query = selector => document.querySelector(selector);
async function api(path, value) {
  const response = await fetch(path, value === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.status || '操作未接纳');
  return data;
}
function notice(value) { query('#notice').textContent = typeof value === 'string' ? value : JSON.stringify(value); }
window.addEventListener('unhandledrejection', event => { event.preventDefault(); notice(event.reason.message); });

// 页面只缓存“当前审阅到的版本”，提交复核时原样回传；服务端按版本号+快照双绑定判定。
let observed = null;
async function refresh() {
  const data = await api('/api/payment');
  observed = { version: data.version, snapshot: data.snapshot };
  query('#payment-id').textContent = data.id;
  query('#version').textContent = `资料版本 ${data.version}，复核 ${data.approved ? '已完成' : '未完成'}`;
  query('#snapshot').textContent = data.snapshot;
  query('#amount').value = data.amount;
  query('#purpose').value = data.purpose || '';
  query('#attachment').textContent = data.attachment
    ? `${data.attachment.name}（${data.attachment.sha256.slice(0, 12)}…）` : '无附件';
  query('#policy').textContent =
    `${data.policy.decision === 'manual' ? '人工处理' : '可交另一授权人复核'}${data.policy.reasons.length ? '：' + data.policy.reasons.join('；') : ''}`;
  query('#confirm').checked = false;
  const opinions = await api('/api/review');
  query('#opinions').textContent = opinions.length
    ? opinions.map(item =>
        `${item.current ? '[当前版本]' : '[已失效]'} ${item.at} ${item.user} 对版本 ${item.version} ` +
        `快照 ${item.snapshot.slice(0, 12)}… 的${item.decision === 'agree' ? '同意' : '暂缓'}意见（${item.channel}）`).join('\n')
    : '暂无复核意见';
  const state = await api('/api/state');
  query('#audit').textContent = JSON.stringify(state.audit, null, 2);
}
query('#login').onclick = async () => {
  const user = await api('/api/login', { user: query('#user').value, channel: 'browser' });
  query('#identity').textContent = `${user.id} ${user.role}`;
  await refresh();
  notice('身份已由服务端会话核验');
};
query('#logout').onclick = async () => {
  await api('/api/logout', {});
  query('#identity').textContent = '';
  observed = null;
  notice('会话已注销，请重新登录后重新核对');
};
query('#edit').onclick = async () => {
  await api('/api/payment', {
    amount: Number(query('#amount').value), purpose: query('#purpose').value,
  });
  await refresh();
  notice('资料已更新，新版本会使旧复核意见失效');
};
query('#approve').onclick = async () => {
  if (!observed) return notice('请先刷新并审阅当前版本');
  await api('/api/review', {
    version: observed.version, snapshot: observed.snapshot,
    confirmed: query('#confirm').checked, decision: 'agree', channel: 'browser',
  });
  await refresh();
  notice('复核意见已登记并绑定所审阅版本');
};
query('#refresh').onclick = refresh;
notice('请使用演练身份登录');
