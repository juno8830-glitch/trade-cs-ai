import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { cfg } from './config.js';

/** /v1/* 与 /ws/stream 必须带 client_token；静态页、健康检查、微信回调走各自通道 */
export async function authHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = req.url.split('?')[0];
  const publicPaths = ['/', '/v1/health'];
  if (publicPaths.includes(url) || url.startsWith('/app') || url.startsWith('/ingress/')) return;
  if (!url.startsWith('/v1/') && url !== '/ws/stream') return;

  let token = '';
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  if (!token && url === '/ws/stream') {
    token = String((req.query as Record<string, unknown>)?.token ?? '');
  }
  if (!token || token !== cfg.clientToken) {
    reply.code(401).send({ error: { message: '连接口令不对，请在界面右上角的「设置」里检查', type: 'authentication_error' } });
  }
}

/** KB_ROOT 只读白名单：realpath 校验，防目录穿越 */
export function assertInsideRoot(target: string): string {
  const real = fs.realpathSync(target);
  const rootReal = fs.existsSync(cfg.kbRoot) ? fs.realpathSync(cfg.kbRoot) : path.resolve(cfg.kbRoot);
  const rel = path.relative(rootReal, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes KB_ROOT: ${target}`);
  }
  return real;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function hmacSha256(secret: string, text: string): string {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(api[_-]?key["'=:\s]+)[^\s,"'}]+/gi, '$1***');
}
