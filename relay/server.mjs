import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eventKey, relayOrigin } from '../public/monitor/core.js';

const folder = new URL('./web/', import.meta.url);
class Failure extends Error { constructor(status, message) { super(message); this.status = status; } }
const equal = (a, b) => {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createRelay({ key, signingKey, publicUrl, stateFile, push, now = Date.now, demo = false }) {
  if (key.length < 32 || signingKey.length < 32) throw new Error('中转密钥和确认签名密钥至少需要 32 个字符');
  const origin = relayOrigin(publicUrl);
  const state = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { events: [] };
  for (const event of state.events) { delete event.notifying; delete event.resultNotifying; }
  const save = () => {
    if (!stateFile) return;
    mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
    writeFileSync(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
    renameSync(stateFile + '.tmp', stateFile);
  };
  const signature = event => createHmac('sha256', signingKey).update(event.id).digest('base64url');
  const tokenFor = event => `${event.id}.${signature(event)}`;
  const findToken = token => {
    if (typeof token !== 'string' || token.length > 200) throw new Failure(403, '确认链接无效');
    const [eventId, signed, ...rest] = token.split('.');
    const event = state.events.find(event => event.id === eventId);
    if (!event || rest.length || !equal(signed, signature(event))) throw new Failure(403, '确认链接无效');
    return event;
  };
  const expire = event => {
    if (['pending', 'confirmed'].includes(event.status) && event.expiresAt <= now()) {
      event.status = 'expired'; save();
    }
    if (event.status === 'processing' && event.expiresAt <= now()) {
      event.status = 'uncertain'; save();
    }
  };
  const view = event => {
    expire(event);
    return { title: event.title, kind: event.kind, expiresAt: event.expiresAt, status: event.status,
      outcome: event.outcome || null, demo };
  };
  const notify = async (event, title, body, withLink = false) => {
    await push({ title, body, group: 'ucloud-check',
      ...(withLink ? { url: origin + '/confirm#' + tokenFor(event) } : {}) });
  };
  const createEvent = async input => {
    if (!['classroom', 'attendance'].includes(input.kind)) throw new Failure(400, '未知事件类型');
    if (typeof input.accountBinding !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.accountBinding)) throw new Failure(400, '缺少会话绑定');
    let dedupe;
    try { dedupe = eventKey(input); } catch { throw new Failure(400, '活动标识无效'); }
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now()) throw new Failure(400, '活动已过期');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100) throw new Failure(400, '课程名称无效');
    let event = state.events.find(event => event.dedupe === dedupe);
    if (!event) {
      // Keep pending events and a bounded deduplication history.
      if (state.events.length >= 1000) {
        state.events = state.events.filter(event => event.expiresAt > now() - 86400000);
        if (state.events.length >= 1000) throw new Failure(429, '活动数量过多，请稍后重试');
      }
      event = { id: randomBytes(18).toString('base64url'), dedupe, kind: input.kind,
        title: input.title, accountBinding: input.accountBinding, siteId: String(input.siteId), groupId: String(input.groupId),
        ...(input.kind === 'attendance' ? { attendanceId: String(input.attendanceId) } : {}),
        createdAt: now(), expiresAt: Math.min(input.expiresAt, now() + 300000),
        status: input.kind === 'attendance' ? 'pending' : 'notice', notified: false };
      state.events.push(event); save();
    }
    expire(event);
    // Prevent simultaneous registration requests from duplicating the push.
    if (!event.notified && !event.notifying && event.expiresAt > now()) {
      event.notifying = true;
      try {
        await notify(event, `${event.title} · ${event.kind === 'attendance' ? '签到已开启' : '课堂已开启'}`,
          event.kind === 'attendance' ? '点击查看本轮签到，由你确认后提交。' : '检测到进行中的课堂。', event.kind === 'attendance');
        event.notified = true;
      } finally { delete event.notifying; save(); }
    }
    return { eventId: event.id, status: event.status, notified: event.notified };
  };

  async function body(request) {
    if (!(request.headers['content-type'] || '').startsWith('application/json')) throw new Failure(415, '需要 JSON 请求');
    const chunks = []; let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 16384) throw new Failure(413, '请求过大');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Failure(400, 'JSON 无效'); }
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const json = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/health') return json(200, { ok: true });
      if (request.method === 'GET' && ['/confirm', '/app.js', '/style.css'].includes(path)) {
        const file = path === '/confirm' ? 'index.html' : path.slice(1);
        response.writeHead(200, { 'Content-Type': path === '/confirm' ? 'text/html; charset=utf-8' : path === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
        return response.end(readFileSync(new URL(file, folder)));
      }
      if (demo && request.method === 'GET' && path === '/demo') {
        const demoInput = { kind: 'attendance', title: '示例课程（模拟）', accountBinding: 'demo-account-binding-01', siteId: '1', groupId: '2', attendanceId: String(now()), expiresAt: now() + 180000 };
        const created = await createEvent(demoInput);
        const event = state.events.find(event => event.id === created.eventId);
        response.writeHead(302, { Location: '/confirm#' + tokenFor(event) });
        return response.end();
      }
      if (request.method !== 'POST') throw new Failure(404, '未找到页面');
      const input = await body(request);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Failure(400, '请求格式无效');
      if (path === '/api/confirmation/view' || path === '/api/confirmation/confirm') {
        const event = findToken(input.token);
        expire(event);
        if (path.endsWith('/confirm')) {
          if (event.kind !== 'attendance') throw new Failure(400, '这不是签到确认');
          if (event.status === 'expired') throw new Failure(410, '本轮确认已过期');
          if (event.status === 'pending') { event.status = 'confirmed'; event.confirmedAt = now(); save(); }
        }
        return json(200, view(event));
      }
      if (!equal(request.headers.authorization, `Bearer ${key}`)) throw new Failure(401, '中转连接未授权');
      if (path === '/api/events') return json(200, await createEvent(input));
      if (path === '/api/commands/claim') {
        for (const event of state.events) expire(event);
        const event = state.events.find(event => event.status === 'confirmed');
        if (!event) return json(200, { commands: [] });
        event.status = 'processing'; event.claimedAt = now(); save();
        return json(200, { commands: [{ id: event.id, siteId: event.siteId, groupId: event.groupId,
          accountBinding: event.accountBinding, attendanceId: event.attendanceId, expiresAt: event.expiresAt }] });
      }
      if (path === '/api/results') {
        const event = state.events.find(event => event.id === input.commandId);
        if (!event || !['processing', 'uncertain', 'done'].includes(event.status)) throw new Failure(409, '没有对应的已领取确认');
        if (!['accepted', 'failed', 'unknown'].includes(input.outcome)) throw new Failure(400, '结果无效');
        if (event.outcome && event.outcome !== input.outcome) throw new Failure(409, '结果已记录');
        event.status = 'done'; event.outcome = input.outcome; save();
        if (!event.resultNotified && !event.resultNotifying) {
          event.resultNotifying = true;
          try {
            const text = { accepted: '平台已接受本次签到请求；可在云邮查看记录。', failed: '未提交签到：活动状态或会话校验未通过，请手动处理。', unknown: '签到结果未确认，请查看云邮记录；不会自动重试提交。' }[input.outcome];
            await notify(event, event.title + ' · 签到处理结果', text);
            event.resultNotified = true;
          } finally { delete event.resultNotifying; save(); }
        }
        return json(200, { ok: true });
      }
      throw new Failure(404, '接口不存在');
    } catch (error) {
      if (!response.headersSent) json(error instanceof Failure ? error.status : 502,
        { error: error instanceof Failure ? error.message : '通知服务暂不可用，请稍后重试' });
      else response.end();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const demo = process.argv.includes('--demo');
  const port = Number(process.env.PORT || 8787);
  const publicUrl = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`;
  const server = createRelay({
    key: demo ? randomBytes(32).toString('hex') : process.env.RELAY_KEY || '',
    signingKey: demo ? randomBytes(32).toString('hex') : process.env.CONFIRM_SECRET || '',
    publicUrl, stateFile: demo ? undefined : resolve(process.env.STATE_FILE || 'relay/data/state.json'), demo,
    push: async payload => {
      if (demo) return; // Demo never sends Bark or platform requests.
      if (!process.env.BARK_DEVICE_KEY) throw new Error('未配置 Bark');
      const response = await fetch('https://api.day.app/push', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, device_key: process.env.BARK_DEVICE_KEY }),
      });
      if (!response.ok || (await response.json()).code !== 200) throw new Error('Bark 未接受推送');
    },
  });
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    console.log(`UCloud confirmation relay listening on port ${port}${demo ? ' (offline demo: /demo)' : ''}`);
  });
}
