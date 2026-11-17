/**
 * 新手一键启动器（中文菜单）
 * 不需要记任何命令：双击项目根目录的「一键启动.bat」即可。
 * 本文件只做「准备工作 + 菜单」，真正的业务代码在 apps/ 目录里。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const NPM = WIN ? 'npm.cmd' : 'npm';
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', WIN ? 'electron.exe' : 'electron');
const MANUAL = path.join(ROOT, '使用说明书.html');
const SCRIPTS = path.join(ROOT, 'data', '话术库.json');
const KB = path.join(ROOT, 'data', '客服资料库');
const ENV_FILE = path.join(ROOT, '.env');
const BRIDGE = path.join(ROOT, 'scripts', 'workbuddy-bridge.js').split(path.sep).join('/');
const WB_DIR = path.join(os.homedir(), '.workbuddy');
const CONNECT_SCRIPT = path.join(ROOT, 'scripts', 'connect-workbuddy.js');
const rl = readline.createInterface({ input, output });

let ownedGateway = null; // 本启动器亲自启动的后台服务（退出时要一起关掉）

const say = (s = '') => console.log(s);
const hr = () => say('='.repeat(56));
const pause = async () => { try { await rl.question('\n按回车键返回菜单…'); } catch { /* 输入已结束 */ } };
const ask = async (q) => { try { return String(await rl.question(q)).trim(); } catch { return '0'; } };

/** 运行一条命令，把输出直接显示在这个黑窗口里 */
function run(cmd, args, quiet = false) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: quiet ? 'ignore' : 'inherit',
      shell: WIN && cmd === NPM,
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (e) => { say('  启动失败：' + e.message); resolve(1); });
  });
}

/** 用系统默认程序打开网页、文件或文件夹 */
function open(target) {
  if (WIN) {
    const p = spawn('cmd.exe', ['/c', 'start', '', target], { cwd: ROOT, detached: true, stdio: 'ignore' });
    p.on('error', () => say('  打开失败，请手动打开：' + target));
    p.unref();
  } else {
    const bin = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(bin, [target], () => {});
  }
}

/** 读取 .env 为普通对象（不修改任何环境变量） */
function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** 把某一项写回 .env，其余内容和注释原样保留 */
function writeEnvItem(key, value) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  let found = false;
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (m && m[1] === key) { found = true; return `${key}=${value}`; }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, next.join('\n').replace(/\n+$/, '\n'), 'utf8');
}

const base = () => `http://127.0.0.1:${readEnv().PORT || 8787}`;

const AGENT_CN = {
  'zhipu-glm': '智谱 GLM',
  'bailian-qwen': '阿里云通义千问',
  'openai-thirdparty': 'OpenAI / 第三方',
  'local-llama': '本机 Ollama',
  'self-hosted-graph': '公司自研 AI 服务',
  'offline-draft': '离线起草助手',
  'builtin-offline': '内置兜底助手',
};

/** 把网关返回的英文错误翻成中文，新手不用猜 */
function explainDetail(d) {
  const s = String(d || '');
  if (/missing credential/.test(s)) return '这一栏还没填密钥';
  if (/40[13]\b/.test(s)) return '密钥不对 / 没权限';
  if (/402\b/.test(s)) return '账户余额不足 / 欠费';
  if (/404\b/.test(s)) return '接口地址不对';
  if (/429\b/.test(s)) return '调用太频繁，稍后再试';
  if (/fetch failed|timeout|aborted|ENOTFOUND|ECONN|network/i.test(s)) return '连不上（没网、被防火墙挡，或服务没开）';
  return s || '原因未知';
}

