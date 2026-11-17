import type {
  ChatMessage,
  UnifiedRequest,
  UnifiedResponse,
  Usage,
  ToolDefinition,
  BizContext,
  AgentHint,
} from './index.js';

export class BadRequestError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const p = part as Record<string, unknown>;
        if (p.type === 'text') return String(p.text ?? '');
        if (p.type === 'image_url') return '[客户截图]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return value == null ? '' : String(value);
}

function hasVision(messages: unknown[]): boolean {
  return messages.some((m) => {
    const c = (m as Record<string, unknown>)?.content;
    return Array.isArray(c) && c.some((p) => (p as Record<string, unknown>)?.type === 'image_url');
  });
}

/** 标准 OpenAI 请求 + 扩展字段 → 内部统一模型 */
export function toUnifiedRequest(body: unknown): UnifiedRequest {
  if (!body || typeof body !== 'object') throw new BadRequestError('request body must be an object');
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    throw new BadRequestError('messages must be a non-empty array');
  }
  const messages: ChatMessage[] = b.messages.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new BadRequestError(`messages[${i}] is invalid`);
    const m = raw as Record<string, unknown>;
    const role = String(m.role ?? '');
    if (!ROLES.has(role)) throw new BadRequestError(`messages[${i}].role is invalid: ${role}`);
    return {
      role: role as ChatMessage['role'],
      content: asString(m.content),
      ...(m.name ? { name: String(m.name) } : {}),
      ...(m.tool_call_id ? { tool_call_id: String(m.tool_call_id) } : {}),
      ...(Array.isArray(m.tool_calls) ? { tool_calls: normalizeToolCalls(m.tool_calls) } : {}),
    } as ChatMessage;
  });

  const tools = Array.isArray(b.tools) ? (b.tools as ToolDefinition[]) : undefined;
  const context = b.context && typeof b.context === 'object' ? (b.context as BizContext) : undefined;
  const hint = b.agent_hint && typeof b.agent_hint === 'object' ? (b.agent_hint as AgentHint) : undefined;

  return {
    model: typeof b.model === 'string' ? b.model : 'auto',
    messages,
    stream: b.stream === true,
    temperature: typeof b.temperature === 'number' ? b.temperature : 0.4,
    tools,
    context,
    agent_hint: hint,
    vision: b.vision === true || hasVision(b.messages),
  };
}

function normalizeToolCalls(raw: unknown[]): { id: string; name: string; args: Record<string, unknown> }[] {
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const t = item as Record<string, unknown>;
    const fn = (t.function ?? {}) as Record<string, unknown>;
    let args: Record<string, unknown> = {};
    try {
      args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments as Record<string, unknown>) ?? {};
    } catch {
      args = {};
    }
    return [{ id: String(t.id ?? ''), name: String(fn.name ?? ''), args }];
  });
}

export function estimateUsage(messages: ChatMessage[], completion: string): Usage {
  const prompt = messages.reduce((n, m) => n + m.content.length, 0);
  const prompt_tokens = Math.max(1, Math.ceil(prompt / 2.5));
  const completion_tokens = Math.max(1, Math.ceil(completion.length / 2.5));
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

/** 内部统一模型 → 标准 OpenAI 响应 + x_meta 扩展 */
export function toOpenAIResponse(res: UnifiedResponse, id: string): Record<string, unknown> {
  const usage: Usage = res.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res.model ?? 'auto',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: res.content },
        finish_reason: res.finishReason,
      },
    ],
    usage: { ...usage, total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens },
    ...(res.x_meta ? { x_meta: res.x_meta } : {}),
  };
}
