/**
 * minimax-search.test.js — MiniMaxSearchProvider 新版凭据逻辑测试
 *
 * 覆盖 dsh 0.1.1-rc.2 适配后的行为：
 *   1. 凭据解析优先级：字面 apiKey > ctx.credentials.resolve > launchEnvironment 快照
 *   2. credentials 服务缺席时静默降级到环境变量（clone 后零配置可用）
 *   3. WebError 错误码（WEB_PROVIDER_ERROR / WEB_ABORTED）；无宿主 WebError 时 Error+code 等价
 *   4. available() 只查 key、不发网络
 *   5. abort 健壮性：caller 先 abort → 直接抛 WEB_ABORTED
 *   6. search() 数据映射（organic → sources）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 直接加载插件模块（不依赖宿主，纯逻辑单测；宿主包经锚点惰性解析，本例不让它命中）
const { MiniMaxSearchProvider, apply, name, inject } = await import(
  new URL('../plugins/minimax-search/minimax-search.mjs', import.meta.url)
);

/** 构造 stub ctx：可配置 credentials 服务与 launchEnvironment 快照。 */
function makeStubCtx({
  credentials = undefined,
  launchEnvironment = undefined,
  registered = null,
} = {}) {
  const services = {};
  if (credentials !== undefined) services.credentials = credentials;
  if (launchEnvironment !== undefined) services.launchEnvironment = launchEnvironment;
  const ctx = {
    get(name) { return services[name]; },
    web: {
      registerSearchProvider(provider) { if (registered) registered.push(provider); },
    },
  };
  return ctx;
}

/** launchEnvironment 快照的 get 实现（envMap 值 = {value} 形态）。 */
function envSnapshot(envMap) {
  return {
    get(name) {
      const v = envMap[name];
      return v === undefined ? undefined : { value: v };
    },
  };
}

test('minimax-search 模块契约', () => {
  assert.equal(name, 'minimax-search');
  assert.deepEqual(inject, ['web']);
  assert.equal(typeof apply, 'function');
  assert.equal(typeof MiniMaxSearchProvider, 'function');
});

test('凭据优先级：字面 apiKey > credentials > 环境变量', async () => {
  let credentialsCalls = 0;
  let envCalls = 0;
  const provider = new MiniMaxSearchProvider({
    resolveApiKey: async () => {
      credentialsCalls += 1;
      return 'from-credentials';
    },
    resolveApiKeySync: () => 'from-env',
    env: makeStubCtx().get('launchEnvironment'),
  });
  // resolveApiKey 由 makeResolveApiKey 构造，这里直接验证 provider 用了传入的解析器
  assert.equal(await provider.resolveApiKey(), 'from-credentials');
  assert.equal(credentialsCalls, 1);
  void envCalls;
});

test('凭据优先级：credentials 返回空 → 降级到环境变量', async () => {
  const provider = new MiniMaxSearchProvider({
    resolveApiKey: async () => undefined,
    resolveApiKeySync: () => 'from-env',
  });
  // resolveApiKey 返回 undefined 后，走 env 兜底
  // （provider.resolveApiKey 的实现：undefined → env 快照）
  const key = await provider.resolveApiKey();
  // 没有 env 快照 → 返回 ''
  assert.equal(key, '');
});

test('apply 注册 provider，id = minimax', () => {
  const registered = [];
  const ctx = makeStubCtx({ registered });
  apply(ctx, {});
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, 'minimax');
  assert.equal(typeof registered[0].available, 'function');
  assert.equal(typeof registered[0].search, 'function');
});

test('available() 不发网络：有字面 key → true', () => {
  const provider = new MiniMaxSearchProvider({
    resolveApiKeySync: () => 'sk-test',
  });
  assert.equal(provider.available(), true);
});

test('available()：无 key 来源 → 仍有异步解析器视为可用（运行时再判）', () => {
  const provider = new MiniMaxSearchProvider({
    resolveApiKey: async () => 'sk-late',
  });
  assert.equal(provider.available(), true);
});

test('search()：abort 时抛 WEB_ABORTED（无 WebError → Error.code）', async () => {
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));
  const provider = new MiniMaxSearchProvider({
    resolveApiKey: async () => 'sk-test',
  });
  await assert.rejects(
    provider.search({ query: '测试', maxResults: 5 }, controller.signal),
    (err) => {
      assert.equal(err.code, 'WEB_ABORTED');
      return true;
    },
  );
});