/** 真发一次 HTTP 请求验证密钥，不靠「文件里有值」就说连上了 */
async function testKey({ label, endpoint, key, model }) {
  say('  正在连接 ' + label + '（大约 2～8 秒）…');
  try {
    const r = await fetch(endpoint.replace(/\/+$/, '') + '/models', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) {
      // 有些兼容服务没有「模型列表」接口，改用一条最小对话再验证一次
      if (r.status === 404 || r.status === 405) {
        say('    这个服务没有「模型列表」接口，改用一条最小对话再试…');
        try {
          const chat = await fetch(endpoint.replace(/\/+$/, '') + '/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
            signal: AbortSignal.timeout(9000),
          });
          if (chat.ok) { say('  √ 连上了！' + label + ' 已接受这串密钥，可以正常对话。'); return true; }
          say('  × 没连上：' + explainDetail('HTTP ' + chat.status));
          return false;
        } catch (e2) {
          say('  × 没连上：' + explainDetail(e2 && e2.message));
          return false;
        }
      }
      say('  × 没连上：' + explainDetail('HTTP ' + r.status));
      if (r.status === 401 || r.status === 403) {
        say('    常见原因：密钥复制少了字符 / 多了空格、密钥已停用、或填到了别家的栏位。');
      }
      if (r.status === 402) say('    请到对应网站充值后再试。');
      return false;
    }
    let ids = [];
    try {
      const j = await r.json();
      ids = (j.data || []).map((x) => x.id || x.name).filter(Boolean);
    } catch { /* 有些服务不返回模型列表，连上就够了 */ }
    say('  √ 连上了！' + label + ' 已接受这串密钥。');
    if (ids.length) {
      say('    这个账号能用的模型：' + ids.slice(0, 8).join('、') + (ids.length > 8 ? ' 等' : ''));
      if (model && !ids.includes(model)) {
        say('    ! 程序里写的模型是 ' + model + '，但上面的列表里没有它。请在菜单里换模型，或改 .env 里的 ZHIPU_MODEL。');
      }
    }
    return true;
  } catch (e) {
    say('  × 没连上：' + explainDetail(e && e.message));
    say('    请检查电脑能不能上网、代理 / 防火墙是否拦住了这个地址。');
    return false;
  }
}

/** 列出网关里每个 AI 的真实连接状态（清掉缓存重新探测） */
async function showAgentStatus() {
  await ensureGateway(true);
  if (!(await isUp())) { say('  × 后台服务没起来，暂时没法检查。'); return; }
  try {
    const r = await fetch(base() + '/v1/agents?refresh=1', { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    say('');
    say('  当前 AI 连接状态（刚刚重新探测过）：');
    for (const a of j.data || []) {
      const name = AGENT_CN[a.id] || a.id;
      if (a.healthy) say('   √ 已连上    ' + name + (a.model ? '（' + a.model + '）' : ''));
      else say('   · 暂不可用  ' + name + '  ← ' + explainDetail(a.detail));
    }
    const online = (j.data || []).filter((a) => a.healthy && !['builtin-offline', 'offline-draft'].includes(a.id));
    say('');
    if (online.length) say('  √ 有 ' + online.length + ' 个联网 AI 可用。回到界面点一下左上角状态标签，会显示「已连上 ✓」。');
    else say('  ! 目前只有内置兜底助手可用。想让窗口用真 AI，请先在菜单 5 填对应密钥。');
  } catch (e) {
    say('  × 检查失败：' + (e && e.message ? e.message : String(e)));
  }
}

/** 老版本把智谱密钥填在「第三方」栏里会永远连不上，这里自动搬到正确位置 */
function autoFixZhipuKey() {
  const env = readEnv();
  if (env.ZHIPU_API_KEY) return;
  const third = env.OPENAI_COMPAT_API_KEY || '';
  // 智谱密钥形如「数字字母串.数字字母串」，OpenAI / 阿里云的一般是 sk- 开头
  if (!/^[A-Za-z0-9]{8,}\.[A-Za-z0-9]{8,}$/.test(third)) return;
  writeEnvItem('ZHIPU_API_KEY', third);
  writeEnvItem('OPENAI_COMPAT_API_KEY', '');
  say('  √ 检测到智谱密钥填在了「第三方」那一栏，已自动搬到智谱专用位置（这才是正确的地方）。');
}

/** 判断 WorkBuddy 连接器是否已经登记、启用并且已信任；坏了或缺了就自动补上 */
function needsConnect() {
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(WB_DIR, 'mcp.json'), 'utf8'));
    const entry = mcp.mcpServers?.['trade-cs-ai'];
    if (!entry || entry.disabled === true) return true;
    const approvals = JSON.parse(fs.readFileSync(path.join(WB_DIR, 'mcp-approvals.json'), 'utf8'));
    const material = ['node', [BRIDGE].map(String).sort().join(','), ''].join('|');
    const hash = crypto.createHash('sha256').update(material).digest('hex');
    return !Object.keys(approvals).some((k) => k.startsWith(hash + '::'));
  } catch {
    return true;
  }
}

