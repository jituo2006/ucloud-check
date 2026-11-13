import { activeAttendance, confirmedUnsigned, eventKey, id, relayOrigin, unwrap } from '../public/monitor/core.js';
import { createSession, SessionFailure, clientAuthorization } from './session.mjs';
import { monitoringDue } from './schedule.mjs';
import { summarizeAttendance } from './attendance-probe.mjs';
import { pluginActivity, matchingRecord } from './plugin-signing.mjs';

const API = 'https://apiucloud.bupt.edu.cn';
const json = (data, status = 200) => Response.json(data, { status });
class Failure extends Error { constructor(status, message) { super(message); this.status = status; } }
const list = value => String(value || '').split(',').map(value => value.trim()).filter(Boolean);
// Older installations used ENABLE_SIGNING for both stages; explicit monitoring overrides that fallback.
const monitorsAttendance = env => env.ENABLE_ATTENDANCE_MONITOR === undefined ? env.ENABLE_SIGNING === 'true' : env.ENABLE_ATTENDANCE_MONITOR === 'true';
const protocolReady = env => env.SIGNING_PROTOCOL === 'plugin' || Boolean(list(env.OPEN_STATUSES).length && env.UNSIGNED_PATH && list(env.UNSIGNED_VALUES).length);

export function createApplication({ request = fetch, now = Date.now } = {}) {
  const session = createSession({ request, now });
  const get = async (env, key) => {
    const row = await env.DB.prepare('SELECT value FROM state WHERE key = ?').bind(key).first();
    return row ? JSON.parse(row.value) : null;
  };
  const put = (env, key, value) => env.DB.prepare('INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, JSON.stringify(value)).run();
  const getEvent = (env, key) => env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(key).first();
  const update = (env, sql, ...values) => env.DB.prepare(sql).bind(...values).run();
  const equal = async (left, right) => {
    const hashes = await Promise.all([left, right].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value || ''))));
    const a = new Uint8Array(hashes[0]), b = new Uint8Array(hashes[1]);
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    return difference === 0;
  };
  const hmacKey = env => {
    if (!env.CONFIRM_SECRET || env.CONFIRM_SECRET.length < 32) throw new Failure(503, '确认服务尚未配置');
    return crypto.subtle.importKey('raw', new TextEncoder().encode(env.CONFIRM_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  };
  const tokenFor = async (env, event) => {
    const signature = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(event.id));
    const encoded = btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    return `${event.id}.${encoded}`;
  };
  const tokenEvent = async (env, token) => {
    if (typeof token !== 'string' || !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Failure(403, '确认链接无效');
    const [eventId, encoded] = token.split('.');
    const signature = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '='), character => character.charCodeAt(0));
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env), signature, new TextEncoder().encode(eventId))) throw new Failure(403, '确认链接无效');
    const event = await getEvent(env, eventId);
    if (!event) throw new Failure(403, '确认链接无效');
    return event;
  };
  const api = async (env, path, method = 'GET', data, envelope = false) => {
    let token;
    try { token = await session.token(env); }
    catch (error) { throw new Failure(401, error instanceof SessionFailure ? error.message : '登录会话暂不可用'); }
    const send = token => request(API + path, {
      // Workers supports manual/follow only. Reject non-2xx below without forwarding credentials.
      method, redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'Blade-Auth': token, Authorization: clientAuthorization(token, env.UCLOUD_CLIENT_ID), 'Tenant-Id': '000000',
        ...(env.UCLOUD_IDENTITY ? { identity: env.UCLOUD_IDENTITY } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    let response = await send(token);
    const readOnly = method === 'GET' || ['/blade-chat/web/chat/myCourse', '/ykt-site/attendancebasicinfo/basic', '/ykt-site/attendancedetailinfo/getUserAttendListBySiteIdAndUserId'].includes(path.split('?')[0]);
    if (response.status === 401 && readOnly) {
      await response.body?.cancel();
      try { token = await session.refresh(env, token); }
      catch (error) { throw new Failure(401, error instanceof SessionFailure ? error.message : '登录刷新暂不可用'); }
      response = await send(token);
    }
    if (response.status === 401) throw new Failure(401, '云邮登录已失效，请更新会话');
    if (!response.ok) throw new Failure(502, '云邮暂不可访问');
    const body = await response.json();
    const value = unwrap(body);
    return envelope ? body : value;
  };
  const bark = async (env, payload) => {
    if (!env.BARK_DEVICE_KEY) throw new Failure(503, '尚未配置 Bark');
    const response = await request('https://api.day.app/push', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, device_key: env.BARK_DEVICE_KEY, group: 'ucloud-check' }),
    });
    if (!response.ok || (await response.json()).code !== 200) throw new Failure(502, 'Bark 未接受推送');
  };
  const courses = async (env, siteIds) => {
    const body = await api(env, '/blade-chat/web/chat/myCourse?siteIds=' + siteIds.join(','), 'POST', {}, true);
    const data = body.data;
    // Verified live: the service returns {} with this explicit message when no class is running.
    if (body.success === true && body.msg === '没有正在上课的课程' && data && !Array.isArray(data) && Object.keys(data).length === 0) return [];
    if (!Array.isArray(data)) throw new Failure(502, '课堂响应尚未校准');
    return data.map(course => ({ siteId: id(course.siteId), groupId: id(course.groupId) }));
  };
  const attendance = async (env, course, sampledData) => {
    const data = sampledData === undefined ? await api(env, '/ykt-site/attendancebasicinfo/basic', 'POST', course) : sampledData;
    if (env.SIGNING_PROTOCOL === 'plugin') return pluginActivity(data, course, now());
    const activity = activeAttendance(data, course, list(env.OPEN_STATUSES), now());
    return activity && confirmedUnsigned(data, env.UNSIGNED_PATH, list(env.UNSIGNED_VALUES)) ? activity : null;
  };
  const notify = async (env, event, result = false) => {
    const field = result ? 'result_notified' : 'notified';
    const timeField = result ? 'result_notify_at' : 'notify_at';
    const claimed = await update(env, `UPDATE events SET ${field}=2,${timeField}=? WHERE id=? AND (${field}=0 OR (${field}=2 AND ${timeField}<?))`, now(), event.id, now() - 60000);
    if (!claimed.meta.changes) return;
    try {
      const descriptions = { accepted: '平台已接受本次签到请求，可在云邮查看记录。', verified: '请求已提交，且本轮到课记录已核实。', already_signed: '本轮已有到课或请假记录，未重复提交。', failed: '活动已变化、已完成或会话校验未通过，请手动处理。', unknown: '结果未确认，请查看云邮记录；不会自动重试提交。' };
      const automatic = env.AUTO_SIGN === 'true' && env.ENABLE_SIGNING === 'true';
      const payload = result ? { title: event.title + ' · 签到处理结果', body: descriptions[event.outcome] } :
        { title: event.title + (event.kind === 'attendance' ? ' · 签到已开启' : ' · 课堂已开启'),
          body: event.kind === 'attendance' ? (automatic ? '检测到签到活动，云端正在自动处理。' : '点击查看本轮活动，由你确认后提交。') : '检测到进行中的课堂。' };
      if (!result && event.kind === 'attendance' && !automatic) payload.url = relayOrigin(env.PUBLIC_BASE_URL) + '/confirm#' + await tokenFor(env, event);
      await bark(env, payload);
      await update(env, `UPDATE events SET ${field}=1 WHERE id=?`, event.id);
    } catch (error) {
      await update(env, `UPDATE events SET ${field}=0 WHERE id=?`, event.id);
      throw error;
    }
  };
  const createEvent = async (env, input, userId) => {
    const key = eventKey({ ...input, accountBinding: userId });
    const created = now();
    await update(env, `INSERT INTO events(id,event_key,kind,title,user_id,site_id,group_id,attendance_id,created_at,expires_at,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`, crypto.randomUUID(), key, input.kind, input.title,
    userId, input.siteId, input.groupId, input.attendanceId || null, created, Math.min(input.expiresAt, created + 300000), input.kind === 'attendance' ? 'pending' : 'notice');
    const event = await env.DB.prepare('SELECT * FROM events WHERE event_key=?').bind(key).first();
    const automatic = input.kind === 'attendance' && env.AUTO_SIGN === 'true' && env.ENABLE_SIGNING === 'true';
    if (event.notified !== 1 && event.expires_at > now()) {
      if (automatic) { try { await notify(env, event); } catch { /* Notification failure does not block an authorized submission. */ } }
      else await notify(env, event);
    }
    if (automatic && event.expires_at > now()) {
      await update(env, "UPDATE events SET status='confirmed' WHERE id=? AND status='pending' AND expires_at>?", event.id, now());
      await execute(env, event.id);
    }
  };
  const expire = async env => {
    await update(env, "UPDATE events SET status='expired' WHERE status IN ('pending','confirmed') AND expires_at<=?", now());
    // A claimed execution is never retried after termination. Its result is unknown.
    await update(env, "UPDATE events SET status='done',outcome='unknown' WHERE status='processing' AND claimed_at<?", now() - 120000);
  };
  const view = async (env, eventId) => {
    await expire(env);
    const event = await getEvent(env, eventId);
    return { title: event.title, kind: event.kind, expiresAt: event.expires_at, status: event.status, outcome: event.outcome,
      demo: false, executionHost: 'cloud', submissionEnabled: env.ENABLED === 'true' && env.ENABLE_SIGNING === 'true' &&
        protocolReady(env) };
  };
  const execute = async (env, eventId) => {
    if (env.ENABLED !== 'true' || env.ENABLE_SIGNING !== 'true') return;
    const claimed = await update(env, "UPDATE events SET status='processing',claimed_at=? WHERE id=? AND status='confirmed' AND expires_at>?", now(), eventId, now());
    if (!claimed.meta.changes) return;
    const event = await getEvent(env, eventId);
    let outcome = 'failed';
    try {
      const user = await api(env, '/ykt-basics/info');
      if (id(user.id) !== event.user_id) throw new Error('会话账号已变化');
      const course = { siteId: event.site_id, groupId: event.group_id };
      const going = await courses(env, [course.siteId]);
      if (!going.some(item => item.siteId === course.siteId && item.groupId === course.groupId)) throw new Error('课堂已结束');
      const current = await attendance(env, course);
      if (!current || current.attendanceId !== event.attendance_id) throw new Error('签到已完成、未知或活动变化');
      let existing = null;
      const readRecords = () => api(env, '/ykt-site/attendancedetailinfo/getUserAttendListBySiteIdAndUserId', 'POST', { siteId: course.siteId, userId: id(user.id), current: 1, size: 10 });
      if (env.SIGNING_PROTOCOL === 'plugin') {
        try { existing = matchingRecord(await readRecords(), current); } catch { /* The original submission protocol does not require the history endpoint. */ }
      }
      if (existing && [11, 12, 13, 22, 23, 24].includes(Number(existing.status))) {
        outcome = 'already_signed';
        await update(env, "UPDATE events SET status='done',outcome=? WHERE id=?", outcome, event.id);
        await notify(env, { ...event, outcome }, true);
        return;
      }
      const clock = await api(env, '/ykt-site/common/v2/clock');
      if (typeof clock?.data !== 'string' || !clock.data) throw new Error('动态参数无效');
      if (event.expires_at <= now() || current.expiresAt <= now()) throw new Error('活动过期');
      outcome = 'unknown';
      await api(env, '/ykt-site/attendancedetailinfo/sign', 'POST', {
        attendanceDetailInfo: { attendanceId: current.attendanceId, siteId: course.siteId, userId: id(user.id), classLessonId: course.groupId },
        qrCodeCreateTime: clock.data,
      });
      outcome = 'accepted';
      if (env.SIGNING_PROTOCOL === 'plugin') {
        try { if ([11, 12, 13].includes(Number(matchingRecord(await readRecords(), current)?.status))) outcome = 'verified'; }
        catch { /* Accepted remains distinct from an independently verified record. */ }
      }
    } catch { /* An unanswered write is never retried or reported as successful. */ }
    await update(env, "UPDATE events SET status='done',outcome=? WHERE id=?", outcome, event.id);
    await notify(env, { ...event, outcome }, true);
  };
  const monitor = async (env, { scheduled = false } = {}) => {
    if (env.ENABLED !== 'true') return;
    const owner = crypto.randomUUID();
    const lease = await update(env, "INSERT INTO leases(key,owner,expires_at) VALUES ('monitor',?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE leases.expires_at<=?", owner, now() + 120000, now());
    if (!lease.meta.changes) return;
    try {
      const timetable = await get(env, 'timetable');
      const scheduleEnv = timetable ? { ...env, SCHEDULE_ONLY: 'true', CLASS_WINDOWS: JSON.stringify(timetable.windows) } : env;
      if (scheduled && !monitoringDue(scheduleEnv, now(), await get(env, 'last-monitor-attempt'), await get(env, 'active-until'))) {
        // With an imported timetable, off-class ticks maintain login only; no classroom scan.
        if (timetable && monitoringDue({ ...env, CLASS_WINDOWS: '[]' }, now(), await get(env, 'last-session-check'), 0)) {
          await put(env, 'last-session-check', now());
          const user = await api(env, '/ykt-basics/info');
          if (id(user.id) !== timetable.userId) throw new Failure(409, '课表账号与当前会话不一致，请重新导入');
          await put(env, 'login-health', { ok: true, updatedAt: now() });
        }
        return;
      }
      await put(env, 'last-monitor-attempt', now());
      relayOrigin(env.PUBLIC_BASE_URL);
      await expire(env);
      const user = await api(env, '/ykt-basics/info');
      const userId = id(user.id);
      if (timetable && userId !== timetable.userId) throw new Failure(409, '课表账号与当前会话不一致，请重新导入');
      await put(env, 'last-session-check', now());
      const sites = await api(env, `/ykt-site/site/list/student/current?userId=${userId}&siteRoleCode=2&current=1&size=9999`);
      if (!Array.isArray(sites?.records)) throw new Failure(502, '课程响应尚未确认');
      const names = new Map(sites.records.map(site => [id(site.id), String(site.siteName || '当前课堂').slice(0, 100)]));
      const going = names.size ? await courses(env, [...names.keys()]) : [];
      await put(env, 'active-until', going.length ? now() + 120000 : 0);
      const previous = await get(env, 'classroom-baseline');
      const baseline = previous?.userId === userId ? previous : { userId, initialized: false, keys: [] };
      const keys = [];
      const calibrated = protocolReady(env);
      let attendanceCandidates = 0;
      // Bound each invocation's subrequests and time; alert rather than silently ignore extras.
      if (going.length > 5) throw new Failure(502, '进行中课堂超过本轮处理上限，请检查课堂响应');
      for (const course of going) {
        if (!names.has(course.siteId)) throw new Failure(502, '课堂不属于当前课程列表');
        const room = { ...course, kind: 'classroom', title: names.get(course.siteId), expiresAt: now() + 300000 };
        const key = eventKey(room); keys.push(key);
        if (baseline.initialized && !baseline.keys.includes(key)) await createEvent(env, room, userId);
        let raw;
        const detectAttendance = monitorsAttendance(env) && calibrated;
        if (env.ENABLE_ATTENDANCE_PROBE === 'true' || detectAttendance) raw = await api(env, '/ykt-site/attendancebasicinfo/basic', 'POST', course);
        if (env.ENABLE_ATTENDANCE_PROBE === 'true') {
          const previous = await get(env, 'attendance-probes');
          const samples = previous?.userId === userId ? previous.samples : [];
          await put(env, 'attendance-probes', { userId, samples: [
            ...samples.filter(sample => sample.siteId !== course.siteId || sample.groupId !== course.groupId),
            { ...course, observedAt: now(), ...summarizeAttendance(raw) },
          ].slice(-10) });
        }
        if (detectAttendance) {
          const current = await attendance(env, course, raw);
          if (current) { attendanceCandidates++; await createEvent(env, { ...current, kind: 'attendance', title: room.title }, userId); }
        }
      }
      await put(env, 'classroom-baseline', { userId, initialized: true, keys });
      const pending = await env.DB.prepare("SELECT id FROM events WHERE status='confirmed' AND expires_at>? LIMIT 1").bind(now()).all();
      for (const event of pending.results) await execute(env, event.id);
      const results = await env.DB.prepare("SELECT * FROM events WHERE status='done' AND result_notified<>1 LIMIT 3").all();
      for (const event of results.results) await notify(env, event, true);
      await update(env, 'DELETE FROM events WHERE expires_at<?', now() - 7 * 86400000);
      await put(env, 'status', { ok: true, updatedAt: now(), courseCount: names.size, activeClasses: going.length, attendanceCandidates, signingReady: Boolean(calibrated && env.ENABLE_SIGNING === 'true') });
    } catch (error) {
      await put(env, 'status', { ok: false, updatedAt: now(), message: error instanceof Failure ? error.message : '监测暂不可用，未自动重试签到' });
      if (error instanceof Failure && error.status === 401) {
        const last = await get(env, 'login-alert');
        if (!last || now() - last > 3600000) {
          await bark(env, { title: '云邮登录需要更新', body: '课堂监测已暂停，请更新云端会话。' });
          await put(env, 'login-alert', now());
        }
      }
    } finally {
      await update(env, "DELETE FROM leases WHERE key='monitor' AND owner=?", owner);
    }
  };
  const admin = async (env, req) => {
    if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 32) throw new Failure(503, '管理接口尚未配置');
    if (!await equal(req.headers.get('Authorization'), `Bearer ${env.ADMIN_KEY}`)) throw new Failure(401, '未授权');
  };
  const fetchHandler = async (req, env, ctx) => {
    try {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET' && path === '/health') return json({ ok: true });
      if (req.method === 'GET' && ['/confirm', '/app.js', '/style.css'].includes(path)) {
        const target = new URL(req.url); if (path === '/confirm') target.pathname = '/index.html';
        return env.ASSETS.fetch(new Request(target));
      }
      if (req.method !== 'POST') throw new Failure(404, '未找到页面');
      if (path.startsWith('/api/admin/')) {
        await admin(env, req);
        if (path === '/api/admin/test-bark') {
          await bark(env, { title: '云邮提醒已连接', body: '这是一条测试通知，没有执行签到。' });
          return json({ ok: true });
        }
        if (path === '/api/admin/status') {
          const timetable = await get(env, 'timetable');
          const probes = await get(env, 'attendance-probes');
          const recent = await env.DB.prepare("SELECT title,attendance_id,status,outcome,created_at,expires_at FROM events WHERE kind='attendance' ORDER BY created_at DESC LIMIT 5").all();
          return json({ enabled: env.ENABLED === 'true', status: await get(env, 'status'), loginHealth: await get(env, 'login-health'),
            recentAttendance: recent.results,
            attendanceMonitoringEnabled: monitorsAttendance(env), submissionEnabled: env.ENABLED === 'true' && env.ENABLE_SIGNING === 'true',
            automaticSigningEnabled: env.AUTO_SIGN === 'true' && env.ENABLE_SIGNING === 'true', signingProtocol: env.SIGNING_PROTOCOL || 'calibrated',
            attendanceProbeEnabled: env.ENABLE_ATTENDANCE_PROBE === 'true', attendanceSamples: probes?.samples || [],
            timetable: timetable ? { term: timetable.term, count: timetable.windows.length, importedAt: timetable.importedAt,
              next: timetable.windows.filter(w => Date.parse(w.end) > now()).slice(0, 3) } : null });
        }
        if (path === '/api/admin/timetable') {
          const text = await req.text();
          if (text.length > 250000) throw new Failure(413, '课表过大');
          let input;
          try { input = JSON.parse(text); } catch { throw new Failure(400, '课表 JSON 无效'); }
          if (!/^\d{4}-\d{4}-[12]$/.test(input?.term || '') || !Array.isArray(input.windows) || !input.windows.length || input.windows.length > 2000) throw new Failure(400, '课表格式无效');
          const windows = input.windows.map(w => {
            const start = Date.parse(w.start), end = Date.parse(w.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || !String(w.start).endsWith('+08:00') || !String(w.end).endsWith('+08:00') || end <= start || end - start > 12 * 3600000) throw new Failure(400, '课程起止时间无效');
            return { start: w.start, end: w.end, title: String(w.title || '课程').slice(0, 100) };
          }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
          const user = await api(env, '/ykt-basics/info');
          await put(env, 'timetable', { userId: id(user.id), term: input.term, importedAt: now(), windows });
          return json({ ok: true, term: input.term, count: windows.length });
        }
        if (path === '/api/admin/refresh-session') {
          const before = await api(env, '/ykt-basics/info');
          try { await session.refresh(env, await session.token(env)); }
          catch (error) { throw new Failure(401, error instanceof SessionFailure ? error.message : '登录刷新暂不可用'); }
          const after = await api(env, '/ykt-basics/info');
          if (id(before.id) !== id(after.id)) throw new Failure(409, '刷新前后账号不一致，请检查会话');
          return json({ ok: true, identityMatches: true });
        }
        if (path === '/api/admin/monitor') { ctx.waitUntil(monitor(env)); return json({ queued: true }); }
        if (path === '/api/admin/attendance-records') {
          const text = await req.text();
          if (text.length > 2048) throw new Failure(413, '请求过大');
          let input;
          try { input = JSON.parse(text || '{}'); } catch { throw new Failure(400, 'JSON 无效'); }
          const user = await api(env, '/ykt-basics/info');
          const userId = id(user.id);
          const sites = await api(env, `/ykt-site/site/list/student/current?userId=${userId}&siteRoleCode=2&current=1&size=9999`);
          if (!Array.isArray(sites?.records)) throw new Failure(502, '课程响应尚未确认');
          const courses = sites.records.map(site => ({ siteId: id(site.id), title: String(site.siteName || '课程').slice(0, 100) }));
          if (!input.siteId) return json({ courses });
          const course = courses.find(course => course.siteId === String(input.siteId));
          if (!course) throw new Failure(403, '只允许查询本人的课程记录');
          const records = await api(env, '/ykt-site/attendancedetailinfo/getUserAttendListBySiteIdAndUserId', 'POST', { siteId: course.siteId, userId, current: 1, size: 10 });
          const rows = Array.isArray(records?.timeAndStatusList) ? records.timeAndStatusList : null;
          const fields = ['id', 'attendanceId', 'classLessonId', 'time', 'status', 'signTime'];
          return json({ course, fields: records && typeof records === 'object' ? Object.keys(records) : [],
            totalCount: records?.totalCount, signCount: records?.signCount,
            records: rows && rows.map(row => Object.fromEntries(fields.filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]]))) });
        }
      }
      if (!['/api/confirmation/view', '/api/confirmation/confirm'].includes(path)) throw new Failure(404, '接口不存在');
      if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) throw new Failure(415, '需要 JSON 请求');
      const text = await req.text();
      if (text.length > 2048) throw new Failure(413, '请求过大');
      let input;
      try { input = JSON.parse(text); } catch { throw new Failure(400, 'JSON 无效'); }
      const event = await tokenEvent(env, input?.token);
      if (path.endsWith('/confirm')) {
        if (env.ENABLED !== 'true' || env.ENABLE_SIGNING !== 'true') throw new Failure(409, '当前未启用签到处理');
        if (event.kind !== 'attendance' || event.expires_at <= now()) throw new Failure(410, '本轮确认已过期或不适用');
        await update(env, "UPDATE events SET status='confirmed' WHERE id=? AND status='pending' AND expires_at>?", event.id, now());
        ctx.waitUntil(execute(env, event.id));
      }
      return json(await view(env, event.id));
    } catch (error) {
      return json({ error: error instanceof Failure ? error.message : '服务暂不可用，请稍后重试' }, error instanceof Failure ? error.status : 502);
    }
  };
  return { monitor, execute,
    async fetch(req, env, ctx) {
      const raw = await fetchHandler(req, env, ctx);
      const response = new Response(raw.body, raw);
      for (const [name, value] of Object.entries({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" })) response.headers.set(name, value);
      return response;
    },
    scheduled(_controller, env, ctx) { ctx.waitUntil(monitor(env, { scheduled: true })); },
  };
}

export default createApplication();
