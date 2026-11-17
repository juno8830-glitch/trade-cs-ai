import crypto from 'node:crypto';
import type {
  AgentAdapter,
  AgentConfig,
  Capabilities,
  HealthResult,
  InvokeCtx,
  StreamFrame,
  ToolCall,
  UnifiedRequest,
  UnifiedResponse,
} from '@trade-cs-ai/core';
import { DRAFT_MARK, TRANSLATION_MARK, NOTES_MARK, SOURCES_MARK, estimateUsage } from '@trade-cs-ai/core';
import { classifyIntent, intentInfo } from '../../learning/intents.js';
import { loadScriptBook } from '../../learning/scripts.js';
import { getIndex } from '../../library/organizer.js';

interface ToolResultEnvelope {
  ok: boolean;
  data: Record<string, any>;
}

/** 三元组 = [西班牙语, 英语, 中文]。中文那一项专门给不懂外文的客服看，绝不会复制给客户。 */
type Tri = [string, string, string];

/** 按客户意图给不同的开场与下一步：杜绝「不管问什么都回同一句客套话」 */
const OPENING: Record<string, Tri> = {
  complaint: ['Lamentamos sinceramente el inconveniente y vamos a revisarlo con el equipo de calidad.', 'We are sorry about the issue and are reviewing it with our quality team right away.', '我们对给您带来的不便深表歉意，已立即和质量团队一起核查。'],
  payment: ['Sobre las condiciones de pago, le confirmamos nuestro procedimiento estándar a continuación.', 'Regarding payment terms, let us confirm our standard procedure below.', '关于付款条件，下面向您确认我们的标准流程。'],
  leadtime: ['Sobre el plazo de entrega, le damos los datos verificables de nuestra lista vigente.', 'Regarding the delivery time, here is the verifiable information from our current list.', '关于交期，以下是现行价格表里可以核实的信息。'],
  sample: ['Nos alegra que quiera evaluar muestras; le explicamos cómo procedemos.', 'Happy to arrange samples — here is how we usually proceed.', '很高兴您愿意评估样品，下面说明我们的常规做法。'],
  media: ['Le mando lo que tengo de este modelo.', 'Here is what I have for this one.', '这款我手头有的资料发你。'],
  case: ['Contamos con experiencia en proyectos similares y podemos compartir la referencia.', 'We have handled similar projects and can share a reference.', '我们做过类似项目，可以分享参考案例。'],
  price: ['Claro, déjame revisar este.', 'Sure, let me check this one.', '好的，我看看这款。'],
  followup: ['Solo quería saber si sigue en pie.', 'Just checking in on this one.', '就是问下这个还作数吗。'],
  greeting: ['Dígame qué necesita.', 'Hi, tell me what you need.', '您好，需要什么直接说。'],
};
const NEXT_STEP: Record<string, Tri> = {
  complaint: ['Si nos envía fotos y el número de lote, abrimos la revisión de inmediato.', 'If you can share photos and the batch number, we will open the review immediately.', '如您能提供照片和批号，我们会立即启动核查。'],
  payment: ['Las condiciones exactas serán confirmadas por nuestro equipo comercial antes de emitir la proforma.', 'The exact terms will be confirmed by our sales team before the proforma is issued.', '确切条件将由业务团队在出具形式发票前确认。'],
  leadtime: ['Le confirmaremos la fecha concreta al recibir la orden y la confirmación de producción.', 'We will confirm the exact date once the order and production slot are confirmed.', '收到订单并确认生产排期后，我们会确认具体日期。'],
  sample: ['Díganos la dirección de envío y las especificaciones que desea evaluar.', 'Please share the delivery address and the specifications you would like to evaluate.', '请告知收货地址和您想评估的规格。'],
  media: ['Si necesita un formato o certificado adicional, díganos cuál y lo buscamos.', 'If you need any additional format or certificate, just let us know.', '如需其他格式或证书，请告诉我们具体是哪一种，我们去查找。'],
  case: ['Podemos preparar una referencia adaptada a su mercado si lo desea.', 'We can prepare a reference tailored to your market if you would like.', '如您需要，我们可以准备一份贴合您所在市场的参考案例。'],
  price: ['¿Quiere que revise otra cantidad?', 'Want me to check another qty?', '要我按别的数量再查吗？'],
  followup: ['Si quiere, reviso otra cantidad.', 'Let me know if you want me to check another qty.', '要的话我按别的数量再查一下。'],
  greeting: ['Mándeme el modelo o una foto y lo reviso.', 'Send me the model or a photo and I will check.', '把型号或图片发我，我查一下。'],
};