async function autoConnect() {
  if (!fs.existsSync(CONNECT_SCRIPT)) return;
  if (!needsConnect()) {
    say('  √ WorkBuddy 连接器已就绪（不用重新配置）');
    return;
  }
  say('  √ 正在自动接入 WorkBuddy（写配置 + 信任记录 + 握手自检）…');
  const code = await run(process.execPath, [CONNECT_SCRIPT], true);
  if (code === 0) {
    say('  √ 已自动接入。WorkBuddy 完全退出并重新打开一次后即可直接使用。');
  } else {
    say('  ! 自动接入没成功，可在菜单选 8 重试（不影响浏览器版使用）。');
  }
}

async function isUp() {
  try {
    const r = await fetch(base() + '/v1/health', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function waitUp(seconds = 25) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await isUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 确保后台服务在跑；已经在跑就复用，不重复启动 */
async function ensureGateway(quiet = false) {
  if (await isUp()) {
    say('  √ 后台服务已经在运行，直接打开界面。');
    return null;
  }
  say('  正在启动后台服务…');
  const child = spawn(process.execPath, [TSX, 'apps/gateway/src/server.ts'], {
    cwd: ROOT,
    stdio: quiet ? 'ignore' : 'inherit',
  });
  ownedGateway = child;
  child.on('exit', (code) => {
    if (ownedGateway === child) {
      ownedGateway = null;
      if (code) say(`  ! 后台服务停止了（退出码 ${code}）。可先看菜单 4 做一次体检。`);
    }
  });
  if (!(await waitUp())) {
    say('');
    say('  × 服务没能启动。最常见的原因：端口被别的程序占用了。');
    say('    解决办法：打开《使用说明书》→「常见问题」第 2 条，或把 .env 里的 PORT 改成 8788。');
    child.kill();
    ownedGateway = null;
    return null;
  }
  say('  √ 后台服务已就绪。');
  return child;
}

function waitExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

/** 第一次运行：检查环境、装依赖、生成默认配置和示例资料 */
async function bootstrap() {
  hr();
  say('            客服回复助手  ·  一键启动');
  say('  你不用懂编程：全程只要输入数字、按回车、复制粘贴。');
  hr();

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    say(`  × 电脑上的 Node.js 版本太旧（当前 ${process.versions.node}，需要 22 或更高）。`);
    say('    请打开 https://nodejs.org/ ，点左边绿色的 LTS 按钮下载，安装时一路点「下一步」，');
    say('    装完后重新双击「一键启动.bat」。');
    await pause();
    process.exit(1);
  }
  say(`  √ 运行环境正常（Node.js ${process.versions.node}）`);

  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'fastify')) || !fs.existsSync(TSX)) {
    say('');
    say('  第一次使用：正在自动安装所需组件，大约 1～3 分钟，请不要关闭这个窗口…');
    const code = await run(NPM, ['install', '--no-audit', '--no-fund']);
    if (code !== 0 || !fs.existsSync(TSX)) {
      say('  × 组件安装失败。请检查网络是否通畅，然后重新双击「一键启动.bat」再试一次。');
      await pause();
      process.exit(1);
    }
    say('  √ 组件安装完成');
  } else {
    say('  √ 所需组件齐全');
  }

  if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(path.join(ROOT, '.env.example'), ENV_FILE);
    say('  √ 已自动生成配置文件 .env（默认就能用，不用改）');
  }
  autoFixZhipuKey();

  const hasQuote = fs.existsSync(KB) && fs.readdirSync(KB).some((f) => f.endsWith('.xlsx'));
  if (!hasQuote) {
    say('  √ 正在生成示例报价表和资料，方便你先练手…');
    await run(process.execPath, [TSX, 'scripts/seed.ts'], true);
  }
  await autoConnect();
  say('');
}

