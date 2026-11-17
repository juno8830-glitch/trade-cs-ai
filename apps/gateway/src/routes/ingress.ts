import type { FastifyInstance } from 'fastify';
import { toUnifiedRequest } from '@trade-cs-ai/core';
import { cfg } from '../config.js';
import { run } from '../pipeline.js';
import { TOOL_DEFINITIONS } from '../tools/index.js';
import { ensureSystemPrompt } from '../prompts.js';
import { isDuplicate, rememberMsg } from '../store/sqlite.js';
import { hmacSha256, sha256, timingSafeEqual } from '../security.js';
import { broadcast, clientCount } from './push.js';

/** 企业微信 URL 校验 */
function verifyGet(req: any): boolean {
  if (!cfg.wechatToken) return true;
  const q = (req.query ?? {}) as Record<string, string>;
  const expected = hmacSha256(cfg.wechatToken, `${q.timestamp ?? ''}${q.nonce ?? ''}${q.echostr ?? ''}`);
  return !q.msg_signature || timingSafeEqual(q.msg_signature, expected);
}

export default async function ingressRoute(app: FastifyInstance): Promise<void> {
  app.get('/ingress/wechat/callback', async (req, reply) => {
    if (!verifyGet(req)) return reply.code(401).send('invalid signature');
    const echostr = String((req.query as Record<string, string>)?.echostr ?? 'ok');
    return reply.type('text/plain').send(echostr);
  });

  /**
   * 企业微信会话存档 / 群机器人回调：验签 → 去重 → 组装上下文 → 生成建议 → WS 推给桌面端。
   * 绝不自动发送：客服在客户端点「复制」后手动粘贴。
   */
  app.post('/ingress/wechat/callback', async (req, reply) => {
    if (cfg.wechatToken) {
      const sig = String(req.headers['x-signature'] ?? '');
      // 约定：HMAC_SHA256(WECHAT_TOKEN, canonical_json(body))，见 .env.example
      const expected = hmacSha256(cfg.wechatToken, JSON.stringify(req.body));
      if (!timingSafeEqual(sig, expected)) {
        return reply.code(401).send({ error: { message: 'invalid signature', type: 'authentication_error' } });
      }
    }

    const b = (req.body ?? {}) as Record<string, any>;
    const text = String(b.text?.content ?? b.content ?? b.message ?? '').trim();
    const msgId = String(b.msgid ?? b.msg_id ?? sha256(JSON.stringify(b)));
    if (isDuplicate(msgId)) return reply.send({ ok: true, duplicate: true });
    rememberMsg(msgId);
    if (!text) return reply.send({ ok: true, ignored: true, reason: 'empty message' });

    const sessionId = String(b.session_id ?? `s_wx_${msgId.slice(0, 12)}`);
    const customer = (b.customer ?? {}) as Record<string, unknown>;
    const unified = ensureSystemPrompt(
      toUnifiedRequest({
        model: 'auto',
        messages: [{ role: 'user', content: `客户消息：${text}` }],
        stream: false,
        temperature: 0.4,
        tools: TOOL_DEFINITIONS,
        context: {
          session_id: sessionId,
          customer: {
            country: String(customer.country ?? ''),
            type: String(customer.type ?? ''),
            stage: String(customer.stage ?? 'inquiry'),
            name: String(customer.name ?? b.from ?? ''),
          },
          channel: 'wechat',
          locale: String(b.locale ?? 'en'),
          scenario: b.scenario,
        },
        agent_hint: b.agent_hint,
      }),
    );

    try {
      const res = await run(unified);
      const push = {
        type: 'push',
        event: 'wechat_message',
        data: {
          msg_id: msgId,
          session_id: sessionId,
          from: String(b.from ?? 'customer'),
          text,
          suggestion: res.content,
          x_meta: res.x_meta,
          ts: Date.now(),
        },
      };
      const delivered = broadcast(push);
      return reply.send({ ok: true, session_id: sessionId, suggestion: res.content, x_meta: res.x_meta, clients_notified: delivered, online_clients: clientCount() });
    } catch (e) {
      return reply.code(502).send({ error: { message: (e as Error).message, type: 'agent_error' } });
    }
  });
}