/** 每个业务场景的中间段也各不相同，避免「开场不同、正文还是同一句」 */
const MIDDLE: Record<string, Tri> = {
  complaint: ['Estamos documentando lo ocurrido y lo trataremos como un caso prioritario.', 'We are documenting what happened and treating it as a priority case.', '我们正在记录事情经过，并把它作为优先案件处理。'],
  payment: ['Nuestro proceso habitual es proforma, anticipo y saldo antes del embarque.', 'Our usual process is proforma, deposit and balance before shipment.', '我们的常规流程是形式发票、定金、出运前付清尾款。'],
  leadtime: ['El plazo depende del cupo de producción de la semana en que se confirme el pedido.', 'The lead time depends on the production slot in the week the order is confirmed.', '交期取决于订单确认当周的生产排期。'],
  sample: ['Podemos preparar muestras de las especificaciones estándar de nuestro catálogo.', 'We can prepare samples from the standard specifications in our catalogue.', '我们可以按目录中的标准规格准备样品。'],
  media: ['Hemos revisado la documentación disponible en nuestra biblioteca de productos.', 'We have checked the documentation currently available in our product library.', '我们已核查产品资料库中目前可提供的文档。'],
  case: ['Podemos describir el alcance del proyecto y los resultados, sin datos confidenciales.', 'We can describe the project scope and results without sharing confidential data.', '我们可以在不透露保密数据的前提下说明项目范围和结果。'],
  price: ['Para una cotización firme necesitamos el modelo, la cantidad y el incoterm.', 'For a firm quotation we need the model, the quantity and the incoterm.', '要出正式报价，需要型号、数量和贸易术语。'],
  followup: ['¿Le sirve el precio que le pasé?', 'Is the price I sent still ok for you?', '上次给的价还合适吗？'],
  greeting: ['Puedo revisar precio y stock.', 'I can check price and stock for you.', '价和库存我都能查。'],
};

/**
 * 「寒暄 / 一般询问」再细分：客户问「在吗」「会不会说英语」「谢谢」，
 * 都要各回各的。以前这些全落到同一句客套话，看起来就像「发什么都回一样」。
 */
