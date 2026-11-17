/**
 * 统一协议层：客户端只认 OpenAI Chat Completions + 少量扩展字段，
 * 网关把标准请求转成内部 UnifiedRequest，各 Agent 差异由适配器吸收。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
}

export interface BizContext {
  session_id?: string;
  customer?: { country?: string; type?: string; stage?: string; name?: string };
  channel?: string;
  locale?: string;
  scenario?: string;
  [key: string]: unknown;
}

export interface AgentHint {
  preferred?: string;
  fallback?: string[];
}

export interface UnifiedRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature: number;
  tools?: ToolDefinition[];
  context?: BizContext;
  agent_hint?: AgentHint;
  vision?: boolean;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

export interface ToolTrace {
  name: string;
  args?: Record<string, unknown>;
  ok: boolean;
  file?: string;
  row?: number;
  summary?: string;
}

export interface XMeta {
  agent: string;
  latency_ms: number;
  tools_called: ToolTrace[];
  price_sensitive: boolean;
  need_human_confirm: boolean;
  sticky?: boolean;
  failover?: string[];
  usage?: Usage;
  /** 本次回复在学习记录里的编号，界面用它来「标记成功 / 标记失败」 */
  suggestion_id?: string;
  /** 自动识别出来的客户意图（问价 / 交期 / 图片证书 …） */
  intent?: string;
  /** 可以直接发给客户的外文正文（已剔除中文翻译与注解），界面复制按钮只用它 */
  clean_draft?: string;
  /** 给客服看的中文翻译，只显示、不复制 */
  translation?: string;
}

export interface UnifiedResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage?: Usage;
  x_meta?: XMeta;
  model?: string;
}

export type StreamFrame =
  | { type: 'delta'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; data: unknown }
  | { type: 'meta'; x_meta: XMeta }
  | { type: 'done'; usage?: Usage }
  | { type: 'error'; message: string }
  | { type: 'push'; event: string; data: unknown };

export interface InvokeCtx {
  requestId: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface Capabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  contextWindow: number;
}

export interface RouteConfig {
  scenarios: string[];
  weight: number;
  priority: number;
}

export type AdapterKind = 'openai_compatible' | 'custom_langgraph' | 'builtin_offline';

export interface AgentConfig {
  id: string;
  adapter: AdapterKind;
  endpoint?: string;
  healthUrl?: string;
  apiKeyRef?: string;
  apiKeyOptional?: boolean; // 无密钥也要探活的本地服务（如 Ollama）
  model?: string;
  timeoutMs?: number;
  capabilities: Capabilities;
  route: RouteConfig;
  fallback?: string[];
  enabled?: boolean;
}

export interface RouterConfig {
  strategy: string;
  stickySession: boolean;
  failoverTimeoutMs: number;
  healthTtlMs: number;
  healthTimeoutMs: number;
  maxToolRounds: number;
  requestTimeoutMs: number;
}

export interface GatewayConfig {
  agents: AgentConfig[];
  router: RouterConfig;
}

/** 接入新 Agent 唯一需要实现的接口 */
export interface AgentAdapter {
  readonly id: string;
  readonly cfg: AgentConfig;
  readonly capabilities: Capabilities;
  health(): Promise<HealthResult>;
  invoke(req: UnifiedRequest, ctx: InvokeCtx): Promise<UnifiedResponse>;
  stream?(req: UnifiedRequest, ctx: InvokeCtx): AsyncIterable<StreamFrame>;
}

export { toUnifiedRequest, toOpenAIResponse, estimateUsage, BadRequestError } from './protocol.js';
export {
  DRAFT_MARK,
  TRANSLATION_MARK,
  NOTES_MARK,
  SOURCES_MARK,
  PRIVATE_MARKS,
  splitDraft,
  cleanDraftText,
  sanitizeForeignDraft,
  type DraftSections,
} from './draft.js';