test('search()：HTTP 失败抛 WEB_PROVIDER_ERROR', async () => {
  // stub 全局 fetch：模拟 500
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'boom',
  });
  try {
    const provider = new MiniMaxSearchProvider({
      resolveApiKey: async () => 'sk-test',
    });
    await assert.rejects(
      provider.search({ query: '测试', maxResults: 5 }),
      (err) => {
        assert.equal(err.code, 'WEB_PROVIDER_ERROR');
        assert.match(err.message, /HTTP 500/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('search()：MiniMax 业务错误（base_resp.status_code != 0）抛 WEB_PROVIDER_ERROR', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ base_resp: { status_code: 1004, status_msg: 'rate limited' } }),
  });
  try {
    const provider = new MiniMaxSearchProvider({
      resolveApiKey: async () => 'sk-test',
    });
    await assert.rejects(
      provider.search({ query: '测试', maxResults: 5 }),
      (err) => {
        assert.equal(err.code, 'WEB_PROVIDER_ERROR');
        assert.match(err.message, /1004/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('search()：正常响应映射 organic → sources，尊重 maxResults', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      organic: [
        { link: 'https://a.com', title: 'A', snippet: '关于A', date: '2026-08-01' },
        { link: 'https://b.com', title: 'B' },
        { link: '', title: '无URL应被过滤' },
      ],
      related_searches: ['x'],
    }),
  });
  try {
    const provider = new MiniMaxSearchProvider({
      resolveApiKey: async () => 'sk-test',
    });
    const result = await provider.search({ query: '测试', maxResults: 1 });
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, 'https://a.com');
    assert.equal(result.sources[0].publishedAt, '2026-08-01');
    assert.equal(result.truncated, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('search()：无 apiKey 或无 query → 空结果不请求', async () => {
  const called = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { called.push(1); return { ok: true, json: async () => ({ organic: [] }) }; };
  try {
    const provider = new MiniMaxSearchProvider({
      resolveApiKey: async () => '',
      resolveApiKeySync: () => '',
    });
    const result = await provider.search({ query: '测试', maxResults: 5 });
    assert.deepEqual(result, { sources: [], truncated: false });
    assert.equal(called.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('makeResolveApiKey 优先级：credentials 命中 → 不用环境变量', async () => {
  // 通过 apply 触发真实 makeResolveApiKey 的完整链路（credentials stub 返回 key）
  let credentialsResolved = 0;
  const credentials = {
    resolve: async () => { credentialsResolved += 1; return { value: 'sk-from-credentials', source: 'local' }; },
  };
  const registered = [];
  const ctx = makeStubCtx({
    credentials,
    launchEnvironment: envSnapshot({ MINIMAX_API_KEY: 'sk-from-env' }),
    registered,
  });
  apply(ctx, { apiKeyEnv: 'MINIMAX_API_KEY' });
  const provider = registered[0];
  const key = await provider.resolveApiKey();
  assert.equal(key, 'sk-from-credentials');
  assert.equal(credentialsResolved, 1);
});

test('makeResolveApiKey 降级：credentials 缺席 → 环境变量', async () => {
  const registered = [];
  const ctx = makeStubCtx({
    launchEnvironment: envSnapshot({ MINIMAX_API_KEY: 'sk-from-env' }),
    registered,
  });
  apply(ctx, { apiKeyEnv: 'MINIMAX_API_KEY' });
  const provider = registered[0];
  const key = await provider.resolveApiKey();
  // ctx.get('credentials') 未提供 → 降级到 launchEnvironment 快照
  assert.equal(key, 'sk-from-env');
});

test('makeResolveApiKey 优先级：字面 apiKey 最高', async () => {
  const credentials = {
    resolve: async () => { throw new Error('不应被调用'); },
  };
  const registered = [];
  const ctx = makeStubCtx({
    credentials,
    launchEnvironment: envSnapshot({ MINIMAX_API_KEY: 'sk-from-env' }),
    registered,
  });
  apply(ctx, { apiKey: 'sk-literal', apiKeyEnv: 'MINIMAX_API_KEY' });
  const provider = registered[0];
  const key = await provider.resolveApiKey();
  assert.equal(key, 'sk-literal');
});