function showMenu() {
  hr();
  say('  请选择要做什么（输入数字后按回车）：');
  say('');
  say('   1  启动【浏览器版】★推荐：自动打开操作界面');
  say('   2  启动【桌面窗口版】：窗口常驻显示，按 Ctrl+Shift+X 隐藏 / 再按显示');
  say('   3  只启动后台服务（不打开界面，给懂一点的人用）');
  say('   4  给程序做一次体检（检查哪里坏了）');
  say('   5  填写 AI 密钥 / 检查连接（智谱、阿里云等）');
  say('   6  打开《使用说明书》');
  say('   7  打开「我的资料」文件夹（放自己的报价表、图片、证书）');
  say('   8  重新自动接入 WorkBuddy（升级后失效时用）');
  say('   9  打开「话术库」（用记事本改经验，或看看学到了什么）');
  say('   10 🗂 整理我的资料库（把报价表变成 AI 能查的资料，加过文件就点一下）');
  say('   0  退出');
  say('');
  say('   WorkBuddy：界面右上角的小标签可一键检查是否已连上（说明书第 11 节）。');
  say('   第三方 AI（智谱 / 阿里云）：看界面左上角状态标签；点一下可重新检查，菜单 5 → 5 会列出每个 AI 的真实状态。');
  say('   右上角「连接器：已连上」= WorkBuddy；左上角「智谱 GLM：已连上」= 本窗口用的 AI。两者不是一回事。');
  say('   话术越用越聪明：回信有结果后，在界面点「成了 / 没成」，或让 WorkBuddy 说「帮我优化话术」（第 12 节）。');
  say('   资料库：把报价表丢进「我的资料」文件夹 → 选 10 或点界面「一键整理资料」（第 16 节）；程序也会每 30 分钟自动整理。');
  hr();
}

async function actionBrowser() {
  const child = await ensureGateway();
  if (!(await isUp())) { await pause(); return; }
  open(base() + '/app/');
  say('');
  say('  √ 操作界面已在浏览器打开。');
  say('  ┌──────────────────────────────────────────────┐');
  say('  │ 这个黑窗口要一直开着！关掉它 = 程序停止。      │');
  say('  │ 用完回来按 Ctrl+C，或者关掉窗口即可。          │');
  say('  └──────────────────────────────────────────────┘');
  if (child) await waitExit(child);
  else await pause();
}

async function actionDesktop() {
  if (!fs.existsSync(ELECTRON)) {
    say('');
    say('  × 桌面窗口版还没有装好（缺少 Electron 程序文件）。');
    say('    不影响使用：请选 1 用浏览器版，功能完全一样。');
    await pause();
    return;
  }
  const child = await ensureGateway();
  if (!(await isUp())) { await pause(); return; }
  say('');
  say('  √ 正在打开桌面窗口。窗口常驻显示，按 Ctrl+Shift+X 隐藏 / 再按显示；右下角托盘可换快捷键。');
  await run(ELECTRON, [path.join(ROOT, 'apps', 'desktop')]);
  say('  桌面窗口已关闭。后台服务还在运行，可以继续用菜单 1 打开浏览器版。');
  await pause();
}

async function actionService() {
  const child = await ensureGateway();
  if (!(await isUp())) { await pause(); return; }
  say('');
  say('  √ 后台服务运行中：' + base());
  say('    自己打开浏览器访问：' + base() + '/app/');
  say('    这个黑窗口要一直开着，关掉它 = 程序停止。');
  if (child) await waitExit(child);
  else await pause();
}

async function actionCheck() {
  say('');
  say('  正在逐项检查（大约 10 秒）…');
  const temp = await ensureGateway(true);
  if (!(await isUp())) { await pause(); return; }
  const code = await run(NPM, ['run', 'smoke']);
  hr();
  if (code === 0) say('  √ 体检通过：全部功能正常，可以放心使用。');
  else say('  × 体检发现问题：请把上面写着「未通过」的几行截图，发给帮你装程序的人。');
  say('    小提示：看到「通过」两个字就是好的，看到「未通过」才需要处理。');
  hr();
  if (temp && ownedGateway === temp) { temp.kill(); ownedGateway = null; }
  await pause();
}

