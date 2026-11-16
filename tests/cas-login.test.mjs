import test from 'node:test';
import assert from 'node:assert/strict';
import { CasFailure, loginWithCas } from '../cloudflare/cas-login.mjs';

const form = '<form id="loginForm" method="post"><input name="execution" value="e1s1&amp;nonce"><input name="_eventId" value="submit"><input name="submit" value="Login"></form>';
const redirect = location => new Response(null, { status: 302, headers: { Location: location } });
const ticket = 'https://ucloud.bupt.edu.cn/?ticket=ST-offline-ticket-only';
function fixture(mode = 'normal') {
  const calls = [];
  return { calls, request: async (url, options) => {
    assert.equal(options.redirect, 'manual'); calls.push({ url, options });
    const target = new URL(url);
    if (target.hostname === 'auth.bupt.edu.cn') {
      if (options.method === 'POST') {
        const data = new URLSearchParams(options.body);
        assert.equal(data.get('execution'), 'e1s1&nonce');
        assert.equal(data.get('type'), 'username_password');
        assert.equal(data.get('username'), 'offline-account');
        assert.equal(data.get('password'), 'offline-password');
        assert.match(options.headers.Cookie, /JSESSIONID=offline-cookie/);
        return mode === 'rejected' ? new Response(form) : redirect(ticket);
      }
      if (mode === 'sso' || mode === 'stale-sso' && options.headers.Cookie?.includes('TGC=offline-sso')) { assert.equal(options.headers.Cookie, 'TGC=offline-sso'); return redirect(ticket); }
      if (mode === 'cas-down') return new Response('unavailable', { status: 503 });
      if (mode === 'unsafe') return redirect('https://other.example/?ticket=ST-offline-ticket-only');
      if (mode === 'captcha') return new Response(form + '<input name="captcha" value="">');
      if (mode === 'waf') return new Response('<html>browser required</html>', { status: 412 });
      return new Response(form, { headers: { 'Set-Cookie': 'JSESSIONID=offline-cookie; Path=/authserver; Secure; HttpOnly' } });
    }
    assert.equal(target.hostname, 'apiucloud.bupt.edu.cn');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=');
    if (target.pathname.endsWith('/oauth/token')) {
      assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), { grant_type: 'third', ticket: 'ST-offline-ticket-only' });
      if (mode === 'exchange-down') return new Response('temporary gateway failure', { status: 503 });
      if (mode === 'exchange-denied' || mode === 'stale-sso' && !calls.some(call => new URL(call.url).hostname === 'auth.bupt.edu.cn' && call.options.method === 'POST')) return Response.json({ error: 'invalid_grant', error_description: 'private-server-echo-do-not-store' }, { status: 400 });
      return Response.json({ access_token: 'offline-new-access', refresh_token: 'offline-new-refresh', expires_in: 7200 });
    }
    if (mode === 'identity-down') return new Response('temporary failure', { status: 503 });
    assert.equal(options.headers['Blade-Auth'], 'offline-new-access');
    return Response.json({ code: 200, data: { id: mode === 'other-account' ? '8' : '9' } });
  } };
}
const args = { username: 'offline-account', password: 'offline-password', expectedUserId: '9' };

test('normal CAS login obtains a fresh ticket, exchanges it, and verifies the account without forwarding cookies', async () => {
  const f = fixture(); const result = await loginWithCas({ ...args, request: f.request });
  assert.equal(result.access, 'offline-new-access'); assert.equal(result.refresh, 'offline-new-refresh');
  assert.equal(result.userId, '9'); assert.equal(result.expiresIn, 7200); assert.equal(result.cookies.length, 1);
  assert.equal(f.calls.filter(call => call.options.body?.includes('password=')).length, 1);
});
test('an existing SSO session obtains fresh OAuth tokens without submitting a password', async () => {
  const f = fixture('sso'); await loginWithCas({ ...args, request: f.request, cookies: [{ name: 'TGC', value: 'offline-sso', path: '/authserver', expiresAt: 0 }] });
  assert.equal(f.calls.some(call => call.options.body?.includes('password=')), false);
});
test('captcha, browser challenge, and unexpected redirects stop before any password is submitted', async () => {
  for (const [mode, reason] of [['captcha', 'captcha'], ['waf', 'interactive'], ['unsafe', 'unsafe_redirect']]) {
    const f = fixture(mode);
    await assert.rejects(loginWithCas({ ...args, request: f.request }), error => error instanceof CasFailure && error.reason === reason);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, undefined);
  }
});
test('rejected credentials are submitted once; rejected tickets and another account never produce an accepted session', async () => {
  for (const [mode, reason] of [['rejected', 'rejected'], ['exchange-denied', 'ticket_rejected'], ['other-account', 'identity']]) {
    const f = fixture(mode);
    await assert.rejects(loginWithCas({ ...args, request: f.request }), error => error instanceof CasFailure && error.reason === reason);
    assert.equal(f.calls.filter(call => call.options.body?.includes('password=')).length, 1);
  }
});
test('a rejected SSO ticket falls back to one fresh normal login without echoing server error descriptions', async () => {
  const f = fixture('stale-sso');
  const result = await loginWithCas({ ...args, request: f.request, cookies: [{ name: 'TGC', value: 'offline-sso', path: '/authserver', expiresAt: 0 }] });
  assert.equal(result.authMethod, 'password');
  assert.deepEqual(result.ssoFallback, { stage: 'oauth_exchange', httpStatus: 400, authMethod: 'sso', oauthError: 'invalid_grant' });
  assert.equal(JSON.stringify(result).includes('private-server-echo'), false);
  assert.equal(f.calls.filter(call => call.options.body?.includes('password=')).length, 1);
});
test('temporary CAS, exchange, and identity failures retain safe stage and HTTP diagnostics', async () => {
  for (const [mode, reason, stage] of [['cas-down', 'network', 'cas'], ['exchange-down', 'exchange_unavailable', 'oauth_exchange'], ['identity-down', 'identity_unavailable', 'identity']]) {
    const f = fixture(mode);
    await assert.rejects(loginWithCas({ ...args, request: f.request }), error => error.reason === reason && error.details.httpStatus === 503 && error.details.stage === stage);
  }
});
