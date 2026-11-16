import { DurableObject } from 'cloudflare:workers';
import application from './worker.mjs';
import { createClassScheduler } from './class-scheduler.mjs';

export class ClassScheduler extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.scheduler = createClassScheduler({ storage: ctx.storage, env, monitor: application.monitor });
  }
  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/plan') return new Response(null, { status: 404 });
    return Response.json(await this.scheduler.plan());
  }
  alarm() { return this.scheduler.alarm(); }
}

export default application;
