import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BadRequestError, toOpenAIResponse, toUnifiedRequest } from '@trade-cs-ai/core';
import { run, runStream } from '../pipeline.js';
import { NoHealthyAgentError } from '../router/index.js';
import { TOOL_DEFINITIONS } from '../tools/index.js';
import { ensureSystemPrompt } from '../prompts.js';

function errorReply(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof BadRequestError) {
    return reply.code(400).send({ error: { message: e.message, type: 'invalid_request_error' } });
  }
  if (e instanceof NoHealthyAgentError) {
    return reply.code(503).send({ error: { message: e.message, type: e.code } });
  }
  return reply.code(502).send({ error: { message: (e as Error).message, type: 'upstream_error' } });
}

/** 客户端唯一依赖的接口：POST /v1/chat/completions（OpenAI 兼容 + x_meta 扩展） */
export default async function chatRoute(app: FastifyInstance): Promise<void> {
  app.post('/v1/chat/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    let unified;
    try {
      unified = ensureSystemPrompt(toUnifiedRequest(req.body));
      // 客户端未显式声明工具时，网关按自身工具层注入（工具始终只在网关执行）
      if (!unified.tools?.length) unified.tools = TOOL_DEFINITIONS;
    } catch (e) {
      return errorReply(reply, e);
    }

    if (unified.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      try {
        for await (const frame of runStream(unified)) {
          if (reply.raw.destroyed) break;
          reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
          if (frame.type === 'done' || frame.type === 'error') break;
        }
        if (!reply.raw.destroyed) reply.raw.write('data: [DONE]\n\n');
      } catch (e) {
        if (!reply.raw.destroyed) {
          reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: (e as Error).message })}\n\n`);
        }
      } finally {
        if (!reply.raw.writableEnded) reply.raw.end();
      }
      return reply;
    }

    try {
      const res = await run(unified);
      return reply.send(toOpenAIResponse(res, `cmpl_${crypto.randomUUID().slice(0, 12)}`));
    } catch (e) {
      return errorReply(reply, e);
    }
  });
}
