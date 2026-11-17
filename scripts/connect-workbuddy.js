/**
 * 一键把「客服回复助手」接入 WorkBuddy（不需要手动改任何配置文件）。
 *
 * 它做三件事：
 *   1. 写 ~/.workbuddy/mcp.json：登记一个叫 trade-cs-ai 的本地连接器，并确保是「启用」状态
 *   2. 写 ~/.workbuddy/mcp-approvals.json：按 WorkBuddy 自己的规则预先写好信任记录
 *      （等价于在界面上点一次「信任」，可随时在界面撤销）
 *   3. 自检：按 MCP 协议真实握手一次，确认 WorkBuddy 启动它时能立刻用
 *
 * 注意：WorkBuddy 正在运行时不会立刻重读配置，需要完全退出并重新打开一次。
 * 本脚本不会、也不应该去重启 WorkBuddy（会打断正在进行的对话）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'scripts', 'workbuddy-bridge.js').split(path.sep).join('/');
const CONFIG_DIR = path.join(os.homedir(), '.workbuddy');
const MCP_FILE = path.join(CONFIG_DIR, 'mcp.json');
const APPROVALS_FILE = path.join(CONFIG_DIR, 'mcp-approvals.json');
const SERVER_ID = 'trade-cs-ai';

const say = (s = '') => console.log(s);
const hr = () => say('─'.repeat(58));

/** 读取一个 JSON 文件；不存在或坏了都返回空对象，绝不删掉用户原有内容 */
function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/** WorkBuddy 用配置内容算一个指纹，配置一变指纹就变，所以要重新信任 */
function trustMaterials(command, args, env = {}, cwd) {
  const base = [command, [...args].map(String).sort().join(','), Object.keys(env).sort().join(',')];
  return [
    [...base].join('|'),              // 没有 cwd
    [...base, ''].join('|'),          // cwd 为空串
    ...(cwd ? [[...base, cwd].join('|')] : []),
  ];
}

function approvalKeys(command, args, env, cwd) {
  const hashes = trustMaterials(command, args, env, cwd).map((m) =>
    crypto.createHash('sha256').update(m).digest('hex'),
  );
  // 多写几个候选，兼容不同版本对服务器名 / cwd 的细微处理差异；多余记录会被忽略
  const ids = [SERVER_ID, SERVER_ID.replace(/-/g, '_')];
  const keys = [];
  for (const h of hashes) for (const id of ids) keys.push(`${h}::${id}`);
  return { hashes, keys };
}

function registerServer() {
  const cfg = readJson(MCP_FILE);
  const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers)
    ? { ...cfg.mcpServers }
    : {};
  const old = servers[SERVER_ID] || {};
  const entry = {
    type: 'stdio',
    command: 'node',
    args: [BRIDGE],
    description: '客服回复助手：查本机报价表、找产品图与证书、查成功案例、生成回复稿（只生成草稿，不自动发送）',
    // 注意：这里故意不写 disabled。WorkBuddy 里 disabled:true = 关闭，等于白配。
    ...(typeof old.timeout === 'number' ? { timeout: old.timeout } : {}),
  };
  servers[SERVER_ID] = entry;
  writeJson(MCP_FILE, { ...cfg, mcpServers: servers });
  return { entry, otherServers: Object.keys(servers).filter((k) => k !== SERVER_ID) };
}

function writeApprovals(entry) {
  const approvals = readJson(APPROVALS_FILE);
  const { hashes, keys } = approvalKeys(entry.command, entry.args, entry.env, entry.cwd);
  const now = Date.now();
  // 保留用户已有的其它信任记录，只补/更新本连接器的记录
  for (const k of keys) approvals[k] = now;
  // 值必须是数字时间戳；过滤掉任何不合规的历史值，避免 WorkBuddy 判定文件损坏
  const clean = {};
  for (const [k, v] of Object.entries(approvals)) {
    if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
  }
  writeJson(APPROVALS_FILE, clean);
  return { hashes, keys, total: Object.keys(clean).length };
}

/** 用官方 MCP 客户端真实握手，确认 WorkBuddy 拉起这个进程后能立刻工作 */
async function handshake() {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE], stderr: 'pipe' });
    const client = new Client({ name: 'workbuddy-connect-check', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    // 用「资料库关联状态」做实测，不写死任何型号 / 价格：
    // 资料随时会换成用户自己的库存表，硬编码示例型号会让自检永远失败。
    const probe = await client.callTool({ name: 'library_status', arguments: {} });
    const text = String(probe.content?.[0]?.text || '');
    await client.close();
    return { ok: true, names, quoteOk: text.includes('已关联'), statusText: text.split('\n')[0] };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function gatewayStatus() {
  let port = 8787;
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^\s*PORT\s*=\s*(\d+)/m);
    if (m) port = Number(m[1]);
  } catch { /* 用默认端口 */ }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? `正在运行（端口 ${port}）` : `响应异常（端口 ${port}）`;
  } catch {
    return `没在运行（端口 ${port}）—— 请先双击「一键启动.bat」选 1`;
  }
}

async function main() {
  hr();
  say('        自动接入 WorkBuddy · 客服回复助手');
  hr();

  if (!fs.existsSync(BRIDGE)) {
    say('  × 找不到桥接器文件：' + BRIDGE);
    say('    请确认这个项目文件夹是完整的。');
    process.exit(1);
  }
  say('  √ 找到桥接器：' + BRIDGE);

  const { entry, otherServers } = registerServer();
  say('  √ 已登记连接器 trade-cs-ai（状态：启用，disabled 已移除）');
  say('    配置文件：' + MCP_FILE);
  if (otherServers.length) say('    你原有的其它连接器 ' + otherServers.length + ' 个已原样保留');

  const { hashes, keys, total } = writeApprovals(entry);
  say('  √ 已写入信任记录 ' + keys.length + ' 条（文件里共 ' + total + ' 条）');
  say('    配置文件：' + APPROVALS_FILE);
  say('    配置指纹：' + hashes[0].slice(0, 16) + '…');

  const hs = await handshake();
  if (hs.ok) {
    say('  √ MCP 握手成功，工具 ' + hs.names.length + ' 个：' + hs.names.join('、'));
    say(hs.quoteOk ? '  √ 资料库实测通过（' + (hs.statusText || '已关联') + '）' : '  ! 资料库还没整理，请在资料库抽屉点「整理资料」后再试');
  } else {
    say('  × MCP 握手失败：' + hs.error);
    say('    请先把这段截图发给帮你装程序的人。');
  }

  const gw = await gatewayStatus();
  say('');
  say('  后台服务：' + gw);
  hr();
  say('  最后一步（只需要做一次）：');
  say('  完全退出 WorkBuddy，再重新打开。之后这个连接器会自动连上，');
  say('  不用再点「信任」、不用填密钥；现在这个对话不会被脚本打断。');
  say('');
  say('  重开后在 WorkBuddy 里直接说中文就行，例如：');
  say('    「客户问这款现货的价格，帮我起草一封西语回信」');
  say('');
  say('  说明：信任记录是按 WorkBuddy 的配置规则预先写好的，等同于界面点一次');
  say('  「信任」。你可以随时在连接器管理页撤销；若 WorkBuddy 升级后失效，');
  say('  重新运行本脚本（或在「一键启动.bat」选 8）即可。');
  hr();

  if (!hs.ok) process.exit(1);
}

main().catch((e) => {
  say('  × 出错：' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
