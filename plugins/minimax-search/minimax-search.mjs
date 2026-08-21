/**
 * minimax-search.mjs — DSH 宿主插件：MiniMax 搜索 Provider
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
 * 凭据来源（按优先级，对齐 dsh 0.1.1-rc.2 官方 web-search-deepseek 的新逻辑）：
 *   1. config.apiKey（patch 配置里显式填写的字面 key，兼容旧版）
 *   2. config.apiKeyEnv 指向的凭据引用（默认 MINIMAX_API_KEY），经 ctx.credentials
 *      凭据服务解析（官方新逻辑：凭据存 ~/.dsh/.credentials.yaml，界面可写、轮换不重启）
 *   3. DSH 启动环境变量 / launchEnvironment 快照（凭据服务缺席时的兜底，clone 后零配置可用）
 *
 * 错误走 @deepseek-ai/dsh-web 的 WebError（WEB_PROVIDER_ERROR / WEB_ABORTED），
 * 与官方 provider 同构，tool 层可把 code 放进结构化错误元数据；解析不到该包时
 * 把 code 挂到普通 Error 上（行为等价，仅缺 class 归属）。
 *
 * 依赖解析策略：插件不硬依赖任何官方包（保持自检/裸环境可加载），
 * 运行时用 createRequire 从宿主锚点（~/.dsh/profiles）解析官方 seam 包；
 * 解析不到时优雅降级到「纯 fetch + 环境变量」的旧行为——升级/回退都不会崩。
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MINIMAX_SEARCH_ENDPOINT_GLOBAL = 'https://api.minimax.io/v1/coding_plan/search';
const MINIMAX_SEARCH_ENDPOINT_CN = 'https://api.minimaxi.com/v1/coding_plan/search';

/** 默认凭据引用：环境变量名 + 凭据服务键（role: credential-ref 语义）。 */
const DEFAULT_API_KEY_ENV = 'MINIMAX_API_KEY';

/**
 * 宿主锚点解析器：从 DSH 宿主依赖根（~/.dsh/profiles 上方）解析官方 seam 包。
 * 与 scripts/check-plugin.mjs 加载真实 dsh-tools 用的同一技巧——真实宿主下
 * profile 的模块解析链能触达全局 dsh 的 node_modules。
 * 解析失败时返回 null（调用方降级，不抛错）。
 */
function loadHostModule(name) {
  try {
    const anchor = join(homedir(), '.dsh', 'profiles', '__probe__.cjs');
    const req = createRequire(anchor);
    return req(name);
  } catch {
    return null;
  }
}

// 惰性取 WebError（web seam 的标准错误类型），取不到返回 null
let _WebError;
function hostWebError() {
  if (_WebError === undefined) {
    const mod = loadHostModule('@deepseek-ai/dsh-web');
    _WebError = (mod && mod.WebError) || null;
  }
  return _WebError;
}

// 惰性取 launchEnvironmentOf（启动环境快照读取），取不到返回 null
let _launchEnv;
function hostLaunchEnvironmentOf() {
  if (_launchEnv === undefined) {
    const mod = loadHostModule('@deepseek-ai/dsh-launch-environment');
    _launchEnv = (mod && typeof mod.launchEnvironmentOf === 'function') ? mod.launchEnvironmentOf : null;
  }
  return _launchEnv;
}

function resolveEndpointFromEnv(env) {
  const host = (env?.get?.('MINIMAX_API_HOST')?.value || '').trim();
  if (host) {
    if (host.includes('minimaxi.com')) return MINIMAX_SEARCH_ENDPOINT_CN;
    if (host.includes('minimax.io')) return MINIMAX_SEARCH_ENDPOINT_GLOBAL;
    return `${host.replace(/\/+$/, '')}/v1/coding_plan/search`;
  }
  return MINIMAX_SEARCH_ENDPOINT_CN;
}

/** 抛 provider 的标准取消错误（caller 已 abort）。 */
function throwIfSearchAborted(signal, WebError) {
  if (signal?.aborted === true) throw searchAborted(signal, WebError);
}

/** 构造标准取消错误：优先 WebError(WEB_ABORTED)，否则 Error+code。 */
function searchAborted(signal, WebError) {
  const err = WebError
    ? new WebError('MiniMax search aborted', 'WEB_ABORTED', {
        cause: signal?.aborted === true ? signal.reason : undefined,
      })
    : new Error('MiniMax search aborted');
  if (!WebError) err.code = 'WEB_ABORTED';
  return err;
}

/** True for a fetch/`AbortSignal` abort。 */
function isAbortError(error) {
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError';
}

/** 包装 provider 失败为 WebError(WEB_PROVIDER_ERROR)（无 WebError 时降级 Error+code）。 */
function providerError(message, WebError, cause) {
  const err = WebError
    ? new WebError(message, 'WEB_PROVIDER_ERROR', cause !== undefined ? { cause } : undefined)
    : new Error(message);
  if (!WebError) err.code = 'WEB_PROVIDER_ERROR';
  return err;
}

/**
 * 从 launchEnvironment 快照读一个环境变量的 value（时间点取值，不含 process）。
 * 宿主锚点解析不到 launchEnvironmentOf 时用 ctx.launchEnvironment 快照兜底。
 */
