import type { ToolDefinition, ToolTrace } from '@trade-cs-ai/core';
import { fileSearch } from './fileSearch.js';
import { quoteLookup } from './quoteLookup.js';
import { librarySearch } from './librarySearch.js';
import { caseSearch } from './caseSearch.js';
import { imageMatchQuote } from './imageMatchQuote.js';

export interface ToolResult {
  ok: boolean;
  data: Record<string, any>;
}

/** 客户端与 Agent 共用的工具清单；工具只在网关执行 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'file_search',
      description: '按型号+资料类型检索客服资料库（只读）',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: '产品型号或产品名' },
          kind: { type: 'string', enum: ['image', 'quote', 'cert', 'case'] },
          keyword: { type: 'string' },
        },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quote_lookup',
      description: '按型号查询本机资料库的真实价格、币种、货期、附加规格价及来源文件/工作表/行号；客户问价、问交期时必须先调用',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: '产品型号或产品名，支持不完整型号' },
        },
        required: ['sku'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'library_search',
      description: '在已整理的客服资料库里按型号、产品名、系列或关键词检索真实价格/货期/规格/来源行号；客户没给型号、问某类产品、要图片或证书时优先调用',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '型号、产品名、系列或任意关键词' },
          limit: { type: 'number', description: '最多返回几条，默认 8' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'case_search',
      description: '检索已入库的成功案例库',
      parameters: {
        type: 'object',
        properties: {
          country: { type: 'string' },
          product: { type: 'string' },
          keyword: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_match_quote',
      description: '客户发来产品图片时，用本地图片指纹库对照当前库存表 / 报价表里的产品图，返回最像的型号、出厂价、货期和来源文件/工作表/行号；只读本地索引，绝不猜价格。需要先建图片索引。',
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '客户图片的 base64 或 dataURL（界面选图后由程序传入）' },
          image_path: { type: 'string', description: '本机图片文件的完整路径（WorkBuddy 侧用）' },
          limit: { type: 'number', description: '最多返回几个候选，默认 5' },
        },
      },
    },
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.function.name);

/** Agent 只发意图，文件系统/数据库访问全部收敛在此 */
export async function executeTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  try {
    switch (name) {
      case 'file_search':
        return fileSearch(args as { sku?: string; kind?: string; keyword?: string });
      case 'quote_lookup':
        return quoteLookup(args as { sku?: string });
      case 'library_search':
        return librarySearch(args as { keyword?: string; limit?: number });
      case 'case_search':
        return caseSearch(args as { country?: string; product?: string; keyword?: string; limit?: number });
      case 'image_match_quote':
        return await imageMatchQuote(args as { image?: string; image_path?: string; limit?: number });
      default:
        return { ok: false, data: { hint: `未注册的工具：${name}` } };
    }
  } catch (e) {
    return { ok: false, data: { error: (e as Error).message } };
  }
}

export function summarizeTool(name: string, args: Record<string, unknown>, result: ToolResult): ToolTrace {
  const trace: ToolTrace = { name, args, ok: result.ok };
  if (result.data?.file) trace.file = String(result.data.file);
  if (result.data?.source_path) trace.file = String(result.data.source_path);
  if (result.data?.row) trace.row = Number(result.data.row);
  if (Array.isArray(result.data?.files) && result.data.files[0]?.path) trace.file = String(result.data.files[0].path);
  trace.summary = result.ok
    ? `${name} 命中`
    : String(result.data?.hint ?? result.data?.error ?? `${name} 未命中`);
  return trace;
}