interface SmallTalk {
  key: string;
  label: string;
  test: RegExp;
  open: Tri;
  body: Tri;
  next: Tri;
}
const SMALLTALK: SmallTalk[] = [
  {
    key: 'language',
    label: '问会不会说某种语言',
    test: /speak|language|english|spanish|chinese|españ|inglés|idioma|语言|会说|中文|英语|西语|翻译|translate|hablas?|do you understand/i,
    open: ['Con gusto: podemos comunicarnos en el idioma que prefiera.', 'Yes — we can communicate in the language you prefer.', '当然可以，我们可以用您偏好的语言沟通。'],
    body: ['Podemos responder en inglés, español o chino; si lo desea, también preparamos la ficha técnica en su idioma.', 'We can reply in English, Spanish or Chinese, and we can prepare the product sheet in your language as well.', '我们可以用英语、西班牙语或中文回复，也可以按您的语言准备产品资料。'],
    next: ['Díganos qué idioma le resulta más cómodo y lo usamos en adelante.', 'Let us know which language is most comfortable for you and we will use it from now on.', '请告诉我们哪种语言最方便，之后就一直用它。'],
  },
  {
    key: 'availability',
    label: '问在不在 / 有没有空',
    test: /有空|在吗|方便|有.*时间|available|are you there|are you free|free\s*(now|today|tomorrow)|busy|meeting|call|电话|约个|schedule|hablar/i,
    open: ['Sí, estamos disponibles y con gusto le atendemos ahora.', 'Yes, we are available and happy to talk now.', '在的，我们现在方便，很乐意和您沟通。'],
    body: ['Nuestro equipo está en línea durante el horario comercial; si prefiere una llamada, coordinamos la hora.', 'Our team is online during business hours; if you prefer a call, we can arrange a time.', '工作时间内团队都在线；如果您想通电话，我们可以约个时间。'],
    next: ['Indíquenos el tema y la franja horaria que le conviene y lo confirmamos.', 'Please tell us the topic and a time window that suits you, and we will confirm it.', '请告诉我们主题和方便的时间段，我们来确认。'],
  },
  {
    key: 'thanks',
    label: '客户道谢',
    test: /thank|thanks|gracias|谢谢|感谢|appreciate|much obliged/i,
    open: ['Gracias a usted por la confianza; ha sido un gusto ayudarle.', 'Thank you — it has been a pleasure to help.', '也谢谢您的信任，很高兴能帮到您。'],
    body: ['Seguimos a su disposición para cualquier detalle adicional del pedido o la documentación.', 'We remain at your disposal for any further detail about the order or the documentation.', '订单或资料还有任何细节，我们随时为您补充。'],
    next: ['Si surge algo más, escríbanos sin problema.', 'If anything else comes up, just write to us.', '如果还有别的事，随时写信给我们。'],
  },
  {
    key: 'hello',
    label: '单纯打招呼',
    test: /^\s*(hi|hello|hey|hola|buenos|good\s*(morning|afternoon|evening)|你好|您好|早上好|下午好)/i,
    open: ['Hola, gracias por saludarnos.', 'Hello, and thanks for getting in touch.', '您好，谢谢您联系我们。'],
    body: ['Estamos listos para ayudarle con catálogos, precios, muestras o cualquier consulta comercial.', 'We are ready to help with catalogues, prices, samples or any commercial question.', '目录、价格、样品或任何商务问题，我们都可以协助。'],
    next: ['Cuéntenos en qué podemos ayudarle hoy.', 'Please let us know what we can help you with today.', '请告诉我们今天有什么可以帮您。'],
  },
];
/** 兜底：按客户原话换 3 种措辞，哪怕同一类闲聊也不会永远是同一句 */
const GENERIC: SmallTalk[] = [
  {
    key: 'generic_a', label: '一般询问（写法 A）', test: /.*/,
    open: ['Gracias por su mensaje; lo hemos recibido correctamente.', 'Thanks for your note — we have received it.', '感谢来信，我们已经收到。'],
    body: ['Estamos revisando lo que nos comenta y le responderemos con una propuesta concreta.', 'We are looking into what you mentioned and will come back with a concrete answer.', '我们正在看您提到的内容，会带着具体方案回复您。'],
    next: ['Si puede darnos el modelo o la referencia, podremos ser mucho más precisos.', 'If you can share the model or reference, we can be much more specific.', '如果能提供型号或参考编号，我们能回复得更准确。'],
  },
  {
    key: 'generic_b', label: '一般询问（写法 B）', test: /.*/,
    open: ['Agradecemos que nos escriba.', 'We appreciate you writing to us.', '感谢您写信给我们。'],
    body: ['Su consulta está en revisión con el equipo comercial, no queremos darle un dato incompleto.', 'Your question is with our sales team for review — we would rather not give you an incomplete answer.', '您的问题已交业务团队复核，我们不愿给您一个不完整的数据。'],
    next: ['¿Hay algún plazo o requisito especial que debamos tener en cuenta?', 'Is there any deadline or special requirement we should keep in mind?', '是否有交期或特殊要求需要我们考虑？'],
  },
  {
    key: 'generic_c', label: '一般询问（写法 C）', test: /.*/,
    open: ['Recibido, gracias por la información.', 'Noted, and thanks for the information.', '收到，谢谢您提供的信息。'],
    body: ['Vamos a preparar una respuesta con datos verificables antes de contestarle.', 'We are preparing a reply based on verifiable data before getting back to you.', '我们会先准备好有据可查的回复，再答复您。'],
    next: ['Quedamos atentos a cualquier detalle adicional que quiera añadir.', 'We are happy to take any extra detail you would like to add.', '欢迎补充任何您想加的细节。'],
  },
];

