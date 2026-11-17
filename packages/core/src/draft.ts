/**
 * 回复稿分块协议（中文给客服看，外文给客户看）
 *
 * 一份回复稿同时包含两部分内容：
 *   ①【回复稿】   —— 可以直接发给客户的外文正文，复制时只要这一段；
 *   ②【中文翻译】 —— 逐句中文翻译，只给你看，绝不复制给客户；
 *   ③【中文说明】/【资料来源】 —— 归因、复核提示、数据来源，同样只给你看。
 *
 * 网关、桌面窗口、体检脚本都按这一份规则切分，
 * 避免「复制时把中文注解一起粘给客户」这种低级但很尴尬的事故。
 *
 * 注意：前端 renderer/app.js 里有一份等价的 JS 实现（浏览器静态页不能 import TS），
 * 改这里的规则时，请同步改那一份。
 */

export const DRAFT_MARK = '【回复稿】';
export const TRANSLATION_MARK = '【中文翻译】';
export const NOTES_MARK = '【中文说明】';
export const SOURCES_MARK = '【资料来源】';

/** 所有「只给客服看、不能复制给客户」的段落标记 */
export const PRIVATE_MARKS = [TRANSLATION_MARK, NOTES_MARK, SOURCES_MARK] as const;
const ALL_MARKS = [DRAFT_MARK, ...PRIVATE_MARKS] as const;

export interface DraftSections {
  /** 可直接发给客户的外文正文（不含任何中文翻译和注解） */
  clean: string;
  /** 中文翻译 */
  translation: string;
  /** 中文说明 + 资料来源 */
  notes: string;
  /** 原文是否用了分块标记；false 表示外部 AI 输出了老格式，整段按正文处理 */
  structured: boolean;
}

/**
 * 把一份完整回复稿切成三块。
 * 容错规则：
 *   · 没有【回复稿】但有【中文说明】（老格式）→ 标记之前的内容仍算正文；
 *   · 一个标记都没有（外部 AI 不守格式）→ 整段都算正文，绝不吞掉内容；
 *   · 翻译 / 注解同时有多段 → 合并显示，标记本身保留在注解里方便阅读。
 */
export function splitDraft(content: string): DraftSections {
  // 智谱这类「带思考」的模型偶尔会把内部草稿也吐进正文，甚至把三段结构整份写两遍。
  // 先去掉思考标签，再只保留第一份结构，避免客户收到重复内容或 </think> 这种怪字符。
  let text = String(content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think\s*>/gi, '')
    .trim();
  const firstDraft = text.indexOf(DRAFT_MARK);
  if (firstDraft >= 0) {
    const secondDraft = text.indexOf(DRAFT_MARK, firstDraft + DRAFT_MARK.length);
    if (secondDraft >= 0) text = text.slice(0, secondDraft).trimEnd();
  }
  let pos = 0;
  let current: 'draft' | 'translation' | 'notes' = 'draft';
  let structured = false;
  const parts: Record<'draft' | 'translation' | 'notes', string[]> = {
    draft: [],
    translation: [],
    notes: [],
  };

  while (pos < text.length) {
    let next = -1;
    let mark = '';
    for (const m of ALL_MARKS) {
      const i = text.indexOf(m, pos);
      if (i >= 0 && (next < 0 || i < next)) {
        next = i;
        mark = m;
      }
    }
    if (next < 0) {
      parts[current].push(text.slice(pos));
      break;
    }
    parts[current].push(text.slice(pos, next));
    structured = true;
    current = mark === DRAFT_MARK ? 'draft' : mark === TRANSLATION_MARK ? 'translation' : 'notes';
    // 注解段落保留原标记，客服一眼能看出哪块是说明、哪块是资料来源
    if (current === 'notes') parts.notes.push(mark);
    pos = next + mark.length;
  }

  const join = (arr: string[]): string => arr.join('').replace(/^[\r\n]+|[\r\n]+$/g, '').trim();
  let clean = join(parts.draft);
  if (!structured) clean = text.trim();
  if (!clean && text.trim()) clean = text.trim(); // 极端兜底：宁可多复制，也不能复制出空字符串

  return {
    clean,
    translation: join(parts.translation),
    notes: join(parts.notes),
    structured,
  };
}

/** 只拿能发给客户的正文：复制按钮、确认发送、案例库入库都把这里当作唯一入口 */
export function cleanDraftText(content: string): string {
  return splitDraft(content).clean;
}

/**
 * 发给客户的「外文正文」最后一道清洗。
 *
 * 外部 AI 查到中文命名的资料文件后，偶尔会把「请打开 2025年…报价表.xlsx」这类句子
 * 直接写进给客户的西语 / 英语正文里。客户既看不到你电脑上的文件，也会看到一堆看不懂的中文。
 * 这里把中文文件名换成通用外文说法，仍含中文的整行直接去掉（宁可少一句，也不发中文）。
 * 只有在客户语种不是中文时才调用；客户本人用中文提问时正文本来就该是中文。
 */
export function sanitizeForeignDraft(text: string): string {
  let s = String(text ?? '');
  // 中文文件名（带扩展名），连同外层引号一起替换
  s = s.replace(
    /["'「']?[\u4e00-\u9fa5][\u4e00-\u9fa5\w\s\-_.()（）]*\.(?:xlsx|xls|xlsm|csv|pdf|docx?|txt|png|jpe?g|webp)["'」']?/gi,
    'our product catalogue',
  );
  // 残留的分块标记
  s = s.replace(/【[^】]*】/g, '');
  // 仍然含中文的行：整行删掉
  s = s.split('\n').filter((line) => !/[\u4e00-\u9fa5]/.test(line)).join('\n');
  // 收尾：空引号、多余空格、连续空行
  s = s.replace(/["'`]{2}/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
