const API = 'https://apiucloud.bupt.edu.cn/ykt-basics/oauth/token';
const bytes = value => new TextEncoder().encode(value);
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value)));
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export class SessionFailure extends Error {}
export function clientAuthorization(token, configured) {
  let client = configured;
  if (!client) {
    try { client = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).client_id; }
    catch { /* Opaque tokens use the original web client's default. */ }
  }
  if (!client || client === 'sword') return 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0';
  if (client === 'portal') return 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=';
  throw new SessionFailure('登录客户端类型未适配，请重新核实会话来源');
}

// D1 stores only an authenticated ciphertext. The encryption key stays in Worker Secrets.
export function createSession({ request = fetch, now = Date.now } = {}) {
  const digest = async value => encode(await crypto.subtle.digest('SHA-256', bytes(value)));
  const keyFor = async env => {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new SessionFailure('未配置会话加密密钥');
    return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', bytes(env.SESSION_SECRET)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  };
  const seedFor = env => digest(JSON.stringify([env.UCLOUD_TOKEN || '', env.UCLOUD_REFRESH_TOKEN || '', env.UCLOUD_CLIENT_ID || '']));
  const read = async env => {
    const row = await env.DB.prepare("SELECT value FROM state WHERE key='session'").first();
    const seed = await seedFor(env);
    if (row) {
      const wrapper = JSON.parse(row.value);
      if (wrapper.seed === seed) {
        try {
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(wrapper.iv), additionalData: bytes(seed) }, await keyFor(env), decode(wrapper.data));
          return JSON.parse(new TextDecoder().decode(plain));
        } catch { throw new SessionFailure('会话无法解密，请恢复原会话密钥或重新配置令牌'); }
      }
    }
    return { access: env.UCLOUD_TOKEN || '', refresh: env.UCLOUD_REFRESH_TOKEN || '', expiresAt: 0 };
  };
  const write = async (env, value) => {
    const seed = await seedFor(env), iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytes(seed) }, await keyFor(env), bytes(JSON.stringify(value)));
    await env.DB.prepare("INSERT INTO state(key,value) VALUES ('session',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(JSON.stringify({ seed, iv: encode(iv), data: encode(data) })).run();
  };
  const refresh = async (env, failedToken) => {
    const owner = crypto.randomUUID();
    const lock = await env.DB.prepare("INSERT INTO leases(key,owner,expires_at) VALUES ('session',?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<=?")
      .bind(owner, now() + 60000, now()).run();
    if (!lock.meta.changes) throw new SessionFailure('登录正在刷新，请稍后再试');
    try {
      const current = await read(env);
      if (current.blocked) throw new SessionFailure('刷新未成功，请重新登录后更新令牌');
      if (failedToken && current.access !== failedToken) return current.access;
      if (!current.refresh) throw new SessionFailure('缺少刷新令牌，请更新云邮会话');
      // Persist intent before a potentially rotating refresh: a lost response is never blindly retried.
      await write(env, { ...current, blocked: true });
      let response, body;
      try {
        response = await request(API, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
          headers: { Authorization: clientAuthorization(current.refresh, env.UCLOUD_CLIENT_ID), 'Tenant-Id': '000000', 'Content-Type': 'application/x-www-form-urlencoded',
            ...(current.access ? { 'Blade-Auth': current.access } : {}), ...(env.UCLOUD_IDENTITY ? { identity: env.UCLOUD_IDENTITY } : {}) },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refresh }).toString() });
        body = await response.json();
      } catch { throw new SessionFailure('刷新结果未确认，请重新登录后更新令牌'); }
      if (!response.ok || typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token)
        throw new SessionFailure('平台未接受刷新，请重新登录后更新令牌');
      const ttl = Number(body.expires_in);
      await write(env, { access: body.access_token, refresh: body.refresh_token,
        expiresAt: Number.isFinite(ttl) && ttl > 0 ? now() + ttl * 1000 : 0 });
      return body.access_token;
    } finally {
      await env.DB.prepare("DELETE FROM leases WHERE key='session' AND owner=?").bind(owner).run();
    }
  };
  return { refresh, async token(env) {
    const current = await read(env);
    if (current.blocked) throw new SessionFailure('登录需要更新，请重新配置令牌');
    if (!current.access) throw new SessionFailure('未配置云邮登录会话');
    return current.expiresAt && current.expiresAt <= now() + 120000 ? refresh(env, current.access) : current.access;
  } };
}