function envValue(ctx, name) {
  try {
    const host = hostLaunchEnvironmentOf();
    if (host) {
      const env = host(ctx);
      return env?.get?.(name)?.value;
    }
  } catch { /* 降级 */ }
  try {
    const env = ctx.get?.('launchEnvironment');
    return env?.get?.(name)?.value;
  } catch { /* 降级 */ }
  return undefined;
}

/**
 * 凭据解析器：一次搜索一个快照，优先级
 *   字面 apiKey > ctx.credentials.resolve(apiKeyEnv) > launchEnvironment 快照。
 * credentials 服务缺席时静默降级到 launchEnvironment（clone 后零配置可用）。
 */
function makeResolveApiKey(ctx, apiKeyEnv, literalApiKey) {
  return async () => {
    if (literalApiKey !== undefined && literalApiKey.length > 0) return literalApiKey;
    try {
      const credentials = ctx.get?.('credentials');
      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        const resolved = await credentials.resolve(apiKeyEnv);
        if (resolved !== undefined && resolved.value !== undefined && resolved.value.length > 0) {
          return resolved.value;
        }
      }
    } catch {
      // 凭据解析失败（如引用不存在）→ 降级，不阻塞搜索
    }
    const ambient = envValue(ctx, apiKeyEnv);
    return (ambient !== undefined && ambient.length > 0) ? ambient : undefined;
  };
}

export class MiniMaxSearchProvider {
  /**
   * @param {object} opts
   * @param {string} [opts.id='minimax'] - provider id
   * @param {Function} [opts.resolveApiKey] - 每次操作实时解析凭据的 async 函数
   * @param {Function} [opts.resolveApiKeySync] - 同步快照兜底（available() 用，不发网络）
   * @param {object} [opts.env] - launchEnvironment 快照（兼容旧版构造）
   * @param {Function} [opts.WebErrorMod] - 宿主 WebError 类（可缺省）
   */
  constructor({ id = 'minimax', resolveApiKey, resolveApiKeySync, env = undefined, WebErrorMod = undefined } = {}) {
    this.id = id;
    this._resolveApiKey = resolveApiKey;
    this._resolveApiKeySync = resolveApiKeySync;
    this.env = env;
    this._WebError = WebErrorMod || hostWebError();
  }

  /** 本地可用性检查：只要 key 可能存在就算可用（不发网络请求）。 */
  available() {
    if (this._resolveApiKeySync !== undefined) {
      const key = this._resolveApiKeySync();
      if (key && key.length > 0) return true;
    }
    // 有异步解析器但拿不到同步值 → 仍视为可用（运行时再解析），避免误判缺失
    return this._resolveApiKey !== undefined;
  }

  /**
   * 每次调用实时解析 key（不依赖构造时机）。
   * 优先级与 makeResolveApiKey 一致；返回空字符串视为无凭据。
   */
  async resolveApiKey(signal) {
    throwIfSearchAborted(signal, this._WebError);
    if (this._resolveApiKey !== undefined) {
      const resolved = await this._resolveApiKey();
      if (resolved !== undefined && resolved.length > 0) return resolved;
    }
    // 兼容旧版：直接构造传 key / env 快照
    if (this.literalApiKey && this.literalApiKey.length > 0) return this.literalApiKey;
    const fromSnapshot = this.env?.get?.('MINIMAX_API_KEY')?.value;
    return fromSnapshot || '';
  }

  async search(request, signal) {
    const WebError = this._WebError;
    const query = request.query;
    throwIfSearchAborted(signal, WebError);
    const apiKey = await this.resolveApiKey(signal);
    if (!query || !apiKey) return { sources: [], truncated: false };
    const maxResults = request.maxResults;

    const endpoint = resolveEndpointFromEnv(this.env);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ q: query }),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, WebError);
      throw providerError(`MiniMax search request failed: ${String(error)}`, WebError, error);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw providerError(`MiniMax 搜索失败 HTTP ${res.status}: ${text.slice(0, 200)}`, WebError);
    }

    let data;
    try {
      data = await res.json();
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, WebError);
      throw providerError(`MiniMax 返回无法解析的响应体: ${String(error)}`, WebError, error);
    }

    if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
      throw providerError(
        `MiniMax 搜索错误 ${data.base_resp.status_code}: ${data.base_resp.status_msg || 'unknown'}`,
        WebError,
      );
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

/** 同步 apply：注册 provider；官方 seam 包经宿主锚点惰性解析，缺席静默降级。 */
export function apply(ctx, config) {
  const apiKeyEnv = (config && config.apiKeyEnv) || DEFAULT_API_KEY_ENV;
  const literalApiKey = (config && config.apiKey) || '';

  let env;
  try {
    const host = hostLaunchEnvironmentOf();
    if (host) env = host(ctx);
  } catch { /* 降级 */ }
  try {
    if (env === undefined) env = ctx.get?.('launchEnvironment');
  } catch { /* 降级 */ }

  const provider = new MiniMaxSearchProvider({
    id: 'minimax',
    env,
    resolveApiKey: makeResolveApiKey(ctx, apiKeyEnv, literalApiKey),
    resolveApiKeySync: () => {
      if (literalApiKey && literalApiKey.length > 0) return literalApiKey;
      return envValue(ctx, apiKeyEnv) || '';
    },
  });
  ctx.web.registerSearchProvider(provider);
}
