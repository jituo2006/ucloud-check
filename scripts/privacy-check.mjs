import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const known = [];
for (const path of ['cloudflare/.dev.vars', 'relay/.env']) {
  if (!existsSync(path)) continue;
  const env = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value.length >= 8) known.push({ value, rule: 'local credential' });
    if (/^UCLOUD_(?:REFRESH_)?TOKEN$/.test(key)) {
      try {
        const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString());
        for (const key of ['user_id', 'account', 'user_name', 'real_name', 'email']) if (claims[key]) known.push({ value: String(claims[key]), rule: 'personal identity' });
      } catch { /* Opaque or absent tokens provide no identity hints. */ }
    }
  }
}
if (existsSync('cloudflare/wrangler.local.toml')) {
  const config = readFileSync('cloudflare/wrangler.local.toml', 'utf8');
  for (const key of ['database_id', 'PUBLIC_BASE_URL']) {
    const value = config.match(new RegExp('^' + key + '\\s*=\\s*"([^"]+)"', 'm'))?.[1];
    if (value && !value.includes('your-worker') && !/^0{8}-/.test(value)) known.push({ value, rule: 'personal deployment' });
  }
}
const staged = process.argv.includes('--staged');
const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'];
const paths = execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
const rules = [
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ['AWS key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Bark device URL', /https?:\/\/api\.day\.app\/[A-Za-z0-9]{10,}/],
];
let findings = 0;
for (const path of paths) {
  if (!staged && !existsSync(path)) continue;
  const raw = staged ? execFileSync('git', ['show', ':' + path]) : readFileSync(path);
  if (raw.subarray(0, 4096).includes(0)) continue;
  for (const [index, line] of raw.toString('utf8').split('\n').entries()) {
    const labels = new Set(rules.filter(([, pattern]) => pattern.test(line)).map(([label]) => label));
    for (const item of known) if (line.includes(item.value) || line.includes(encodeURIComponent(item.value))) labels.add(item.rule);
    if (labels.size) { console.log(`${path}:${index + 1} ${[...labels].join(', ')} (value omitted)`); findings++; }
  }
}
console.log(`Checked ${paths.length} ${staged ? 'staged' : 'tracked'} files; ${findings} finding(s).`);
process.exitCode = findings ? 1 : 0;
