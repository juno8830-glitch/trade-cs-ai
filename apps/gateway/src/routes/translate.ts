import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AgentAdapter } from '@trade-cs-ai/core';
import { router } from '../context.js';

/**
 * 翻译接口，只服务窗口右侧「中文对照」栏，绝不进回复稿、绝不自动发给客户：
 * - 默认 target=zh：客户外文原话 → 简体中文，帮客服读懂客户在问什么；
 * - target=en：客服手动输入的中文 → 英文，客服点「一键复制」后自己粘贴发送。
 * 复用已经配好的真 AI；没连上就如实说明，绝不编造译文或型号价格。
 */
const OFFLINE_IDS = new Set(['builtin-offline', 'offline-draft', 'offline-template']);
const MAX_LEN = 4000;

type Target = 'zh' | 'en';

const SYSTEM_PROMPT: Record<Target, string> = {
  zh: '你是外贸客服的翻译助手。把客户发来的消息准确翻译成简体中文：保留数字、型号、币种、单位和原有换行；原文里没有的内容一律不补；只输出中文译文，不要解释、不要加标记、不要重复原文。',
  en: '你是外贸客服的翻译助手。把客服写的中文准确翻译成自然、简洁的英文，供发给海外客户：保留数字、型号、币种、单位和原有换行，币种只写一次、不要既写符号又写缩写；原文里没有的内容一律不补；语气像真实客服手打的短句，不要解释、不要加标记、不要重复中文原文；只输出英文译文。',
};

function pickTarget(v: unknown): Target {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'en' || s === '英文' || s === 'english' ? 'en' : 'zh';
}

/** 模型偶尔把标记 / 代码围栏一起吐出来，去掉最常见的几种，避免右栏出现噪声 */
function cleanTranslation(raw: string): string {
  let s = String(raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  s = s
    .replace(/^\s*(【中文翻译】|【英文翻译】|中文译文|英文译文|译文|翻译|English translation|Translation)\s*[:：]?\s*/i, '')
    .trim();
  s = s.replace(/^```[a-zA-Z]*\s*|\s*```$/g, '').trim();
  return s;
}

async function healthyAgent(): Promise<AgentAdapter | undefined> {
  // 挑一个健康的真 AI：按配置里的优先级，跳过本机模板助手
  try {
    const snap = await router.snapshot();
    const usable = snap
      .filter((a) => a.healthy === true && !OFFLINE_IDS.has(String(a.id)))
      .sort((a, b) => {
        const pa = Number((a.route as { priority?: number } | undefined)?.priority ?? 99);
        const pb = Number((b.route as { priority?: number } | undefined)?.priority ?? 99);
        return pa - pb;
      });
    return usable.length ? router.get(String(usable[0].id)) : undefined;
  } catch {
    // 探活失败就走下面的提示，不影响其它功能
    return undefined;
  }
}

export default async function translateRoute(app: FastifyInstance): Promise<void> {
  app.post('/v1/translate', async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as { text?: unknown; target?: unknown };
    const text = String(body.text ?? '').trim().slice(0, MAX_LEN);
    const target = pickTarget(body.target);
    if (!text) return { ok: false, hint: '没有需要翻译的文字', target };

    const han = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
    const latin = (text.match(/[A-Za-z]/g) ?? []).length;

    // 本来就是目标语言：原样回显，不浪费一次 AI 调用
    if (target === 'zh' && han > 0 && latin === 0) {
      return { ok: true, translation: text, agent: '原文即中文', hint: '', target };
    }
    if (target === 'en' && han === 0) {
      return { ok: true, translation: text, agent: '原文即英文', hint: '', target };
    }

    const agent = await healthyAgent();
    if (!agent) {
      return {
        ok: false,
        hint: '当前只有本机模板助手，没有可用的 AI，暂时不能自动翻译。在黑窗口菜单填好智谱 / 阿里云密钥后就会自动生效。',
        target,
      };
    }

    try {
      const res = await agent.invoke({
        model: agent.cfg.model ?? agent.id,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT[target] },
          { role: 'user', content: text },
        ],
        stream: false,
        temperature: 0.2,
      }, { requestId: crypto.randomUUID() });

      const out = cleanTranslation(String(res.content ?? ''));
      const valid = target === 'zh'
        ? !!out && /[\u4e00-\u9fa5]/.test(out)
        : !!out && /[A-Za-z]/.test(out) && !/[\u4e00-\u9fa5]/.test(out);
      if (!valid) {
        return {
          ok: false,
          hint: target === 'zh'
            ? '这次没拿到中文译文，请点「翻译这句」重试。'
            : '这次没拿到干净的英文译文，请点「翻译成英文」重试。',
          target,
        };
      }
      return { ok: true, translation: out, agent: agent.id, hint: '', target };
    } catch (e) {
      return { ok: false, hint: '翻译没成功：' + String((e as Error).message ?? e), target };
    }
  });
}
