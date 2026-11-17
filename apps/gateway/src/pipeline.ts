import crypto from 'node:crypto';
import type {
  AgentAdapter,
  ChatMessage,
  StreamFrame,
  ToolCall,
  ToolTrace,
  UnifiedRequest,
  UnifiedResponse,
  Usage,
  XMeta,
} from '@trade-cs-ai/core';
import { estimateUsage, splitDraft, sanitizeForeignDraft } from '@trade-cs-ai/core';
import { cfg } from './config.js';
import type { Router } from './router/index.js';
import { executeTool, summarizeTool } from './tools/index.js';
import { logAudit } from './store/audit.js';
import { classifyIntent } from './learning/intents.js';

let routerRef: Router;
export function initPipeline(router: Router): void {
  routerRef = router;
}

export interface RunOptions {
  forceAgentId?: string;
}

/**
 * 有些模型（尤其思考型）不返回原生 tool_calls，而是把
 *   <tool_call>library_search\n<arg_key>keyword</arg_key>\n<arg_value>…</arg_value>\n</tool_call>
 * 当普通文字吐出来。这些标记绝不能出现在发给客户的回复稿里：
 * 允许调工具的那一轮把它转成真正的工具调用，其它轮直接剥掉。
 */
function parseTextToolCalls(text: string, allowed: Set<string>): ToolCall[] {
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  const out: ToolCall[] = [];
  for (const m of text.matchAll(re)) {
    const body = String(m[1] ?? '').trim();
    if (!body) continue;
    let name = '';
    let args: Record<string, unknown> = {};
    let parsed: any = null;
    if (body.startsWith('{')) {
      try { parsed = JSON.parse(body); } catch { parsed = null; }
    }
    if (parsed) {
      name = String(parsed.name ?? parsed.tool ?? '');
      args = (parsed.arguments ?? parsed.args ?? {}) as Record<string, unknown>;
    } else {
      name = body.split(/\r?\n/, 1)[0].trim();
      const keys = [...body.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>/gi)].map((x) => x[1].trim());
      const vals = [...body.matchAll(/<arg_value>([\s\S]*?)<\/arg_value>/gi)].map((x) => x[1].trim());
      keys.forEach((k, i) => { args[k] = vals[i] ?? ''; });
    }
    if (!allowed.has(name)) continue;
    out.push({ id: `call_${crypto.randomUUID().slice(0, 8)}`, name, args });
  }
  return out;
}

function stripTextToolCalls(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
}

function assessRisk(content: string, traces: ToolTrace[]): { price_sensitive: boolean; need_human_confirm: boolean } {
  const hasQuoteTool = traces.some((t) => t.name === 'quote_lookup' && t.ok);
  const sensitive =
    /(USD\s?\d|\$\s?\d|价格|报价|单价|MOQ|起订|交期|lead\s*time|账期|付款|索赔|discount|折扣|payment\s*terms|claim)/i.test(content);
  const hardConfirm = /(账期|索赔|claim|discount|折扣|退款|赔偿|payment\s*terms|warranty|质保)/i.test(content);
  const price_sensitive = hasQuoteTool || sensitive;
  return { price_sensitive, need_human_confirm: price_sensitive || hardConfirm };
}

/**
 * 统一执行链：路由 → Agent 决定工具 → 网关执行工具 → 结果回填 → 成稿 → x_meta → 审计。
 * 非流式与流式共用同一条链，保证工具行为与合规判定完全一致。
 */
