const AUTH = 'https://auth.bupt.edu.cn';
const SERVICE = 'https://ucloud.bupt.edu.cn/';
const API = 'https://apiucloud.bupt.edu.cn';
const LOGIN = `${AUTH}/authserver/login?service=${encodeURIComponent(SERVICE.slice(0, -1))}`;
const PORTAL_AUTH = 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=';

export class CasFailure extends Error {
  constructor(reason, message, details = null) { super(message); this.reason = reason; this.details = details; }
}
export const retryableCasFailure = reason => ['network', 'exchange', 'exchange_unavailable', 'ticket_rejected', 'identity_unavailable'].includes(reason);
const fail = (reason, message, details) => { throw new CasFailure(reason, message, details); };
const unescape = value => value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
  const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  return named[entity.toLowerCase()] ?? String.fromCodePoint(entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10));
});
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
  .map(match => [match[1].toLowerCase(), unescape(match[2] ?? match[3] ?? match[4])]));

async function loginOnce({ username, password, cookies = [], expectedUserId, request = fetch, now = Date.now, deadline }) {
  if (!expectedUserId) fail('identity_missing', '自动登录缺少已核实的账号标识');
  const jar = new Map(cookies.filter(cookie => cookie && /^[\w.-]+$/.test(cookie.name) && typeof cookie.value === 'string' && !/[\r\n;]/.test(cookie.value) && (!cookie.expiresAt || cookie.expiresAt > now()))
    .map(cookie => [`${cookie.name}|${cookie.path}`, cookie]));
  const remember = response => {
    const values = response.headers.getSetCookie?.() ?? (response.headers.get('set-cookie') || '').split(/,(?=\s*[^;,\s]+=)/);
    for (const raw of values) {
      const parts = raw.split(';').map(part => part.trim()), equal = parts[0].indexOf('=');
      if (equal < 1) continue;
      const name = parts[0].slice(0, equal), value = parts[0].slice(equal + 1);
      if (!/^[\w.-]+$/.test(name) || /[\r\n;]/.test(value)) continue;
      const options = Object.fromEntries(parts.slice(1).map(part => { const index = part.indexOf('='); return index < 0 ? [part.toLowerCase(), ''] : [part.slice(0, index).toLowerCase(), part.slice(index + 1)]; }));
      if (options.domain && !['auth.bupt.edu.cn', '.auth.bupt.edu.cn', 'bupt.edu.cn', '.bupt.edu.cn'].includes(options.domain.toLowerCase())) continue;
      const path = options.path?.startsWith('/') ? options.path : '/authserver';
      const expiresAt = options['max-age'] !== undefined ? now() + Number(options['max-age']) * 1000 : options.expires ? Date.parse(options.expires) : 0;
      const key = `${name}|${path}`;
      if (!value || (expiresAt && expiresAt <= now())) jar.delete(key);
      else jar.set(key, { name, value, path, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 });
    }
  };
  const send = async (url, options = {}, auth = false) => {
    const target = new URL(url);
    if (target.username || target.password || target.protocol !== 'https:' || target.origin !== (auth ? AUTH : API)) fail('unsafe_redirect', '登录跳转目标未通过核验');
    const cookie = auth ? [...jar.values()].filter(item => (!item.expiresAt || item.expiresAt > now()) && (target.pathname === item.path || target.pathname.startsWith(item.path.endsWith('/') ? item.path : item.path + '/'))).map(item => `${item.name}=${item.value}`).join('; ') : '';
    let response;
    try {
      const remaining = deadline - now();
      if (remaining <= 0) fail('network', '统一认证请求超时，保留现有会话');
      response = await request(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(Math.min(12000, remaining)), headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } });
    }
    catch { fail('network', '统一认证请求未完成，保留现有会话'); }
    if (auth) remember(response);
    return response;
  };
  let response = await send(LOGIN, {}, true), currentUrl = LOGIN, submitted = false, ticket;
  for (let step = 0; step < 8; step++) {
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) fail('protocol', '统一认证缺少跳转地址');
      const target = new URL(location, currentUrl);
      await response.body?.cancel();
      if (target.origin === new URL(SERVICE).origin && target.pathname === '/') {
        ticket = target.searchParams.get('ticket');
        if (!ticket || !/^ST-[A-Za-z0-9._-]{8,4096}$/.test(ticket)) fail('protocol', '统一认证没有返回有效 ticket');
        break;
      }
      if (target.origin !== AUTH || target.protocol !== 'https:') fail('unsafe_redirect', '登录跳转目标未通过核验');
      currentUrl = target.href;
      response = await send(currentUrl, {}, true);
      continue;
    }
    if (!response.ok) {
      if (response.status >= 500 || [408, 429].includes(response.status)) fail('network', '统一认证暂不可用，稍后自动重试', { stage: 'cas', httpStatus: response.status });
      fail('interactive', '统一认证需要浏览器或本人验证，保留现有会话', { stage: 'cas', httpStatus: response.status });
    }
    const html = await response.text();
    if (html.length > 1024 * 1024) fail('protocol', '统一认证页面超出预期');
    if (/config\.captcha\s*=\s*(?:true|\{)|<input\b[^>]*\bname\s*=\s*["']captcha["']/i.test(html)) fail('captcha', '统一认证要求验证码，请本人完成验证');
    if (submitted) fail('rejected', '统一认证未接受登录，已停止继续尝试密码');
    if (!username || !password) fail('credentials_missing', '统一认证会话已失效，尚未配置账号密码');
    const form = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].find(match => attributes(match[1]).id === 'loginForm');
    if (!form) fail('interactive', '统一认证需要浏览器或本人验证，保留现有会话');
    const action = new URL(attributes(form[1]).action || currentUrl, currentUrl);
    if (action.origin !== AUTH || action.pathname !== '/authserver/login' || action.protocol !== 'https:') fail('unsafe_redirect', '登录表单目标未通过核验');
    const fields = new URLSearchParams();
    for (const match of form[2].matchAll(/<input\b[^>]*>/gi)) {
      const item = attributes(match[0]);
      if (['execution', '_eventId', 'submit'].includes(item.name)) fields.set(item.name, item.value || '');
    }
    if (!fields.get('execution') || fields.get('_eventId') !== 'submit') fail('protocol', '统一认证表单已变化，未提交密码');
    fields.set('username', username.trim()); fields.set('password', password); fields.set('type', 'username_password');
    submitted = true; currentUrl = action.href;
    response = await send(currentUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: AUTH, Referer: LOGIN }, body: fields.toString() }, true);
  }
  if (!ticket) fail('protocol', '统一认证未完成，保留现有会话');
  response = await send(`${API}/ykt-basics/oauth/token`, { method: 'POST', headers: { Authorization: PORTAL_AUTH, 'Tenant-Id': '000000', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'third', ticket }).toString() });
  const details = { stage: 'oauth_exchange', httpStatus: response.status, authMethod: submitted ? 'password' : 'sso' };
  let body;
  try { body = await response.json(); } catch { fail('exchange_unavailable', '平台暂未返回有效的新会话，稍后自动重试', details); }
  if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token || typeof body?.refresh_token !== 'string' || !body.refresh_token) {
    // Never persist error_description: the service may echo credentials or tokens there.
    const allowed = ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'];
    details.oauthError = allowed.includes(body?.error) ? body.error : null;
    if (body?.error === 'invalid_grant') fail('ticket_rejected', '平台未接受统一认证 ticket，将重新获取登录凭据', details);
    fail('exchange_unavailable', '平台换取会话暂未成功，稍后自动重试', details);
  }
  const infoResponse = await send(`${API}/ykt-basics/info`, { headers: { Authorization: PORTAL_AUTH, 'Tenant-Id': '000000', 'Blade-Auth': body.access_token } });
  let info;
  try { info = await infoResponse.json(); } catch { fail('identity_unavailable', '新会话账号暂未能核实，稍后自动重试', { stage: 'identity', httpStatus: infoResponse.status }); }
  if (!infoResponse.ok || Number(info?.code) !== 200 || !info?.data?.id) fail('identity_unavailable', '新会话账号暂未能核实，稍后自动重试', { stage: 'identity', httpStatus: infoResponse.status });
  if (String(info.data.id) !== String(expectedUserId)) fail('identity', '新会话与原账号不一致，未替换当前登录', { stage: 'identity', httpStatus: infoResponse.status });
  return { access: body.access_token, refresh: body.refresh_token, expiresIn: Number(body.expires_in), cookies: [...jar.values()], userId: String(info.data.id), authMethod: submitted ? 'password' : 'sso' };
}

export async function loginWithCas(options) {
  const deadline = (options.now || Date.now)() + 40000;
  try { return await loginOnce({ ...options, deadline }); }
  catch (error) {
    if (!(error instanceof CasFailure) || error.reason !== 'ticket_rejected' || error.details?.authMethod !== 'sso' || !options.username || !options.password) throw error;
    // A stale SSO ticket is not evidence of a bad password. Try a fresh normal login once.
    const result = await loginOnce({ ...options, cookies: [], deadline });
    return { ...result, ssoFallback: error.details };
  }
}
