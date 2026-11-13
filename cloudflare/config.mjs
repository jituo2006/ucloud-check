import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relayOrigin } from '../public/monitor/core.js';

export function configurationPath() {
  const local = new URL('./wrangler.local.toml', import.meta.url);
  return fileURLToPath(existsSync(local) ? local : new URL('./wrangler.toml', import.meta.url));
}

export function serviceOrigin() {
  const configured = process.env.UCLOUD_SERVICE_URL || readFileSync(configurationPath(), 'utf8').match(/^PUBLIC_BASE_URL\s*=\s*"([^"]+)"/m)?.[1];
  if (!configured || configured.includes('your-worker') || configured.includes('your-subdomain')) throw new Error('请在私有配置中填写实际 PUBLIC_BASE_URL 或 UCLOUD_SERVICE_URL');
  return relayOrigin(configured);
}
