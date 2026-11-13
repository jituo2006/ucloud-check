const token = location.hash.slice(1);
history.replaceState(null, '', '/confirm');
const button = document.querySelector('#confirm');
const output = document.querySelector('#result');
const descriptions = {
  pending: '你确认后，电脑插件会重新核对这轮签到是否仍然有效。',
  confirmed: '已收到你的确认，等待电脑插件处理。后台调度可能延迟，请留意剩余时间。',
  processing: '电脑已领取确认，正在处理。请勿重复提交。',
  uncertain: '有效期已过，电脑尚未回传结果。请查看云邮记录，系统不会再次提交。',
  expired: '本轮确认已过期，请在云邮中查看当前签到状态。',
  done: '本次确认已处理。', notice: '这是一条课堂提醒。',
};
const outcomes = { accepted: '平台已接受签到请求；可在云邮查看记录。', verified: '本轮签到请求及到课记录已核实。', already_signed: '本轮已有到课记录，未重复提交。', failed: '活动或会话校验未通过，未提交签到，请手动处理。', unknown: '结果未确认，请查看云邮记录。系统不会自动重试提交。' };
let timer;
async function request(action) {
  const response = await fetch('/api/confirmation/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '暂时无法连接确认服务');
  return data;
}
function render(data) {
  const cloud = data.executionHost === 'cloud';
  const description = cloud ? {
    ...descriptions,
    pending: '你确认后，云端服务会重新核对这轮签到是否仍然有效。',
    confirmed: '已收到你的确认，云端服务正在安排处理。',
    processing: '云端服务正在核对并处理本轮签到，请勿重复提交。',
  }[data.status] : descriptions[data.status];
  document.querySelector('#title').textContent = data.title;
  document.querySelector('#description').textContent = (data.demo ? '模拟预览：不会发送通知或签到。' : '') + description;
  if (cloud) document.querySelector('.footer').textContent = '本轮由云端服务处理，无需 Mac 在线。最终状态以云邮记录为准；链接过期后不再提交。';
  document.querySelector('#expiry').textContent = '确认有效至 ' + new Date(data.expiresAt).toLocaleString('zh-CN');
  button.disabled = data.status !== 'pending' || data.expiresAt <= Date.now() || data.submissionEnabled === false;
  button.hidden = data.kind !== 'attendance';
  button.textContent = data.status === 'pending' ? '确认签到' : data.status === 'expired' ? '确认已过期' : '已确认';
  if (data.status === 'pending' && data.submissionEnabled === false) {
    button.textContent = '处理暂未启用';
    document.querySelector('#description').textContent = '当前签到处理已暂停，请在云邮中手动处理。';
  }
  output.textContent = outcomes[data.outcome] || '';
  clearTimeout(timer);
  if (!['done', 'expired', 'notice', 'uncertain'].includes(data.status)) timer = setTimeout(load, 4000);
}
async function load() {
  try { render(await request('view')); }
  catch (error) { button.disabled = true; output.textContent = error.message; }
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try { render(await request('confirm')); }
  catch (error) { output.textContent = error.message; await load(); }
});
if (token) void load();
else { document.querySelector('#title').textContent = '需要本轮确认链接'; output.textContent = '请从 Bark 通知中的链接打开。'; }
