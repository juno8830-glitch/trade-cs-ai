import type { FastifyInstance } from 'fastify';
import { executeTool } from '../tools/index.js';

/** 客户端附件面板 / 调试用的工具直调入口 */
export default async function toolsRoute(app: FastifyInstance): Promise<void> {
  const routes: Array<[string, string]> = [
    ['/v1/tools/file-search', 'file_search'],
    ['/v1/tools/quote-lookup', 'quote_lookup'],
    ['/v1/tools/library-search', 'library_search'],
    ['/v1/tools/case-search', 'case_search'],
    ['/v1/tools/image-match-quote', 'image_match_quote'],
  ];
  for (const [path, tool] of routes) {
    app.post(path, async (req) => {
      const args = (req.body ?? {}) as Record<string, unknown>;
      return executeTool(tool, args);
    });
  }
}
