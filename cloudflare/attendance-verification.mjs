import { matchingRecord } from './plugin-signing.mjs';
import { id, serverTime } from '../public/monitor/core.js';

const LIMIT = 5;
const INTERVAL = 60000;
const DEADLINE = 10 * INTERVAL;

export async function nextVerificationWake(env, now) {
  if (env.ENABLED !== 'true') return null;
  const row = await env.DB.prepare(`SELECT MIN(CASE WHEN e.status='processing'
    THEN MAX(v.next_at,COALESCE(e.claimed_at,0)+120001) ELSE v.next_at END) AS next_at
    FROM attendance_verifications v JOIN events e ON e.id=v.event_id
    WHERE v.state='pending' AND v.next_at IS NOT NULL AND
    (e.status='processing' OR (e.status='done' AND e.outcome IN ('unknown','accepted')))`
  ).first();
  return Number.isFinite(row?.next_at) ? Math.max(now + 1000, row.next_at) : null;
}

// A verification only reads school records. It never calls the attendance write endpoint.
export function createAttendanceVerifier({ readIdentity, readRecords, readBasic, now = Date.now }) {
  const run = (env, sql, ...values) => env.DB.prepare(sql).bind(...values).run();
  const job = (env, eventId) => env.DB.prepare('SELECT * FROM attendance_verifications WHERE event_id=?').bind(eventId).first();
  const enqueue = (env, event, startedAt = null) => run(env, `INSERT INTO attendance_verifications
    (event_id,started_at,next_at,deadline_at) VALUES (?,?,?,?) ON CONFLICT(event_id) DO NOTHING`,
  event.id, Number.isFinite(startedAt) ? startedAt : null, now() + 120001, now() + DEADLINE);
  const verify = async (env, event, { immediate = false } = {}) => {
    if (env.SIGNING_PROTOCOL !== 'plugin' || event.status !== 'done' || !['unknown', 'accepted'].includes(event.outcome)) return false;
    const current = await job(env, event.id);
    if (!current || current.state !== 'pending') return false;
    if (current.deadline_at <= now() || current.attempts >= LIMIT) {
      await run(env, "UPDATE attendance_verifications SET state='unresolved',next_at=NULL WHERE event_id=? AND state='pending'", event.id);
      await run(env, "UPDATE events SET result_notified=0 WHERE id=? AND status='done' AND outcome IN ('unknown','accepted')", event.id);
      return false;
    }
    // Advancing next_at claims this read attempt atomically, including across Worker restarts.
    const claimed = await run(env, `UPDATE attendance_verifications SET attempts=attempts+1,next_at=?,checked_at=?
      WHERE event_id=? AND state='pending' AND attempts=? AND next_at IS NOT NULL AND (next_at<=? OR (?=1 AND attempts=0))`,
    now() + INTERVAL, now(), event.id, current.attempts, now(), immediate ? 1 : 0);
    if (!claimed.meta.changes) return false;
    let record = null, startedAt = current.started_at;
    try {
      if (String(await readIdentity(env)) !== event.user_id) throw new Error('Account changed');
      if (startedAt === null) {
        // Legacy events did not persist the activity start; recover it only from the same activity.
        try {
          const basic = await readBasic(env, event);
          if (String(basic?.id) === event.attendance_id &&
              (basic.siteId === undefined || id(basic.siteId) === event.site_id) &&
              (basic.classLessonId === undefined || id(basic.classLessonId) === event.group_id)) {
            const value = serverTime(basic.attendanceStartTime);
            if (Number.isFinite(value)) startedAt = value;
          }
        } catch { /* An exact attendance ID in history can still verify the result. */ }
      }
      record = matchingRecord(await readRecords(env, event), { attendanceId: event.attendance_id, startedAt });
    } catch { /* Login, transport, and account failures never turn into a successful verification. */ }
    const verified = record && [11, 12, 13].includes(Number(record.status));
    const state = verified ? 'verified' : current.attempts + 1 >= LIMIT ? 'unresolved' : 'pending';
    const recordTime = record && Number.isFinite(serverTime(record.time)) ? record.time.slice(0, 60) : null;
    const save = env.DB.prepare(`UPDATE attendance_verifications SET started_at=COALESCE(started_at,?),state=?,next_at=?,record_status=?,record_time=? WHERE event_id=?`)
      .bind(startedAt, state, state === 'pending' ? now() + INTERVAL : null,
        record && Number.isSafeInteger(Number(record.status)) ? Number(record.status) : null, recordTime, event.id);
    if (verified) {
      // D1 batches are atomic: a restart cannot leave a verified job with an unknown event.
      const results = await env.DB.batch([save, env.DB.prepare(`UPDATE events SET outcome='verified',result_notified=0,result_notify_at=0
        WHERE id=? AND status='done' AND outcome IN ('unknown','accepted')`).bind(event.id)]);
      return Boolean(results[1].meta.changes);
    }
    if (state === 'unresolved') await env.DB.batch([save, env.DB.prepare("UPDATE events SET result_notified=0 WHERE id=? AND status='done' AND outcome IN ('unknown','accepted')").bind(event.id)]);
    else await save.run();
    return false;
  };
  const due = async env => (await env.DB.prepare(`SELECT e.* FROM events e JOIN attendance_verifications v ON v.event_id=e.id
    WHERE e.status='done' AND e.outcome IN ('unknown','accepted') AND v.state='pending' AND v.next_at<=?
    ORDER BY v.next_at LIMIT 3`).bind(now()).all()).results;
  return { enqueue, verify, due, job };
}
