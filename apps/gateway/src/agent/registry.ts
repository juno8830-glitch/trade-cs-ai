import type { AgentAdapter, GatewayConfig } from '@trade-cs-ai/core';
import { createAdapter } from './adapters/index.js';

export class Registry {
  private readonly map = new Map<string, AgentAdapter>();

  constructor(config: GatewayConfig) {
    for (const ac of config.agents) {
      if (ac.enabled === false) continue;
      if (this.map.has(ac.id)) throw new Error(`duplicate agent id: ${ac.id}`);
      this.map.set(ac.id, createAdapter(ac));
    }
  }

  all(): AgentAdapter[] {
    return [...this.map.values()];
  }

  get(id: string): AgentAdapter | undefined {
    return this.map.get(id);
  }

  /** 支持客户端用 model 指定 "qwen-max" / "gpt-4o" / agent id */
  resolveByModel(model: string): AgentAdapter | undefined {
    if (!model || model === 'auto') return undefined;
    return this.get(model) ?? this.all().find((a) => a.cfg.model === model);
  }
}
