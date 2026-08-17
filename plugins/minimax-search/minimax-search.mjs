/**
 * minimax-search.js — DSH 宿主插件：MiniMax 搜索 Provider
 *
 * 把 MiniMax「coding_plan/search」搜索 API 注册为 DSH 的 web 搜索 provider，
 * 使 DSH Agent（以及经桥接器的钉钉会话）能够使用真实的网页搜索。
 *
 * 机制（已验证可用的 MiniMax API，纯 HTTP，不需要 MCP / uvx）：
 *   POST https://api.minimaxi.com/v1/coding_plan/search   (国内)
 *   POST https://api.minimax.io/v1/coding_plan/search     (国际)
 *   Headers: Authorization: Bearer <MINIMAX_API_KEY>
 *   Body:    { "q": "查询词" }
 *   响应:    { "organic": [{title, link, snippet, date}], "related_searches": [...] }
 *
 * 注册到 ctx.web.registerSearchProvider：id = "minimax"
 *
 * API key 来源（按优先级）：
 *   1. config.apiKey（patch 配置里显式填写）
 *   2. DSH 启动环境变量 MINIMAX_API_KEY（推荐，不必写进配置文件）
 *
 * DSH 宿主可用能力：global fetch（参照 dsh-web-search-deepseek 官方 provider）；
 * 环境变量通过 launchEnvironmentOf(ctx) 解析（复用 DSH 的环境抽象，比裸 process.env 可靠）。
 */

const MINIMAX_SEARCH_ENDPOINT_GLOBAL = 'https://api.minimax.io/v1/coding_plan/search';
const MINIMAX_SEARCH_ENDPOINT_CN = 'https://api.minimaxi.com/v1/coding_plan/search';

function resolveEndpointFromEnv(env) {
  const host = (env?.get?.('MINIMAX_API_HOST')?.value || '').trim();
  if (host) {
    if (host.includes('minimaxi.com')) return MINIMAX_SEARCH_ENDPOINT_CN;
    if (host.includes('minimax.io')) return MINIMAX_SEARCH_ENDPOINT_GLOBAL;
    return `${host.replace(/\/+$/, '')}/v1/coding_plan/search`;
  }
  return MINIMAX_SEARCH_ENDPOINT_CN;
}

export class MiniMaxSearchProvider {
  constructor({ apiKey = '', env = undefined } = {}) {
    this.id = 'minimax';
    this.apiKey = apiKey || (env?.get?.('MINIMAX_API_KEY')?.value) || '';
    this.env = env;
  }

  /** 本地可用性检查：只要 key 存在就算可用（不发网络请求）。 */
  available() {
    return Boolean(this.resolveApiKey());
  }

  /**
   * 每次调用实时解析 key（不依赖构造时机），优先级：
   *   1. 构造传入的 apiKey（config.apiKey）
   *   2. launchEnvironment 快照的 MINIMAX_API_KEY（DSH 启动时 ~/.dsh/.env 已注入快照）
   *
   * 注意：宿主插件环境无 `process`，绝不引用 process.env（会抛 ReferenceError）。
   */
  resolveApiKey() {
    if (this.apiKey) return this.apiKey;
    const fromSnapshot = this.env?.get?.('MINIMAX_API_KEY')?.value;
    return fromSnapshot || '';
  }

  async search(request, signal) {
    const query = request.query;
    const apiKey = this.resolveApiKey();
    if (!query || !apiKey) return { sources: [], truncated: false };
    const maxResults = request.maxResults;

    const endpoint = resolveEndpointFromEnv(this.env);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ q: query }),
      ...(signal !== undefined ? { signal } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MiniMax 搜索失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax 搜索错误 ${data.base_resp.status_code}: ${data.base_resp.status_msg || 'unknown'}`);
    }

    const organic = Array.isArray(data.organic) ? data.organic : [];
    const sources = organic
      .slice(0, maxResults)
      .map((entry) => ({
        url: entry.link || '',
        title: entry.title || '',
        snippet: entry.snippet || '',
        publishedAt: entry.date || undefined,
      }))
      .filter((s) => s.url);

    return { sources, truncated: false };
  }
}

export const name = 'minimax-search';
export const inject = ['web'];

export function apply(ctx, config) {
  const env = ctx.get('launchEnvironment');
  const provider = new MiniMaxSearchProvider({
    apiKey: config?.apiKey || '',
    env,
  });
  ctx.web.registerSearchProvider(provider);
}
