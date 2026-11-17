import type { FastifyInstance } from 'fastify';
import { listAudit, markSent, metrics } from '../store/sqlite.js';

export default async function auditRoute(app: FastifyInstance): Promise<void> {
  /** 客户端人工确认写入剪贴板后回报；系统从不自动发送给客户 */
  app.post('/v1/audit/sent', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = String(body.session_id ?? '');
    const confirmed = body.confirmed === true;
    if (!sessionId || !confirmed) {
      return reply.code(400).send({ error: { message: 'session_id 与 confirmed=true 为必填', type: 'invalid_request_error' } });
    }
    const changed = markSent(sessionId, String(body.operator ?? 'unknown'));
    return reply.send({ ok: changed > 0, changed });
  });

  app.get('/v1/audit', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    return { object: 'list', data: listAudit(Math.min(Number(q.limit ?? 50), 500)) };
  });

  /** M5：采纳率、平均响应时长、Agent 分布可量化 */
  app.get('/v1/metrics', async () => metrics());
}