async function* execute(req: UnifiedRequest, opts: RunOptions = {}): AsyncGenerator<StreamFrame, UnifiedResponse> {
  const t0 = Date.now();
  let agent: AgentAdapter;
  let sticky = false;
  let failover: string[] = [];

  if (opts.forceAgentId) {
    const forced = routerRef.get(opts.forceAgentId);
    if (!forced) throw new Error(`unknown agent_id: ${opts.forceAgentId}`);
    agent = forced;
  } else {
    const picked = await routerRef.pick(req);
    agent = picked.agent;
    sticky = picked.sticky;
    failover = picked.failover;
  }

  const ctx = { requestId: crypto.randomUUID(), sessionId: req.context?.session_id };
  const toolCount = req.tools?.length ?? 0;
  const maxRounds = cfg.router.maxToolRounds;
  const useStream = req.stream && typeof agent.stream === 'function';
  const traces: ToolTrace[] = [];
  let messages: ChatMessage[] = [...req.messages];
  const allowedNames = new Set(
    (req.tools ?? []).map((t) => t.function?.name).filter((n): n is string => Boolean(n)),
  );

  for (let round = 0; round <= maxRounds; round++) {
    const canCallTools = toolCount > 0 && round < maxRounds;
    // 查过资料之后，下一轮不再把工具清单递给模型，逼它直接写正文。
    // 否则智谱这类思考型模型会继续调工具 / 只输出思考内容，最后给出空白稿。
    // 内置适配器的 decide() 同样兼容：没有 tools 时直接用已查到的结果成稿。
    const roundTools = canCallTools && traces.length === 0 ? req.tools : undefined;
    const roundReq: UnifiedRequest = { ...req, messages, tools: roundTools };
    let content = '';
    const toolCalls: ToolCall[] = [];
    let usage: Usage | undefined;

    // 流式请求全程走 stream：工具意图由上游以 tool_call 帧给出，最终答复逐字回传
    if (useStream && agent.stream) {
      // 外部 AI（智谱 / 通义 / OpenAI）在「要查资料」那一轮，往往会先说一句中文旁白，
      // 例如「我来帮您查询这款的报价」。这些字绝不能流进「发给客户的正文」。
      // 所以先攒住本轮文字，确认本轮没有工具调用后才回放给界面。
      const buffered: string[] = [];
      for await (const frame of agent.stream({ ...roundReq, stream: true }, ctx)) {
        switch (frame.type) {
          case 'delta':
            content += frame.content;
            buffered.push(frame.content);
            break;
          case 'tool_call':
            toolCalls.push({ id: `call_${crypto.randomUUID().slice(0, 8)}`, name: frame.name, args: frame.args });
            break;
          case 'done':
            usage = frame.usage;
            break;
          case 'error':
            throw new Error(frame.message);
          default:
            break;
        }
      }
      if (!toolCalls.length) {
        const raw = buffered.join('');
        const pseudo = roundTools ? parseTextToolCalls(raw, allowedNames) : [];
        if (pseudo.length) {
          // 模型其实是在要工具：转成真正的调用走工具轮，别把标记流给界面
          toolCalls.push(...pseudo);
          content = '';
        } else if (/<tool_call>/i.test(raw)) {
          // 本轮不允许再调工具：剥掉标记，只回放剩下的正文
          const cleaned = stripTextToolCalls(raw);
          content = cleaned;
          if (cleaned) yield { type: 'delta', content: cleaned };
        } else {
          // 正常情况仍逐帧回放，界面才是「一个字一个字出来」的流式效果
          for (const text of buffered) yield { type: 'delta', content: text };
        }
      }
    } else {
      const res = await agent.invoke({ ...roundReq, stream: false }, ctx);
      content = res.content;
      if (canCallTools) toolCalls.push(...(res.toolCalls ?? []));
      usage = res.usage;
      if (!toolCalls.length) {
        const pseudo = roundTools ? parseTextToolCalls(content, allowedNames) : [];
        if (pseudo.length) {
          toolCalls.push(...pseudo);
          content = '';
        } else {
          content = stripTextToolCalls(content);
        }
      }
      if (req.stream && !toolCalls.length && content) yield { type: 'delta', content };
    }

    if (canCallTools && toolCalls.length) {
      for (const call of toolCalls) {
        yield { type: 'tool_call', name: call.name, args: call.args };
        const result = await executeTool(call.name, call.args);
        yield { type: 'tool_result', name: call.name, ok: result.ok, data: result.data };
        traces.push(summarizeTool(call.name, call.args, result));
        messages.push({
          role: 'tool',
          name: call.name,
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      // 工具轮里的中文旁白也不带回下一轮，免得模型跟着用中文写回信
      messages.push({ role: 'assistant', content: '', tool_calls: toolCalls });
      continue;
    }

    // 外部 AI 偶尔只输出思考、不给正文（或工具轮次耗尽）。别让界面显示空白稿：
    // 用这一轮已经查到的真实资料，交给内置模板补一版，并在「本次由谁起草」里如实标明。
    if (!content.trim()) {
      const fb = routerRef.get('offline-draft') ?? routerRef.get('builtin-offline');
      if (fb) {
        const res = await fb.invoke({ ...req, messages, stream: false }, ctx);
        if (res.content?.trim()) {
          content = res.content;
          agent = fb;
          if (req.stream) yield { type: 'delta', content };
        }
      }
    }
    if (!content.trim()) {
      throw new Error('AI 这次没有写出正文，请再点一次「生成回复稿」；若一直如此，可在「谁来回信」里选内置兜底助手。');
    }

    const finalUsage = usage ?? estimateUsage(messages, content);
    const risk = assessRisk(content, traces);
    // 服务端就把「能发给客户的正文」和「只给客服看的中文」分开，
    // 界面复制按钮直接拿 clean_draft，不需要自己猜该删哪几段。
    const sections = splitDraft(content);
    // 发给客户的外文正文再做一道清洗：外部 AI 偶尔会把中文文件名 / 中文说明写进正文。
    // 客户语种是中文时正文本来就该是中文，不能清洗。
    const locale = String(req.context?.locale ?? '').toLowerCase();
    const lastUser = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');
    const chineseReply = locale.startsWith('zh') || (!locale && /[\u4e00-\u9fa5]/.test(lastUser));
    const clean = chineseReply ? sections.clean : (sanitizeForeignDraft(sections.clean) || sections.clean);
    let translation = sections.translation;
    // 外部 AI 偶尔偷懒不写【中文翻译】。补一次轻量翻译请求，保证「中文对照」这个功能永远在。
    if (clean && !translation && !['builtin-offline', 'offline-draft', 'offline-template'].includes(agent.id)) {
      try {
        const tr = await agent.invoke({
          ...req,
          messages: [
            { role: 'system', content: '你是翻译助手。把用户给的外文客服回复逐句翻译成中文，只输出中文译文，不要重复外文、不要加解释或标记。' },
            { role: 'user', content: clean },
          ],
          tools: undefined,
          stream: false,
        }, ctx);
        const cn = (tr.content ?? '').trim();
        if (cn && /[\u4e00-\u9fa5]/.test(cn)) translation = cn;
      } catch { /* 补翻译失败就留空，界面自动隐藏灰底区，不影响发稿 */ }
    }
    const x_meta: XMeta = {
      clean_draft: clean,
      translation,
      agent: agent.id,
      latency_ms: Date.now() - t0,
      tools_called: traces,
      price_sensitive: risk.price_sensitive,
      need_human_confirm: risk.need_human_confirm,
      sticky,
      failover,
      usage: finalUsage,
    };
    const { recordId } = logAudit(req, x_meta, content);
    x_meta.suggestion_id = recordId;
    x_meta.intent = classifyIntent([...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
    yield { type: 'meta', x_meta };
    yield { type: 'done', usage: finalUsage };
    return {
      content,
      finishReason: 'stop',
      usage: finalUsage,
      x_meta,
      model: agent.cfg.model ?? agent.id,
    };
  }
  throw new Error('tool rounds exhausted without final answer');
}

export async function run(req: UnifiedRequest, opts: RunOptions = {}): Promise<UnifiedResponse> {
  const it = execute(req, opts);
  let step = await it.next();
  while (!step.done) step = await it.next();
  return step.value;
}

export async function* runStream(req: UnifiedRequest, opts: RunOptions = {}): AsyncGenerator<StreamFrame> {
  try {
    yield* execute(req, opts);
  } catch (e) {
    yield { type: 'error', message: (e as Error).message };
  }
}