async function actionKeys() {
  const env = readEnv();
  hr();
  say('  第 1 步：选一个你想用的 AI（不填也能用，程序自带离线兜底）');
  say('');
  say('   1  智谱 GLM / BigModel ★推荐   ' + (env.ZHIPU_API_KEY ? '【已填写】' : '【未填写】'));
  say('   2  阿里云百炼 / 通义千问      ' + (env.DASHSCOPE_API_KEY ? '【已填写】' : '【未填写】'));
  say('   3  OpenAI 或兼容的第三方      ' + (env.OPENAI_COMPAT_API_KEY ? '【已填写】' : '【未填写】'));
  say('   4  本机 Ollama（免费，不用密钥，只需本机装好并运行）');
  say('   5  检测所有 AI 现在能不能连上（会真发一次请求）');
  say('   6  清空全部密钥（回到纯离线模式）');
  say('   0  返回主菜单');
  hr();
  const c = await ask('  请输入数字后按回车：');

  const targets = {
    '1': {
      key: 'ZHIPU_API_KEY', label: '智谱 GLM',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: env.ZHIPU_MODEL || 'glm-4.5-air',
      where: '打开 https://open.bigmodel.cn/ → 右上角「API Keys」→ 创建并复制。',
      extra: '   密钥样子是「一串数字.一串字母」，不是 sk- 开头。默认用 glm-4.5-air（快、够用）。',
    },
    '2': {
      key: 'DASHSCOPE_API_KEY', label: '阿里云百炼',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max',
      where: '打开 https://bailian.console.aliyun.com/ →「API-KEY 管理」→ 创建 API-KEY。',
      extra: '   复制那串以 sk- 开头的字符。',
    },
    '3': {
      key: 'OPENAI_COMPAT_API_KEY', label: 'OpenAI / 第三方',
      endpoint: env.OPENAI_COMPAT_ENDPOINT || 'https://api.openai.com/v1', model: env.OPENAI_COMPAT_MODEL || 'gpt-4o',
      where: '打开你购买 AI 服务的网站，在「API Keys / 密钥管理」里创建并复制。',
      extra: '   ★ 智谱的密钥不要填这里！请返回上一步选 1，否则会一直显示「暂不可用」。',
    },
  };
  const target = targets[c];
  if (target) {
    say('');
    say('  去哪拿密钥：' + target.where);
    say(target.extra);
    const v = await ask('  把密钥粘贴进来后按回车（直接回车 = 取消）：');
    if (v) {
      writeEnvItem(target.key, v);
      say('  √ 已保存到 .env（界面上看不到密钥，也不会发给客户）。');
      say('');
      await testKey({ ...target, key: v });
      say('');
      say('  √ 密钥改动会即时生效：回到界面，点一下左上角的状态标签重新检查即可。');
      say('    只有改过「模型名 / 接口地址」才需要按 0 退出、重新双击「一键启动.bat」。');
    } else say('  已取消，没有改动。');
    await pause();
    return;
  }
  if (c === '4') {
    say('');
    say('  本地 Ollama 不需要在这里填密钥。');
    say('  做法：① 到 https://ollama.com/ 下载安装；② 打开命令行运行 ollama run llama3.1；');
    say('        ③ 保持它开着，本程序会自动发现并使用它（断网也能用）。');
    say('  配置文件 config/agents.yaml 里的默认地址是 http://127.0.0.1:11434/v1，一般不用改。');
    await pause();
    return;
  }
  if (c === '5') {
    await showAgentStatus();
    await pause();
    return;
  }
  if (c === '6') {
    const yes = await ask('  确定清空全部 AI 密钥吗？输入 y 确认，其他任意键取消：');
    if (yes.toLowerCase() === 'y') {
      for (const k of ['ZHIPU_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_COMPAT_API_KEY', 'LANGGRAPH_TOKEN', 'OLLAMA_KEY']) writeEnvItem(k, '');
      say('  √ 已清空。界面点一下左上角状态标签重新检查，就会回到纯离线模式。');
    } else say('  已取消，没有改动。');
    await pause();
    return;
  }
}

async function actionManual() {
  if (!fs.existsSync(MANUAL)) {
    say('  × 没找到《使用说明书.html》，请确认它和「一键启动.bat」在同一个文件夹里。');
    await pause();
    return;
  }
  open(MANUAL);
  say('  √ 说明书已用默认浏览器打开。也可以随时直接双击项目里的「使用说明书.html」。');
  await pause();
}