function pickSmallTalk(text: string): SmallTalk {
  const hit = SMALLTALK.find((s) => s.test.test(text));
  if (hit) return hit;
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GENERIC[h % GENERIC.length];
}

/**
 * 内置离线兜底 Agent：无密钥、无网络也能跑通「工具意图 → 网关执行 → 结果回填 → 成稿」全链路。
 * 它不是模型，仅用于验证协议、故障转移与人工确认约束；生产环境由其它适配器接管。
 */
export class BuiltinOfflineAdapter implements AgentAdapter {
  readonly id: string;
  constructor(readonly cfg: AgentConfig) {
    this.id = cfg.id;
  }
  get capabilities(): Capabilities {
    return this.cfg.capabilities;
  }

  async health(): Promise<HealthResult> {
    return { ok: true, latencyMs: 0, detail: 'built-in offline fallback (always healthy)' };
  }

  private toolResults(req: UnifiedRequest): Map<string, ToolResultEnvelope> {
    const map = new Map<string, ToolResultEnvelope>();
    for (const m of req.messages) {
      if (m.role !== 'tool' || !m.name) continue;
      try {
        map.set(m.name, JSON.parse(m.content) as ToolResultEnvelope);
      } catch {
        map.set(m.name, { ok: false, data: {} });
      }
    }
    return map;
  }

  private userText(req: UnifiedRequest): string {
    return req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  }

  /**
   * 只认两种型号，绝不猜：
   *   ① 老式编码型号（字母 + 3~5 位数字）这种带数字编号的写法；
   *   ② 当前资料库索引里真实存在的型号 / 产品名，例如库存表里的 REDMI、A02s、IP 11-17。
   * 用户的库存表换了之后，写死编码型号的旧正则会一个都认不出，客户问价就不会去查表，
   * 所以这里用索引做白名单；索引里没有的词一律返回空，不会把别款的价格套上来。
   */
  private detectSku(text: string): string {
    const coded = text.match(/[A-Z]{2,5}-?\d{3,5}[A-Z0-9-]*/i);
    if (coded) return coded[0].toUpperCase();
    const index = getIndex();
    if (!index) return '';
    const hay = text.toLowerCase();
    const known = index.型号目录
      .map((m) => String(m.型号 ?? '').trim())
      .filter((s) => s.length >= 3 && /[A-Za-z0-9]/.test(s))
      .sort((a, b) => b.length - a.length);
    return known.find((s) => hay.includes(s.toLowerCase())) ?? '';
  }

