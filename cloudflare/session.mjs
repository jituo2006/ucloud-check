import { loginWithCas, CasFailure, retryableCasFailure } from './cas-login.mjs';

const API = 'https://apiucloud.bupt.edu.cn/ykt-basics/oauth/token';
const bytes = value => new TextEncoder().encode(value);
const encode = value => btoa(String.fromCharCode(...new Uint8Array(value)));
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export class SessionFailure extends Error {}
export function tokenExpiry(token) {
  try {
    const part = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    const claim = JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4))).exp;
    return typeof claim === 'number' && Number.isFinite(claim) && claim > 0 ? claim * 1000 : 0;
  } catch { return 0; }
}
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
  const credentialSeed = env => digest(JSON.stringify([env.UCLOUD_CAS_USERNAME || '', env.UCLOUD_CAS_PASSWORD || '']));
  const reauthConfigured = env => Boolean(env.UCLOUD_CAS_USERNAME?.trim() && env.UCLOUD_CAS_PASSWORD);
  const expectedIdentity = access => {
    try {
      const part = access.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
      const user = JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4))).user_id;
      return typeof user === 'string' || typeof user === 'number' ? String(user) : '';
    } catch { return ''; }
  };
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
    return { access: env.UCLOUD_TOKEN || '', refresh: env.UCLOUD_REFRESH_TOKEN || '', expiresAt: tokenExpiry(env.UCLOUD_TOKEN || '') };
  };
  const write = async (env, value) => {
    const seed = await seedFor(env), iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytes(seed) }, await keyFor(env), bytes(JSON.stringify(value)));
    await env.DB.prepare("INSERT INTO state(key,value) VALUES ('session',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(JSON.stringify({ seed, iv: encode(iv), data: encode(data) })).run();
  };
  const withLease = async (env, work) => {
    const owner = crypto.randomUUID();
    const lock = await env.DB.prepare("INSERT INTO leases(key,owner,expires_at) VALUES ('session',?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<=?")
      .bind(owner, now() + 60000, now()).run();
    if (!lock.meta.changes) throw new SessionFailure('登录正在刷新，请稍后再试');
    try {
      return await work();
    } finally {
      await env.DB.prepare("DELETE FROM leases WHERE key='session' AND owner=?").bind(owner).run();
    }
  };
  const refresh = (env, failedToken) => withLease(env, async () => {
      const current = await read(env);
      if (current.blocked) throw new SessionFailure('刷新未成功，请重新登录后更新令牌');
      if (failedToken && current.access !== failedToken) return current.access;
      if (!current.refresh) throw new SessionFailure('缺少刷新令牌，请更新云邮会话');
      const refreshExpiresAt = tokenExpiry(current.refresh);
      if (refreshExpiresAt && refreshExpiresAt <= now()) {
        await write(env, { ...current, blocked: true, blockedReason: 'refresh_expired', refreshAttemptAt: now() });
        throw new SessionFailure('刷新令牌已过期，需要重新登录，增加刷新频率不能恢复');
      }
      // Persist intent before a potentially rotating refresh: a lost response is never blindly retried.
      await write(env, { ...current, blocked: true, blockedReason: 'refresh_inflight', refreshAttemptAt: now() });
      let response, body;
      try {
        response = await request(API, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
          headers: { Authorization: clientAuthorization(current.refresh, env.UCLOUD_CLIENT_ID), 'Tenant-Id': '000000', 'Content-Type': 'application/x-www-form-urlencoded',
            ...(current.access ? { 'Blade-Auth': current.access } : {}), ...(env.UCLOUD_IDENTITY ? { identity: env.UCLOUD_IDENTITY } : {}) },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refresh }).toString() });
        body = await response.json();
      } catch {
        await write(env, { ...current, blocked: true, blockedReason: 'refresh_unknown', refreshAttemptAt: now() });
        throw new SessionFailure('刷新结果未确认，请重新登录后更新令牌');
      }
      if (!response.ok || typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token) {
        const oauthErrors = ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'];
        await write(env, { ...current, blocked: true, blockedReason: 'refresh_rejected', refreshAttemptAt: now(),
          refreshHttpStatus: response.status, oauthError: oauthErrors.includes(body?.error) ? body.error : null });
        throw new SessionFailure('平台未接受刷新，请重新登录后更新令牌');
      }
      const ttl = Number(body.expires_in);
      const nextExpiry = tokenExpiry(body.refresh_token);
      await write(env, { ...current, access: body.access_token, refresh: body.refresh_token, refreshedAt: now(),
        blocked: false, blockedReason: null, refreshHttpStatus: null, oauthError: null,
        refreshDeadlineExtended: refreshExpiresAt && nextExpiry ? nextExpiry > refreshExpiresAt : null,
        expiresAt: Number.isFinite(ttl) && ttl > 0 ? now() + ttl * 1000 : 0 });
      return body.access_token;
  });
  const reauthenticate = (env, expectedUserId, { force = false, freshLogin = false } = {}) => withLease(env, async () => {
    const current = await read(env);
    if (!reauthConfigured(env)) throw new SessionFailure('尚未配置统一认证账号密码');
    if (env.UCLOUD_CLIENT_ID && env.UCLOUD_CLIENT_ID !== 'portal') throw new SessionFailure('自动重登需要使用门户客户端');
    const seed = await credentialSeed(env), sameCredentials = current.credentialSeed === seed;
    if (!force && sameCredentials && current.reauthBlocked && !retryableCasFailure(current.reauthFailure)) throw new SessionFailure('自动重登需要本人处理，请检查验证码或更新统一认证凭据');
    if (!force && sameCredentials && current.reauthAttemptedAt && now() - current.reauthAttemptedAt < 30 * 60000) throw new SessionFailure('自动重登已尝试，等待下一维护周期');
    const userId = expectedUserId || expectedIdentity(current.access);
    if (!userId) throw new SessionFailure('缺少已核实的账号，未自动提交登录凭据');
    const pending = { ...current, credentialSeed: seed, reauthAttemptedAt: now(), reauthFailure: 'inflight', reauthFailureDetails: null, reauthBlocked: false };
    await write(env, pending);
    try {
      const result = await loginWithCas({ username: env.UCLOUD_CAS_USERNAME, password: env.UCLOUD_CAS_PASSWORD,
        cookies: !freshLogin && sameCredentials ? current.ssoCookies || [] : [], expectedUserId: userId, request, now });
      const deadline = tokenExpiry(result.refresh), previous = tokenExpiry(current.refresh);
      if (!deadline || deadline <= now()) throw new CasFailure('deadline', '重新认证未取得有效的刷新期限');
      await write(env, { ...pending, access: result.access, refresh: result.refresh, ssoCookies: result.cookies,
        expiresAt: Number.isFinite(result.expiresIn) && result.expiresIn > 0 ? now() + result.expiresIn * 1000 : tokenExpiry(result.access),
        blocked: false, blockedReason: null, refreshHttpStatus: null, oauthError: null,
        reauthenticatedAt: now(), refreshedAt: now(), reauthBlocked: false,
        reauthAuthMethod: result.authMethod, reauthSsoFallback: result.ssoFallback || null,
        reauthFailure: previous && deadline <= previous ? 'deadline_unchanged' : null,
        reauthDeadlineExtended: previous ? deadline > previous : null,
        refreshDeadlineExtended: previous ? deadline > previous : null });
      return result.access;
    } catch (error) {
      const reason = error instanceof CasFailure ? error.reason : 'unknown';
      await write(env, { ...pending, reauthFailure: reason, reauthFailureDetails: error instanceof CasFailure ? error.details : null, reauthBlocked: !retryableCasFailure(reason) });
      throw new SessionFailure(error instanceof CasFailure ? error.message : '自动重登未完成，已保留原会话');
    }
  });
  const recover = async (env, failedToken, expectedUserId) => {
    try { return await refresh(env, failedToken); }
    catch (error) {
      if (env.AUTO_REAUTH !== 'true' || !reauthConfigured(env)) throw error;
      return reauthenticate(env, expectedUserId);
    }
  };
  const maintain = async (env, expectedUserId) => {
    const current = await read(env), deadline = tokenExpiry(current.refresh);
    const lead = Number(env.REAUTH_BEFORE_EXPIRY_MINUTES || 120);
    if (!Number.isInteger(lead) || lead < 30 || lead > 360) throw new SessionFailure('自动重登提前时间无效');
    if (env.AUTO_REAUTH === 'true' && reauthConfigured(env) && (current.blocked || !current.access || !current.refresh || deadline && deadline <= now() + lead * 60000)) {
      try { return await reauthenticate(env, expectedUserId); }
      catch (error) {
        // An unsuccessful proactive login must not discard a still usable refresh session.
        if (current.blocked || !current.access || !current.refresh) throw error;
        if (deadline && deadline <= now()) {
          if (current.expiresAt && current.expiresAt > now() + 120000) return current.access;
          throw error;
        }
      }
    }
    return recover(env, undefined, expectedUserId);
  };
  return { refresh, recover, maintain, reauthenticate, async health(env) {
    try {
      const current = await read(env), deadline = tokenExpiry(current.refresh);
      return { configured: Boolean(current.access && current.refresh), blocked: current.blocked === true,
        reason: deadline && deadline <= now() ? 'refresh_expired' : current.blockedReason || null,
        accessExpiresAt: current.expiresAt || tokenExpiry(current.access) || null, refreshExpiresAt: deadline || null,
        refreshExpired: Boolean(deadline && deadline <= now()), refreshedAt: current.refreshedAt || null,
        refreshAttemptAt: current.refreshAttemptAt || null, refreshDeadlineExtended: current.refreshDeadlineExtended ?? null,
        autoReauthEnabled: env.AUTO_REAUTH === 'true', reauthConfigured: reauthConfigured(env),
        reauthenticatedAt: current.reauthenticatedAt || null, reauthAttemptedAt: current.reauthAttemptedAt || null,
        reauthDeadlineExtended: current.reauthDeadlineExtended ?? null,
        reauthDueAt: env.AUTO_REAUTH === 'true' && reauthConfigured(env) && deadline ? deadline - Number(env.REAUTH_BEFORE_EXPIRY_MINUTES || 120) * 60000 : null,
        reauthFailure: current.reauthFailure || null, reauthBlocked: current.reauthBlocked === true,
        reauthFailureDetails: current.reauthFailureDetails || null, reauthAuthMethod: current.reauthAuthMethod || null,
        reauthSsoFallback: current.reauthSsoFallback || null,
        refreshHttpStatus: current.refreshHttpStatus || null, oauthError: current.oauthError || null };
    } catch { return { configured: false, blocked: true, reason: 'session_unreadable' }; }
  }, async token(env) {
    const current = await read(env);
    if (current.blocked || !current.access) {
      if (env.AUTO_REAUTH === 'true' && reauthConfigured(env)) return reauthenticate(env);
      throw new SessionFailure(current.blocked ? '登录需要更新，请重新配置令牌' : '未配置云邮登录会话');
    }
    return current.expiresAt && current.expiresAt <= now() + 120000 ? recover(env, current.access) : current.access;
  } };
}
