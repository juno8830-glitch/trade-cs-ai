import crypto from 'node:crypto';
import type { UnifiedRequest, XMeta } from '@trade-cs-ai/core';
import { sha256 } from '../security.js';
import { classifyIntent } from '../learning/intents.js';
import { insertAudit, insertLearningRecord, upsertSession } from './sqlite.js';

/**
 * 每次调用留两笔账：
 *  1) audit_logs：合规审计，不存原文，只存 prompt_hash / 工具 / 是否确认 / 是否发送
 *  2) learning_records：学习记录，存客户原文与回复稿（只在本机），供客服标记成功 / 失败
 * 两者都绝不上传、绝不发给客户。
 */
export function logAudit(req: UnifiedRequest, meta: XMeta, draftText: string): { auditId: number; recordId: string } {
  const sessionId = req.context?.session_id;
  const customerText = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const customer = req.context?.customer ?? {};
  const tools = meta.tools_called ?? [];
  const skuArg = tools.find((t) => t.args?.sku)?.args?.sku;
  const skuText = customerText.match(/[A-Z]{2,5}-?\d{3,5}[A-Z0-9-]*/i)?.[0];
  const attachments = tools.map((t) => t.file).filter((f): f is string => Boolean(f));

  if (sessionId) {
    upsertSession(sessionId, String(req.context?.channel ?? 'unknown'), customer, meta.agent);
  }
  const auditId = insertAudit({
    session_id: sessionId,
    agent: meta.agent,
    prompt_hash: sha256(JSON.stringify(req.messages.map((m) => ({ role: m.role, content: m.content })))),
    tools_called: meta.tools_called,
    need_confirm: meta.need_human_confirm,
    price_sensitive: meta.price_sensitive,
    latency_ms: meta.latency_ms,
    channel: String(req.context?.channel ?? 'unknown'),
  });
  const recordId = insertLearningRecord({
    id: `lr_${crypto.randomUUID().slice(0, 12)}`,
    source: 'chat',
    intent: classifyIntent(customerText),
    country: String(customer.country ?? ''),
    product: String(skuArg ?? skuText ?? '').toUpperCase(),
    stage: String(req.context?.scenario ?? customer.stage ?? ''),
    locale: String(req.context?.locale ?? ''),
    customer_text: customerText,
    draft_text: draftText,
    attachments,
    agent: meta.agent,
    session_id: sessionId ?? '',
  });
  return { auditId, recordId };
}
