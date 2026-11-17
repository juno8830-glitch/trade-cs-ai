import type { FastifyInstance } from 'fastify';
import { toUnifiedRequest } from '@trade-cs-ai/core';
import { runStream } from '../pipeline.js';
import { TOOL_DEFINITIONS } from '../tools/index.js';
import { ensureSystemPrompt } from '../prompts.js';

type Socket = {
  readyState: number;
  send(data: string): void;
  on(event: string, cb: (...args: any[]) => void): void;
};

const clients = new Set<Socket>();

/** 企业微信新消息 → 推送到所有在线桌面客户端（客服看到红点） */
export function broadcast(frame: unknown): number {
  const payload = JSON.stringify(frame);
  let n = 0;
  for (const ws of clients) {
    if (ws.readyState !== 1) {
      clients.delete(ws);
      continue;
    }
    try {
      ws.send(payload);
      n++;
    } catch {
      clients.delete(ws);
    }
  }
  return n;
}

export function clientCount(): number {
  return clients.size;
}

export default async function pushRoute(app: FastifyInstance): Promise<void> {
  /** 双工：客户端发 request 收流式帧；服务端随时推 push 帧 */
  app.get('/ws/stream', { websocket: true }, (socket: Socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: 'push', event: 'connected', data: { ts: Date.now(), clients: clients.size } }));

    socket.on('message', async (raw: unknown) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid JSON frame' }));
        return;
      }
      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'push', event: 'pong', data: { ts: Date.now() } }));
        return;
      }
      if (msg.type !== 'request') return;
      try {
        const unified = ensureSystemPrompt(toUnifiedRequest(msg.payload ?? {}));
        unified.stream = true;
        if (!unified.tools?.length) unified.tools = TOOL_DEFINITIONS;
        for await (const frame of runStream(unified)) {
          if (socket.readyState !== 1) break;
          socket.send(JSON.stringify(frame));
          if (frame.type === 'done' || frame.type === 'error') break;
        }
      } catch (e) {
        socket.send(JSON.stringify({ type: 'error', message: (e as Error).message }));
      }
    });

    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
}