async function actionFolder() {
  if (!fs.existsSync(KB)) fs.mkdirSync(KB, { recursive: true });
  open(KB);
  say('  √ 已打开资料文件夹。把你的报价表(.xlsx)、产品图、证书放进来即可。');
  say('    文件名不用改，程序会读表格内容：放好之后选菜单 10，或点界面上的「🗂 一键整理资料」。');
  say('    表里最好有「型号」和「价格 / 出厂价 / 单价」两列；中文表头、合并单元格、一格多个价格都认得。');
  await pause();
}

/** 菜单 10：命令行整理资料库（和界面上的按钮是同一套逻辑） */
async function actionOrganize() {
  say('  正在整理资料库（只读你的报价表，不会改名 / 移动 / 删除原文件）…');
  const code = await run(process.execPath, [TSX, 'scripts/organize-library.ts']);
  hr();
  if (code === 0) {
    const list = path.join(ROOT, 'data', '资料清单.md');
    say('  √ 整理完成。现在问报价、问款式，AI 会去你的表里查。');
    if (fs.existsSync(list)) say('    想看认出了哪些型号：' + list);
    say('    以后新增文件，选 10 或点界面「🗂 一键整理资料」；程序也会每 30 分钟自动整理。');
  } else {
    say('  × 整理没成功。请把上面带「×」的那行截图，发给帮你装程序的人。');
  }
  hr();
  await pause();
}

async function actionConnect() {
  say('');
  say('  正在重新自动接入 WorkBuddy（写配置、写信任记录、握手自检）…');
  const code = await run(process.execPath, [CONNECT_SCRIPT]);
  hr();
  if (code === 0) {
    say('  √ 接入完成。请完全退出 WorkBuddy 后重新打开一次，就能直接用中文下指令。');
    say('    浏览器版可以照常用，这一步不需要停掉后台服务。');
  } else {
    say('  × 接入没成功。请把上面带「×」的那行截图，发给帮你装程序的人。');
  }
  hr();
  await pause();
}

async function actionScripts() {
  await ensureGateway(true);
  if (!(await isUp())) { await pause(); return; }
  // 话术库文件在第一次被读取时自动生成，这个只读页面会触发一次
  try { await fetch(base() + '/docs/scripts'); } catch { /* 服务刚起，稍后自己会生成 */ }
  if (!fs.existsSync(SCRIPTS)) {
    say('  × 还没生成话术库文件。请先生成一次回复稿，或让 WorkBuddy 说「帮我优化话术」。');
    await pause();
    return;
  }
  open(SCRIPTS);
  say('  √ 话术库已用记事本打开。改完保存即可，不用重启，下一次生成回复稿自动生效。');
  say('    只改语气、结构和写法；价格、交期这类数字不要写死在里面（程序本来也不会复用旧数字）。');
  await pause();
}

async function main() {
  await bootstrap();
  let running = true;
  while (running) {
    showMenu();
    const c = await ask('  请输入数字后按回车：');
    say('');
    switch (c) {
      case '1': await actionBrowser(); break;
      case '2': await actionDesktop(); break;
      case '3': await actionService(); break;
      case '4': await actionCheck(); break;
      case '5': await actionKeys(); break;
      case '6': await actionManual(); break;
      case '7': await actionFolder(); break;
      case '8': await actionConnect(); break;
      case '9': await actionScripts(); break;
      case '10': await actionOrganize(); break;
      case '0': running = false; break;
      default: say('  没有这个选项，请输入 0 到 10 之间的数字。');
    }
  }
  if (ownedGateway) {
    const child = ownedGateway;
    ownedGateway = null;
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
  say('  已退出。下次使用：双击「一键启动.bat」，选 1 即可。');
  rl.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  if (ownedGateway) ownedGateway.kill();
  process.exit(0);
});

main().catch((e) => {
  say('  × 启动器遇到错误：' + (e && e.message ? e.message : String(e)));
  say('    请把这段文字截图发给帮你装程序的人。');
  process.exit(1);
});
