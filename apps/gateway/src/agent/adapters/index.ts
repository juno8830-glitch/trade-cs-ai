import type { AgentAdapter, AgentConfig } from '@trade-cs-ai/core';
import { OpenAICompatibleAdapter } from './openaiCompatible.js';
import { LangGraphAdapter } from './langgraph.js';
import { BuiltinOfflineAdapter } from './builtinOffline.js';

/** 新增 Agent：① 实现 AgentAdapter ② 在此注册一种 adapter kind ③ agents.yaml 加配置 */
export function createAdapter(cfg: AgentConfig): AgentAdapter {
  switch (cfg.adapter) {
    case 'openai_compatible':
      return new OpenAICompatibleAdapter(cfg);
    case 'custom_langgraph':
      return new LangGraphAdapter(cfg);
    case 'builtin_offline':
      return new BuiltinOfflineAdapter(cfg);
    default:
      throw new Error(`unknown adapter kind: ${(cfg as AgentConfig).adapter}`);
  }
}