  private decide(req: UnifiedRequest): UnifiedResponse {
    const text = this.userText(req);
    const results = this.toolResults(req);
    const sku = this.detectSku(text);
    const calls: ToolCall[] = [];
    const allowed = new Set((req.tools ?? []).map((t) => t.function.name));

    if (allowed.has('quote_lookup') && !results.has('quote_lookup') && sku && /报价|价格|price|quote|moq|交期|lead\s*time|discount|折扣|成本/i.test(text)) {
      calls.push({ id: `call_${crypto.randomUUID().slice(0, 8)}`, name: 'quote_lookup', args: { sku } });
    }
    if (allowed.has('file_search') && !results.has('file_search') && /图|图片|photo|image|证书|cert|资料|catalog|规格书|附件/i.test(text)) {
      calls.push({ id: `call_${crypto.randomUUID().slice(0, 8)}`, name: 'file_search', args: { sku, kind: 'image' } });
    }
    if (allowed.has('case_search') && !results.has('case_search') && /案例|case|参考客户|成功案例|similar/i.test(text)) {
      calls.push({
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        name: 'case_search',
        args: { country: req.context?.customer?.country ?? '', keyword: sku },
      });
    }

    if (calls.length) {
      return { content: '', toolCalls: calls, finishReason: 'tool_calls', model: this.id };
    }

    const locale = req.context?.locale ?? 'en';
    const isEs = /^es/i.test(locale);
    const name = req.context?.customer?.name ?? (isEs ? 'Carlos' : 'there');
    const country = req.context?.customer?.country ?? 'your market';
    const quote = results.get('quote_lookup');
    const files = results.get('file_search');
    const cases = results.get('case_search');

    const intent = classifyIntent(text);
    const talk = intent === 'greeting' ? pickSmallTalk(text) : null;
    const opening = talk ? talk.open : OPENING[intent] ?? OPENING.greeting;
    const middle = talk ? talk.body : MIDDLE[intent] ?? MIDDLE.greeting;
    const nextStep = talk ? talk.next : NEXT_STEP[intent] ?? NEXT_STEP.greeting;

    // lines = 发给客户的外文正文；cnLines = 与之逐句对应的中文翻译。
    // 两份数组用同一个 push 写入，保证「第几行对第几行」永远不错位。
    const lines: string[] = [];
    const cnLines: string[] = [];
    const push = (tri: Tri) => { lines.push(isEs ? tri[0] : tri[1]); cnLines.push(tri[2]); };
    const blank = () => { lines.push(''); cnLines.push(''); };

    push([isEs ? `Hola ${name},` : `Hi ${name},`, isEs ? `Hola ${name},` : `Hi ${name},`, `${name}，您好：`]);
    blank();
    push(opening);
    blank();
    if (quote?.ok && quote.data?.price_usd != null) {
      const q = quote.data;
      push([
        isEs
          ? `${sku}: USD ${q.price_usd}/pc, MOQ ${q.moq}. Entrega ${q.lead_time}.`
          : `${sku}: USD ${q.price_usd}/pc, MOQ ${q.moq}. Lead time ${q.lead_time}.`,
        `${sku}: USD ${q.price_usd}/pc, MOQ ${q.moq}. Lead time ${q.lead_time}.`,
        `${sku}：USD ${q.price_usd}/件，起订 ${q.moq} 件，交期 ${q.lead_time}。`,
      ]);
      // 生效日期、来源行号只写进中文说明，别塞进发给客户的聊天消息里
    } else if (quote) {
      const item = sku || (isEs ? 'el producto' : 'the item');
      push([
        isEs ? `Déjeme revisar el precio de ${item} y le vuelvo a escribir.` : `Let me check the price for ${item} and come back to you.`,
        `Let me check the price for ${item} and come back to you.`,
        `我先核一下 ${item} 的价，回头回你。`,
      ]);
    } else if (!sku && /报价|价格|多少钱|单价|price|quote|quotation|how\s*much|discount|折扣/i.test(text)) {
      push([
        isEs ? '¿Qué modelo necesita? Reviso el precio.' : 'Which model do you need? I will check the price.',
        'Which model do you need? I will check the price.',
        '要哪个型号？我查下价。',
      ]);
    } else {
      push(middle);
    }
    if (files?.ok && Array.isArray(files.data?.files) && files.data.files.length) {
      push([
        isEs ? 'Le mando las fotos y certificados aparte.' : 'I will send the photos and certificates separately.',
        'I will send the photos and certificates separately.',
        '图片和证书我另外发你。',
      ]);
    }
    if (cases?.ok && Array.isArray(cases.data?.cases) && cases.data.cases.length) {
      push([
        isEs ? `Hemos atendido proyectos similares en ${country} y podemos compartir la referencia.` : `We have handled similar projects in ${country} and can share the reference case.`,
        `We have handled similar projects in ${country} and can share the reference case.`,
        `我们在 ${country} 做过类似项目，可以分享参考案例。`,
      ]);
    }
    blank();
    push(nextStep);
    // 真人客服不会在聊天里写 Best regards / 团队落款，正文到「下一步」就收住

    const sources: string[] = [];
    if (quote?.ok && quote.data?.file) sources.push(`报价来源：${quote.data.file} 第 ${quote.data.row} 行（生效 ${quote.data.effective_date}）`);
    if (files?.ok) for (const f of files.data?.files ?? []) sources.push(`附件：${f.path}`);
    if (cases?.ok) for (const c of cases.data?.cases ?? []) sources.push(`案例：${c.id} (${c.country}/${c.product})`);

    // 把你标记出来的经验回显给客服，让「话术有没有变聪明」肉眼可见
    const scene = loadScriptBook()['场景']?.[intent];
    const learned: string[] = scene
      ? [`【本次场景】${intentInfo(intent).label}；要点：${scene['默认要点']}`]
      : [];
    if (scene?.['成功话术'].length) learned.push(`已验证有效的写法：${scene['成功话术'][0].slice(0, 120)}`);
    if (scene?.['经验教训'].length) learned.push(`经验：${scene['经验教训'][0]}`);
    if (scene?.['避免'].length) learned.push(`注意避免：${scene['避免'][0].slice(0, 90)}`);

    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 60);
    const notes = [
      NOTES_MARK,
      '这是本机兜底助手写的短句稿，没连外部 AI；价格 / 型号仍以当前表为准，发送前请核对来源行号。想要更自然的语气，可在「谁来回信」里选已连接的 AI。',
      `本次识别：${talk ? talk.label : intentInfo(intent).label}；客户原话：${snippet || '（空）'}`,
      quote?.ok
        ? '已读取报价表真实数据，未虚构价格；价格 / MOQ / 交期属于敏感字段，请核对来源行号后再发送。'
        : `未命中报价表，回复稿刻意不含具体价格，避免编造。${sku ? '' : '本次没识别到产品型号，已请客户确认型号，没有拿默认型号去查价。'}`,
      `客户阶段：${req.context?.customer?.stage ?? 'unknown'}；语种：${locale}；渠道：${req.context?.channel ?? 'unknown'}。`,
      ...learned,
      ...(sources.length ? [SOURCES_MARK, ...sources] : []),
    ].join('\n');

    const content = [
      DRAFT_MARK,
      lines.join('\n'),
      '',
      TRANSLATION_MARK,
      cnLines.join('\n'),
      '',
      notes,
    ].join('\n');
    return { content, finishReason: 'stop', usage: estimateUsage(req.messages, content), model: this.id };
  }

  async invoke(req: UnifiedRequest, _ctx: InvokeCtx): Promise<UnifiedResponse> {
    return this.decide(req);
  }

  async *stream(req: UnifiedRequest, _ctx: InvokeCtx): AsyncIterable<StreamFrame> {
    const res = this.decide(req);
    if (res.toolCalls?.length) {
      for (const call of res.toolCalls) {
        yield { type: 'tool_call', name: call.name, args: call.args };
      }
      yield { type: 'done' };
      return;
    }
    const size = 18;
    for (let i = 0; i < res.content.length; i += size) {
      yield { type: 'delta', content: res.content.slice(i, i + size) };
      await new Promise((r) => setTimeout(r, 6));
    }
    yield { type: 'done', usage: res.usage };
  }
}
