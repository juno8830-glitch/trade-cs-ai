import type {
  AgentAdapter,
  AgentConfig,
  Capabilities,
  HealthResult,
  InvokeCtx,
  StreamFrame,
  UnifiedRequest,
  UnifiedResponse,
  Usage,
} from '@trade-cs-ai/core';
import { cfg, resolveSecret } from '../../config.js';
import { parseSSE } from './sse.js';

/** 自研编排服务（多步检索 + 反思），只要求 /invoke 与 /health 两个端点 */
export class LangGraphAdapter implements AgentAdapter {
  readonly id: string;
  constructor(readonly cfg: AgentConfig) {
    this.id = cfg.id;
  }
  get capabilities(): Capabilities {
    return this.cfg.capabilities;
  }

  private headers(): Record<string, string> {
    const s = resolveSecret(this.cfg.apiKeyRef);
    return { 'Content-Type': 'application/json', ...(s ? { Authorization: `Bearer ${s}` } : {}) };
  }
  private credentialMissing(): boolean {
    return Boolean(this.cfg.apiKeyRef?.startsWith('env:')) && !this.cfg.apiKeyOptional && !resolveSecret(this.cfg.apiKeyRef);
  }

  private body(req: UnifiedRequest, stream: boolean): Record<string, unknown> {
    return {
      request_id: req.context?.session_id ?? '',
      messages: req.messages,
      context: req.context ?? {},
      tools: req.tools ?? [],
      temperature: req.temperature,
      stream,
    };
  }

  async health(): Promise<HealthResult> {
    const t0 = Date.now();
    if (this.credentialMissing()) return { ok: false, latencyMs: 0, detail: `missing credential ${this.cfg.apiKeyRef}` };
    if (!this.cfg.healthUrl) return { ok: false, latencyMs: 0, detail: 'healthUrl not configured' };
    try {
      const r = await fetch(this.cfg.healthUrl, {
        headers: this.headers(),
        signal: AbortSignal.timeout(cfg.router.healthTimeoutMs),
      });
      return { ok: r.ok, latencyMs: Date.now() - t0, detail: r.ok ? undefined : `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  }

  async invoke(req: UnifiedRequest, _ctx: InvokeCtx): Promise<UnifiedResponse> {
    const r = await fetch(this.cfg.endpoint!, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(req, false)),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? cfg.router.requestTimeoutMs),
    });
    if (!r.ok) throw new Error(`${this.id} upstream HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const json: any = await r.json();
    const toolCalls = Array.isArray(json.tool_calls)
      ? json.tool_calls.map((t: any) => ({ id: String(t.id ?? ''), name: String(t.name ?? ''), args: (t.args ?? {}) as Record<string, unknown> }))
      : [];
    return {
      content: String(json.content ?? json.choices?.[0]?.message?.content ?? ''),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
      usage: json.usage as Usage | undefined,
      model: this.id,
    };
  }

  async *stream(req: UnifiedRequest, _ctx: InvokeCtx): AsyncIterable<StreamFrame> {
    const r = await fetch(this.cfg.endpoint!, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(req, true)),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? cfg.router.requestTimeoutMs),
    });
    if (!r.ok || !r.body) throw new Error(`${this.id} upstream HTTP ${r.status}`);
    let usage: Usage | undefined;
    for await (const payload of parseSSE(r.body)) {
      if (payload === '[DONE]') break;
      let f: any;
      try {
        f = JSON.parse(payload);
      } catch {
        continue;
      }
      if (f.type === 'delta' || f.content) yield { type: 'delta', content: String(f.content ?? '') };
      else if (f.type === 'tool_call') yield { type: 'tool_call', name: String(f.name), args: f.args ?? {} };
      else if (f.usage) usage = f.usage as Usage;
    }
    yield { type: 'done', usage };
  }
}
