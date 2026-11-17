import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8787';
const token = process.env.CLIENT_TOKEN ?? 'dev-client-token-change-me';
const content = fs.readFileSync(path.join(ROOT, 'data', 'cases', 'cases.json'), 'utf8');

const r = await fetch(`${base}/v1/cases/import`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ format: 'json', content }),
});
console.log(`[import-cases] HTTP ${r.status}`, await r.json());
if (!r.ok) process.exit(1);
