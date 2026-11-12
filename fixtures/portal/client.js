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

let version;
async function refresh(){const data=await api('/api/payment');version=data.version;query('#version').textContent=`资料版本 ${version}，复核 ${data.approved?'已完成':'未完成'}`;query('#amount').value=data.amount;query('#confirm').checked=false;query('#audit').textContent=JSON.stringify((await api('/api/state')).audit);}
query('#login').onclick=async()=>{const user=await api('/api/login',{user:query('#user').value});query('#identity').textContent=`${user.id} ${user.role}`;await refresh();notice('身份已核验');};
query('#edit').onclick=async()=>{await api('/api/payment',{amount:Number(query('#amount').value)});await refresh();notice('资料已更新');};
query('#approve').onclick=async()=>{await api('/api/approve',{version,confirmed:query('#confirm').checked});await refresh();notice('复核已登记');};
query('#refresh').onclick=refresh;
notice('请使用演练身份登录');
