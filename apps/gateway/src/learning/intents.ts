/**
 * 客户意图识别：把一段客户消息归到一个「场景」里。
 *
 * 为什么需要它：话术优化不是笼统地学「好句子」，而是分场景学——
 * 问价该怎么写、要图片该怎么写、投诉该怎么写，各学各的，下次才用得上。
 * 这里只用关键词，不需要 AI，也不联网，纯本机、零成本。
 */

export interface IntentDef {
  key: string;
  label: string;
  hint: string;
  test: RegExp;
}

/** 顺序很重要：越具体的放前面，先命中先用 */
export const INTENTS: IntentDef[] = [
  {
    key: 'complaint',
    label: '投诉 / 索赔 / 质量问题',
    hint: '先共情、再给可核查的处理步骤；客户说「你之前承诺过」先核对口径、说清哪里变了，不直接否认、不辩论、不把责任推给客户、不质问客户举证、不反复哭穷，不承诺赔偿金额。',
    test: /投诉|索赔|赔偿|退款|质量|破损|不合格|延迟交货|complaint|claim|refund|defect|broken|damage|delay/i,
  },
  {
    key: 'payment',
    label: '付款方式 / 账期',
    hint: '账期、付款条件必须人工确认，只描述流程；收款账号 / 二维码绝不写进回复稿，由客服线下发送。',
    test: /付款|账期|信用证|定金|尾款|payment\s*terms?|L\/C|credit\s*terms|deposit|TT|汇款/i,
  },
  {
    key: 'price',
    label: '问价格 / 报价 / 折扣',
    hint: '价格、数量只取当前表真实行号；「库存的价格」是出厂价 / 内部价，「订单的价格」只作对比锚点且说一次就够。报价第一次就讲清含不含包装 / 卡纸 / logo 等附加项加不加钱、对应哪一批 / 哪个型号清单和数量档；同一会话同一款只给一个价，客户没砍别自己连续降价。客户向我们要清单就给真实清单，给不出说会确认并给时间点。客户给了目标价 / 数量 / 别家报价先接住条件，不质问、不施压。查不到在中文说明写「待人工补充」，客户正文用自然短句说会确认，不写模板腔。',
    test: /报价|价格|多少钱|单价|折扣|优惠|成本|MOQ|起订|price|quote|quotation|cost|discount|how\s*much|FOB|CIF/i,
  },
  {
    key: 'leadtime',
    label: '问交期 / 发货时间',
    hint: '交期必须来自报价表真实数据并标注来源行号；查不到在中文说明写「待人工补充」，客户正文用自然短句说会确认，不要写内部占位符或模糊承诺。',
    test: /交期|货期|发货|多久|什么时候能到|lead\s*time|delivery\s*time|shipment|when.*ship|dispatch/i,
  },
  {
    key: 'sample',
    label: '索要样品',
    hint: '说明样品流程与可提供的资料，样品费 / 运费不要擅自承诺；客户点名型号要样品并给了地址 / 唛头、要逐款标价时，逐款标价、确认寄样、给明确下一步；客户问具体质量担心就答那一点并给实拍 / 视频。',
    test: /样品|寄样|取样|sample|samples|free\s*sample/i,
  },
  {
    key: 'media',
    label: '要图片 / 证书 / 资料',
    hint: '客户要图 + 价就一起给：图少而准、每张配一句价和能核查的规格，发前自检别重复；只发当前库存表确有的货，已卖掉的不报。客户问质量先照原话复述他要的规格再给实拍 / 安装视频（客服从当前库存表人工挑），别只回 very good quality；绝不沿用案例聊天里的图片 / 视频 / 表格文件，没找到就说会另外发。',
    test: /图片|照片|图册|证书|资质|规格书|目录|资料|附件|catalog|photo|image|picture|certificate|cert|datasheet|brochure/i,
  },
  {
    key: 'case',
    label: '要看成功案例',
    hint: '只能引用已入库案例，未入库不要虚构客户名或项目；四份记录里只有一份成交，其余是没成交复盘，不要包装成成功案例，案例里的数字与图片不可复用。',
    test: /案例|参考客户|做过.*项目|类似项目|case\s*study|reference|similar\s*project|portfolio/i,
  },
  {
    key: 'followup',
    label: '跟进 / 催单 / 回访',
    hint: '每次跟进要么带新信息，要么给明确待办和时间点；客户说忙 / 给私人原因先一句接住，别立刻又催；不要只发问候 / 表情 / Do you need?，不要同一天连发多条、不重复整段报价；断联很久重新开口要带「哪款、什么包装、现在还有多少」，别只甩一个降价数字；客户质疑前后不一致时先说清口径，不施压、不反复哭穷。',
    test: /跟进|催|进度|考虑得怎样|有消息吗|回访|follow\s*up|any\s*update|checking\s*in|reminder|status/i,
  },
];

export const DEFAULT_INTENT = 'greeting';

export interface IntentInfo {
  key: string;
  label: string;
  hint: string;
}

export function classifyIntent(text: string): string {
  const s = String(text ?? '');
  for (const i of INTENTS) if (i.test.test(s)) return i.key;
  return DEFAULT_INTENT;
}

export function intentInfo(key: string): IntentInfo {
  if (key === DEFAULT_INTENT) {
    return { key, label: '寒暄 / 一般询问', hint: '先答客户问的那件事再问自己需要的；一句一件事、短句分行，给明确下一步；不用 Dear / 感谢来信 / 落款，不堆客套、不写机翻译文式长句、不刷表情、不写三段式模板。' };
  }
  const i = INTENTS.find((x) => x.key === key);
  return i ? { key: i.key, label: i.label, hint: i.hint } : intentInfo(DEFAULT_INTENT);
}

export const ALL_INTENT_KEYS: string[] = [...INTENTS.map((i) => i.key), DEFAULT_INTENT];
