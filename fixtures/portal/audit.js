const query = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const short = value => value ? `${String(value).slice(0, 16)}…` : '';

async function load() {
  // 审计页只发 GET，且不携带任何写操作参数；登录与否都能只读查看。
  const response = await fetch('/api/audit', { method: 'GET' });
  if (!response.ok) {
    query('#notice').textContent = `审计数据读取失败：${response.status}`;
    return;
  }
  const data = await response.json();
  const p = data.payment;
  query('#payment').innerHTML =
    `<p>资料编号 <code>${escape(p.id)}</code>｜版本 ${p.version}｜金额 ${p.amount}｜复核 ${p.approved ? '已完成' : '未完成'}</p>` +
    `<p>当前快照 <code>${escape(p.snapshot)}</code></p>` +
    `<p>附件 ${p.attachment ? escape(p.attachment.name) + ' <code>' + escape(p.attachment.sha256) + '</code>' : '无'}</p>` +
    `<p>规则结论：${p.policy.decision === 'manual' ? '人工处理' : '可交另一授权人复核'}${p.policy.reasons.length ? '（' + escape(p.policy.reasons.join('；')) + '）' : ''}</p>`;

  query('#opinions tbody').innerHTML = data.opinions.map(item =>
    `<tr><td>${escape(item.at)}</td><td>${escape(item.user)}</td><td>${escape(item.role)}</td>` +
    `<td>v${item.version}</td><td><code>${escape(short(item.snapshot))}</code></td>` +
    `<td>${item.decision === 'agree' ? '同意' : '暂缓'}</td><td>${escape(item.channel)}</td>` +
    `<td class="${item.current ? 'current' : 'stale'}">${item.current ? '对应当前版本' : '已随资料变更失效'}</td></tr>`).join('')
    || '<tr><td colspan="8">暂无复核意见</td></tr>';

  query('#events tbody').innerHTML = data.audit.map(event =>
    `<tr><td>${event.seq}</td><td>${escape(event.at)}</td><td>${escape(event.action)}</td>` +
    `<td>${escape(event.user ?? '')}</td><td>${escape(event.role ?? '')}</td>` +
    `<td>${event.version ? 'v' + event.version : ''}</td>` +
    `<td><code>${escape(short(event.snapshot))}</code></td>` +
    `<td><code>${escape(JSON.stringify(event.details ?? {}))}</code></td></tr>`).join('')
    || '<tr><td colspan="8">暂无事件</td></tr>';
  query('#notice').textContent = `已读取 ${data.audit.length} 条事件、${data.opinions.length} 条复核意见（${new Date().toISOString()}）`;
}
query('#reload').onclick = load;
load();
