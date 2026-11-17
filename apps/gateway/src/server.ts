import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { cfg, isDevToken } from './config.js';
import { initDb } from './store/sqlite.js';
import { authHook, redact } from './security.js';
import './context.js';
import chatRoute from './routes/chat.js';
import agentsRoute from './routes/agents.js';
import toolsRoute from './routes/tools.js';
import casesRoute from './routes/cases.js';
import ingressRoute from './routes/ingress.js';
import pushRoute from './routes/push.js';
import auditRoute from './routes/audit.js';
import learningRoute from './routes/learning.js';
import libraryRoute from './routes/library.js';
import imagesRoute from './routes/images.js';
import translateRoute from './routes/translate.js';
import { autoOrganizeIfNeeded, getIndex } from './library/organizer.js';
import { getImageIndex } from './library/imageIndex.js';

async function main(): Promise<void> {
  initDb();
  const app = Fastify({
    // 客户产品图会以 base64 传进来；界面会先压到 1280px，但留足余量避免大图被 413 挡掉
    bodyLimit: 24 * 1024 * 1024,
    logger: {
      level: 'info',
      redact: ['req.headers.authorization', 'req.headers["x-signature"]'],
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number };
    app.log.error(redact(String(e.stack ?? e.message)));
    reply.code(Number(e.statusCode ?? 500)).send({
      error: { message: redact(e.message), type: 'internal_error' },
    });
  });

  await app.register(cors, { origin: true });
  await app.register(websocket);
  await app.register(fastifyStatic, { root: cfg.rendererDir, prefix: '/app/', decorateReply: false });

  app.addHook('onRequest', authHook);

  app.get('/', async (_req, reply) => reply.redirect('/app/'));

  // 新手说明书：界面右上角的「?」会打开这里；只读这一个固定文件，不暴露任何配置。
  app.get('/docs/manual', async (_req, reply) => {
    const file = path.join(cfg.root, '使用说明书.html');
    if (!fs.existsSync(file)) {
      return reply.type('text/html; charset=utf-8').send('<h1>没找到说明书</h1><p>请确认项目根目录里有「使用说明书.html」。</p>');
    }
    return reply.type('text/html; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
  });

  await app.register(chatRoute);
  await app.register(translateRoute);
  await app.register(agentsRoute);
  await app.register(toolsRoute);
  await app.register(casesRoute);
  await app.register(auditRoute);
  await app.register(learningRoute);
  await app.register(libraryRoute);
  await app.register(imagesRoute);
  await app.register(ingressRoute);
  await app.register(pushRoute);

  await app.listen({ port: cfg.port, host: cfg.host });

  // 资料库自动关联：启动后台整理一次（不阻塞服务），之后每 30 分钟检查文件有没有增删改。
  // 用户往资料文件夹里丢新报价表，不用记得点按钮，最多半小时后就自动能被 AI 查到。
  setImmediate(() => {
    try {
      const r = autoOrganizeIfNeeded();
      if (r.ran && r.摘要) console.log('  √ 资料库已自动整理：' + r.摘要);
    } catch (e) {
      console.log('  ! 资料库自动整理没成功（不影响其他功能）：' + String((e as Error).message ?? e));
    }
  });
  const organizeTimer = setInterval(() => {
    try {
      const r = autoOrganizeIfNeeded();
      if (r.ran && r.摘要) console.log('  √ 资料文件有变化，已自动重新整理：' + r.摘要);
    } catch (_) { /* 定时整理失败不影响服务 */ }
  }, 30 * 60 * 1000);
  organizeTimer.unref();

  const base = `http://${cfg.host}:${cfg.port}`;
  console.log('');
  console.log('  √ 后台服务已启动，可以开始使用了');
  console.log(`    操作界面：${base}/app/`);
  console.log(`    使用说明书：${base}/docs/manual`);
  console.log(`    资料文件夹：${cfg.kbRoot}`);
  const kb = getIndex();
  console.log(kb
    ? `    资料库状态：已关联 ${kb.统计.型号数} 个型号 / ${kb.统计.报价行数} 行报价（界面可点「一键整理资料」重新整理）`
    : '    资料库状态：还没整理，启动后会自动整理一次；界面也可点「一键整理资料」');
  const img = getImageIndex();
  console.log(img
    ? `    图片索引：已关联 ${img.统计.图片数} 张产品图（${img.统计.有关联型号} 张有型号），界面「加图片」可直接按图查价`
    : '    图片索引：还没建；在界面「加图片」按钮上悬停，点「重建图片索引」即可按图查价');
  console.log(`    运行记录：${path.basename(cfg.dbPath)}`);
  console.log('    话术库：data/话术库.json（可用记事本改，改完自动生效）');
  console.log('    （下面这些给懂技术的人看：）');
  console.log(`    ${base}/v1/chat/completions  统一对话接口（OpenAI 兼容 + x_meta）`);
  console.log(`    ${base}/v1/agents           AI 名单与健康状态`);
  console.log(`    ${base}/v1/health           健康检查`);
  console.log(`    ${base}/ws/stream           流式推送`);
  if (isDevToken()) console.log('  ! 当前使用默认连接口令，仅限本机使用；对外提供服务前请修改 .env 里的 CLIENT_TOKEN');
  console.log('');
  console.log('  这个窗口要一直开着；关掉它 = 程序停止。');
  console.log('');
}

main().catch((e) => {
  const msg = String((e as Error)?.message ?? e);
  console.error('');
  console.error('  × 后台服务启动失败：' + msg);
  if (/EADDRINUSE|address already in use/i.test(msg)) {
    console.error('    原因：端口被别的程序占用了。');
    console.error('    办法：打开 .env，把 PORT=8787 改成 PORT=8788，保存后重新启动。');
  } else {
    console.error('    办法：把上面这段红字截图，发给帮你装程序的人。也可先运行菜单 4 做体检。');
  }
  process.exit(1);
});
