import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { AgentConfig, GatewayConfig, RouterConfig } from '@trade-cs-ai/core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 极简 .env 加载（不依赖 dotenv，避免密钥落进任何日志）
 *
 *  新手最常见的困惑：「我明明在菜单里填了密钥，为什么界面还是显示没连上？」
 *  原因是老版本只在程序启动那一刻读一次 .env。现在每次取密钥前都会检查文件是否被改过，
 *  改过就立刻更新，不用退出重开（只有改 AI 名单 / 模型名才需要重启）。
 */
const ENV_FILE = path.join(ROOT, '.env');
let envStamp = '';
const envValues = new Map<string, string>();

function loadDotEnv(): void {
  let next = new Map<string, string>();
  let stamp = '';
  try {
    const file = ENV_FILE;
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === envStamp) return; // 没改过，直接用现有值
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 1) continue;
      const key = s.slice(0, eq).trim();
      let val = s.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      next.set(key, val);
    }
    envStamp = stamp;
  } catch {
    // 文件不存在或读失败：当作「没有 .env」，不覆盖真实环境变量
    envStamp = '__missing__';
  }
  // 之前由 .env 提供、现在被删掉的键，若没被外部环境变量改过就清掉
  for (const [k, old] of envValues) {
    if (!next.has(k) && process.env[k] === old) delete process.env[k];
  }
  // 外部显式设置的环境变量优先级更高；只有「没设置」或「仍是上次 .env 的值」才覆盖
  for (const [k, v] of next) {
    const old = envValues.get(k);
    if (process.env[k] === undefined || process.env[k] === old) process.env[k] = v;
  }
  envValues.clear();
  for (const [k, v] of next) envValues.set(k, v);
}
loadDotEnv();

export interface RuntimeConfig {
  root: string;
  port: number;
  host: string;
  clientToken: string;
  wechatToken: string;
  kbRoot: string;
  dbPath: string;
  rendererDir: string;
  agents: AgentConfig[];
  router: RouterConfig;
}

const DEFAULT_ROUTER: RouterConfig = {
  strategy: 'weighted_with_health_check',
  stickySession: true,
  failoverTimeoutMs: 8000,
  healthTtlMs: 10000,
  healthTimeoutMs: 800,
  maxToolRounds: 3,
  requestTimeoutMs: 30000,
};

/** agents.yaml 里允许写 endpointEnv / modelEnv，用 .env 里的值覆盖默认地址与模型名。
 *  这样接任何一家「OpenAI 兼容」服务都不用改代码、也不用看懂 YAML。 */
type RawAgentConfig = AgentConfig & { endpointEnv?: string; modelEnv?: string };

function readAgentsYaml(): GatewayConfig {
  const file = path.join(ROOT, 'config', 'agents.yaml');
  const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as Partial<GatewayConfig>;
  if (!parsed || !Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    throw new Error(`config/agents.yaml 缺少 agents 列表`);
  }
  const ids = new Set<string>();
  for (const a of parsed.agents as RawAgentConfig[]) {
    if (!a.id || !a.adapter || !a.capabilities || !a.route) {
      throw new Error(`agents.yaml 中存在字段不全的 Agent: ${JSON.stringify(a)}`);
    }
    if (ids.has(a.id)) throw new Error(`agents.yaml 中 Agent id 重复: ${a.id}`);
    ids.add(a.id);
    if (a.endpointEnv) {
      const v = process.env[a.endpointEnv]?.trim();
      if (v) a.endpoint = v;
      delete a.endpointEnv;
    }
    if (a.modelEnv) {
      const v = process.env[a.modelEnv]?.trim();
      if (v) a.model = v;
      delete a.modelEnv;
    }
    a.route.scenarios = Array.isArray(a.route.scenarios) ? a.route.scenarios : ['*'];
    a.route.weight = Number(a.route.weight ?? 0);
    a.route.priority = Number(a.route.priority ?? 50);
    a.fallback = Array.isArray(a.fallback) ? a.fallback : [];
    a.enabled = a.enabled !== false;
  }
  return { agents: parsed.agents as AgentConfig[], router: { ...DEFAULT_ROUTER, ...(parsed.router ?? {}) } };
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(ROOT, p);
}

const yamlCfg = readAgentsYaml();

export const cfg: RuntimeConfig = {
  root: ROOT,
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  clientToken: process.env.CLIENT_TOKEN ?? 'dev-client-token-change-me',
  wechatToken: process.env.WECHAT_TOKEN ?? '',
  kbRoot: resolveFromRoot(process.env.KB_ROOT ?? 'data/客服资料库'),
  dbPath: resolveFromRoot(process.env.DB_PATH ?? 'data/gateway.db'),
  rendererDir: path.join(ROOT, 'apps', 'desktop', 'src', 'renderer'),
  agents: yamlCfg.agents,
  router: yamlCfg.router,
};

/** 密钥只在网关侧解析；env:XXX 引用未配置时返回 undefined。
 *  每次调用前刷新 .env：菜单里改完密钥，不用重启后台服务就能生效。 */
export function resolveSecret(ref?: string): string | undefined {
  loadDotEnv();
  if (!ref) return undefined;
  if (ref.startsWith('env:')) {
    const v = process.env[ref.slice(4)];
    return v && v.trim() ? v.trim() : undefined;
  }
  return ref;
}

export function getAgentConfig(id: string): AgentConfig | undefined {
  return cfg.agents.find((a) => a.id === id);
}

export function isDevToken(): boolean {
  return cfg.clientToken === 'dev-client-token-change-me';
}
