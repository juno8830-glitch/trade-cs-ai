import type { AgentAdapter, HealthResult, UnifiedRequest } from '@trade-cs-ai/core';
import type { RuntimeConfig } from '../config.js';
import type { Registry } from '../agent/registry.js';

export class NoHealthyAgentError extends Error {
  readonly code = 'NO_HEALTHY_AGENT';
  readonly statusCode = 503;
  constructor(scenario: string) {
    super(`AI 暂不可用（场景 ${scenario} 无健康 Agent），请手动回复`);
    this.name = 'NoHealthyAgentError';
  }
}

export interface PickResult {
  agent: AgentAdapter;
  sticky: boolean;
  failover: string[];
  scenario: string;
}

const KNOWN_SCENARIOS = new Set(['promote', 'negotiate', 'followup', 'complex_quote', 'draft_only']);

function scenarioOf(req: UnifiedRequest): string {
  const explicit = req.context?.scenario;
  if (explicit && typeof explicit === 'string') return explicit;
  const stage = req.context?.customer?.stage;
  const mapped: Record<string, string> = {
    inquiry: 'promote',
    new: 'promote',
    sample_done: 'negotiate',
    quote_sent: 'followup',
    complex: 'complex_quote',
    draft: 'draft_only',
  };
  if (stage && mapped[stage]) return mapped[stage];
  if (stage && KNOWN_SCENARIOS.has(stage)) return stage;
  return 'promote';
}

export class Router {
  private readonly healthCache = new Map<string, { at: number; res: HealthResult }>();
  private readonly inflight = new Map<string, Promise<HealthResult>>();
  private readonly sticky = new Map<string, string>();

  constructor(private readonly registry: Registry, private readonly config: RuntimeConfig) {}

  private async health(agent: AgentAdapter): Promise<HealthResult> {
    const cached = this.healthCache.get(agent.id);
    if (cached && Date.now() - cached.at < this.config.router.healthTtlMs) return cached.res;
    const running = this.inflight.get(agent.id);
    if (running) return running;
    const p = agent.health().then((res) => {
      this.healthCache.set(agent.id, { at: Date.now(), res });
      this.inflight.delete(agent.id);
      return res;
    });
    this.inflight.set(agent.id, p);
    return p;
  }

  get(id: string): AgentAdapter | undefined {
    return this.registry.get(id);
  }

  /** 刚在菜单里改完密钥、或用户点了「重新检测」时，清掉探活缓存立刻重连一次。
   *  否则最长要等 healthTtlMs（默认 10 秒）才看得到「已连上」。 */
  invalidateHealth(id?: string): void {
    if (id) this.healthCache.delete(id);
    else this.healthCache.clear();
  }

  async snapshot(): Promise<Array<Record<string, unknown>>> {
    const agents = this.registry.all();
    const results = await Promise.all(agents.map((a) => this.health(a)));
    return agents.map((a, i) => ({
      id: a.id,
      adapter: a.cfg.adapter,
      model: a.cfg.model ?? null,
      healthy: results[i].ok,
      latency_ms: results[i].latencyMs,
      detail: results[i].detail ?? null,
      capabilities: a.capabilities,
      route: a.cfg.route,
      fallback: a.cfg.fallback ?? [],
      sticky_sessions: [...this.sticky.values()].filter((x) => x === a.id).length,
    }));
  }

  async pick(req: UnifiedRequest): Promise<PickResult> {
    const scenario = scenarioOf(req);
    const candidates = this.registry.all().filter((a) => {
      if (!a.cfg.route.scenarios.includes(scenario) && !a.cfg.route.scenarios.includes('*')) return false;
      if (req.tools?.length && !a.capabilities.toolCalling) return false;
      if (req.vision && !a.capabilities.vision) return false;
      return true;
    });

    if (!candidates.length) throw new NoHealthyAgentError(scenario);

    const health = new Map<string, boolean>();
    await Promise.all(
      candidates.map(async (a) => {
        health.set(a.id, (await this.health(a)).ok);
      }),
    );
    const failover = candidates.filter((a) => !health.get(a.id)).map((a) => a.id);
    const healthy = candidates.filter((a) => health.get(a.id));

    const sessionId = req.context?.session_id;
    const stickyId = this.config.router.stickySession && sessionId ? this.sticky.get(sessionId) : undefined;
    if (stickyId) {
      const stickyAgent = healthy.find((a) => a.id === stickyId);
      if (stickyAgent) return { agent: stickyAgent, sticky: true, failover, scenario };
    }

    // 显式指定 model / agent_hint.preferred 优先
    const preferred =
      this.registry.resolveByModel(req.model)?.id ??
      req.agent_hint?.preferred ??
      undefined;
    const preferredAgent = preferred ? healthy.find((a) => a.id === preferred) : undefined;

    let chosen = preferredAgent;
    if (!chosen && healthy.length) {
      const minPriority = Math.min(...healthy.map((a) => a.cfg.route.priority));
      const group = healthy.filter((a) => a.cfg.route.priority === minPriority);
      if (this.config.router.strategy === 'weighted_random') {
        const total = group.reduce((n, a) => n + Math.max(0, a.cfg.route.weight), 0);
        let r = Math.random() * (total || 1);
        chosen = group.find((a) => (r -= Math.max(0, a.cfg.route.weight)) <= 0) ?? group[0];
      } else {
        chosen = [...group].sort((a, b) => b.cfg.route.weight - a.cfg.route.weight)[0];
      }
    }

    // 首选不可用时按 fallback 链继续找
    if (!chosen) {
      const chain = [...(req.agent_hint?.fallback ?? []), ...this.registry.all().flatMap((a) => a.cfg.fallback ?? [])];
      for (const id of chain) {
        if (health.get(id)) {
          const a = this.registry.get(id);
          if (a) {
            chosen = a;
            break;
          }
        }
      }
    }
    if (!chosen) throw new NoHealthyAgentError(scenario);

    if (sessionId && this.config.router.stickySession) this.sticky.set(sessionId, chosen.id);
    return { agent: chosen, sticky: false, failover, scenario };
  }
}
