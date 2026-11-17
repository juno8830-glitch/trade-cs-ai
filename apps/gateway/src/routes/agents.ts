import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { BadRequestError, toOpenAIResponse, toUnifiedRequest } from '@trade-cs-ai/core';
import { cfg } from '../config.js';
import { router, registry } from '../context.js';
import { run } from '../pipeline.js';
import { TOOL_DEFINITIONS } from '../tools/index.js';
import { ensureSystemPrompt } from '../prompts.js';
import { getIndex } from '../library/organizer.js';

const startedAt = Date.now();

export default async function agentsRoute(app: FastifyInstance): Promise<void> {
  /** 列出已注册 Agent、健康度、能力标签 —— 新 Agent 接入后这里能看到即完成。
   *  ?refresh=1 会先清掉探活缓存：菜单里刚填完密钥时用它立刻看到「已连上」。 */
  app.get('/v1/agents', async (req) => {
    const q = (req.query ?? {}) as Record<string, string>;
    if (q.refresh === '1') router.invalidateHealth();
    return {
      object: 'list',
      data: await router.snapshot(),
      router: {
        strategy: cfg.router.strategy,
        stickySession: cfg.router.stickySession,
        failoverTimeoutMs: cfg.router.failoverTimeoutMs,
        healthTtlMs: cfg.router.healthTtlMs,
        maxToolRounds: cfg.router.maxToolRounds,
      },
    };
  });

  /** 绕过对话协议直连某个 Agent（调试 / 批处理） */
  app.post('/v1/agent/invoke', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentId = String(body.agent_id ?? body.model ?? '');
    if (!agentId) return reply.code(400).send({ error: { message: 'agent_id is required', type: 'invalid_request_error' } });
    if (!registry.get(agentId)) return reply.code(404).send({ error: { message: `unknown agent_id: ${agentId}`, type: 'not_found' } });
    try {
      const raw = (body.request ?? body) as Record<string, unknown>;
      const unified = ensureSystemPrompt(toUnifiedRequest({ ...raw, stream: false }));
      if (!unified.tools?.length) unified.tools = TOOL_DEFINITIONS;
      const res = await run(unified, { forceAgentId: agentId });
      return reply.send(toOpenAIResponse(res, `inv_${crypto.randomUUID().slice(0, 12)}`));
    } catch (e) {
      const status = e instanceof BadRequestError ? 400 : 502;
      return reply.code(status).send({ error: { message: (e as Error).message, type: 'invoke_error' } });
    }
  });

  app.get('/v1/health', async () => {
    const snapshot = await router.snapshot();
    const healthy = snapshot.filter((a) => a.healthy).length;
    return {
      status: healthy > 0 ? 'ok' : 'degraded',
      version: '0.1.0',
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      agents_total: snapshot.length,
      agents_healthy: healthy,
      kb_root: cfg.kbRoot,
      kb_exists: fs.existsSync(cfg.kbRoot),
      kb_index: (() => {
        const idx = getIndex();
        return idx
          ? { ready: true, models: idx.统计.型号数, rows: idx.统计.报价行数, generated_at: idx.生成时间 }
          : { ready: false };
      })(),
      db_path: cfg.dbPath,
      dev_token: cfg.clientToken === 'dev-client-token-change-me',
      agents: snapshot.map((a) => ({ id: a.id, healthy: a.healthy, detail: a.detail })),
    };
  });

  app.get('/v1/tools', async () => ({ object: 'list', data: TOOL_DEFINITIONS }));
}
