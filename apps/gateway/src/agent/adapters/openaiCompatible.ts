import type {
  AgentAdapter,
  AgentConfig,
  Capabilities,
  ChatMessage,
  HealthResult,
  InvokeCtx,
  StreamFrame,
  UnifiedRequest,
  UnifiedResponse,
  Usage,
} from '@trade-cs-ai/core';
import { cfg, resolveSecret } from '../../config.js';
import { TOOL_DEFINITIONS } from '../../tools/index.js';
import { parseSSE } from './sse.js';

/** 覆盖 80% 场景：百炼 / OpenAI / 任意 OpenAI 兼容第三方 / Ollama */
export class OpenAICompatibleAdapter implements AgentAdapter {
  readonly id: string;
  constructor(readonly cfg: AgentConfig) {
    this.id = cfg.id;
  }
  get capabilities(): Capabilities {
    return this.cfg.capabilities;
  }

  private base(): string {
    return (this.cfg.endpoint ?? '').replace(/\/+$/, '');
  }
  private secret(): string | undefined {
    return resolveSecret(this.cfg.apiKeyRef);
  }
  private headers(): Record<string, string> {
    const s = this.secret();
    return { 'Content-Type': 'application/json', ...(s ? { Authorization: `Bearer ${s}` } : {}) };
  }
  private credentialMissing(): boolean {
    return Boolean(this.cfg.apiKeyRef?.startsWith('env:')) && !this.cfg.apiKeyOptional && !this.secret();
  }
  private timeout(): number {
    return this.cfg.timeoutMs ?? cfg.router.requestTimeoutMs;
  }

  private toUpstream(messages: ChatMessage[]): Record<string, unknown>[] {
    return messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.name) out.name = m.name;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.tool_calls?.length) {
        out.tool_calls = m.tool_calls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        }));
      }
      return out;
    });
  }

  private body(req: UnifiedRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.cfg.model ?? req.model,
      messages: this.toUpstream(req.messages),
      temperature: req.temperature,
      stream,
    };
    if (req.tools?.length && this.capabilities.toolCalling) {
      // 有些老客户端只传工具名、不传 parameters；智谱 / OpenAI 会直接 400「参数有误」。
      // 优先按名字补回网关里真正的参数说明，模型才知道该传 sku，而不是乱猜参数。
      body.tools = req.tools.map((t) => {
        const known = TOOL_DEFINITIONS.find((d) => d.function.name === t.function.name);
        return {
          type: 'function',
          function: {
            name: t.function.name,
            description: t.function.description ?? known?.function.description ?? '',
            parameters: t.function.parameters ?? known?.function.parameters ?? { type: 'object', properties: {} },
          },
        };
      });
      body.tool_choice = 'auto';
    }
    return body;
  }

  async health(): Promise<HealthResult> {
    const t0 = Date.now();
    if (this.credentialMissing()) {
      return { ok: false, latencyMs: 0, detail: `missing credential ${this.cfg.apiKeyRef}` };
    }
    try {
      const r = await fetch(`${this.base()}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(cfg.router.healthTimeoutMs),
      });
      return { ok: r.ok, latencyMs: Date.now() - t0, detail: r.ok ? undefined : `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  }

  async invoke(req: UnifiedRequest, _ctx: InvokeCtx): Promise<UnifiedResponse> {
    const r = await fetch(`${this.base()}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(req, false)),
      signal: AbortSignal.timeout(this.timeout()),
    });
    if (!r.ok) throw new Error(`${this.id} upstream HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return normalize(await r.json(), this.cfg);
  }

  async *stream(req: UnifiedRequest, _ctx: InvokeCtx): AsyncIterable<StreamFrame> {
    const r = await fetch(`${this.base()}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(req, true)),
      signal: AbortSignal.timeout(this.timeout()),
    });
    if (!r.ok || !r.body) throw new Error(`${this.id} upstream HTTP ${r.status}`);
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage | undefined;
    for await (const payload of parseSSE(r.body)) {
      if (payload === '[DONE]') break;
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.usage) usage = chunk.usage as Usage;
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) yield { type: 'delta', content: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const i = Number(tc.index ?? 0);
        const prev = pending.get(i) ?? { id: '', name: '', args: '' };
        pending.set(i, {
          id: tc.id ?? prev.id,
          name: tc.function?.name ?? prev.name,
          args: prev.args + (tc.function?.arguments ?? ''),
        });
      }
    }
    for (const t of pending.values()) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(t.args || '{}');
      } catch {
        args = {};
      }
      yield { type: 'tool_call', name: t.name, args };
    }
    yield { type: 'done', usage };
  }
}

function normalize(json: any, agent: AgentConfig): UnifiedResponse {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const toolCalls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.flatMap((t: any) => {
        let args: Record<string, unknown> = {};
        try {
          args = typeof t.function?.arguments === 'string' ? JSON.parse(t.function.arguments) : (t.function?.arguments ?? {});
        } catch {
          args = {};
        }
        return [{ id: String(t.id ?? ''), name: String(t.function?.name ?? ''), args }];
      })
    : [];
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    usage: json?.usage as Usage | undefined,
    model: json?.model ?? agent.model ?? agent.id,
  };
}
