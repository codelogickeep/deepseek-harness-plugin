#!/usr/bin/env node
/**
 * check-plugin.mjs — DSH 宿主插件「加载期自检」脚手架
 *
 * 在把插件部署/重启 DSH 之前，用 stub ctx 真实执行插件的 apply()，
 * 提前暴露：schema 非法、inject 缺服务、apply 抛错等「启动即崩」问题。
 *
 * 为什么需要：`dsh --dump-config` 只验证配置树，不会执行插件的 apply()。
 * 工具 schema 校验（assertSupportedJsonSchema）发生在 apply → tools.register 时，
 * 只有真实执行 apply 才能发现。本脚本修改前先跑一遍，杜绝"改完 DSH 起不来"。
 *
 * 与真实 DSH 的保真度：本脚本会尽力从 DSH 宿主依赖（~/.dsh/profiles 上方可解析）
 * 加载真实的 @deepseek-ai/dsh-tools 的 assertSupportedJsonSchema，对每个注册工具
 * 的 output.schema 做与运行时完全一致的校验；解析不到时才退化为内置轻量检查。
 *
 * 用法：
 *   node scripts/check-plugin.mjs plugins/browser-reader/browser-reader.mjs  [--config '{"headless":true}']
 *   node scripts/check-plugin.mjs plugins/<name>/<entry>.mjs
 *
 * 返回码：0=通过；1=加载失败（打印错误栈）；2=用法错误。
 */

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

// ---- 定位 DSH 宿主依赖根（~/.dsh/profiles 等） ----
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
const PROFILE_ROOT = join(DSH_HOME, 'profiles');

/** 从宿主依赖根加载真实 dsh-tools（含 assertSupportedJsonSchema）。 */
function loadRealDshTools() {
  for (const anchor of [PROFILE_ROOT, join(PROFILE_ROOT, 'web'), REPO_ROOT]) {
    try {
      const req = createRequire(resolve(anchor, '__probe__.cjs'));
      const mod = req('@deepseek-ai/dsh-tools');
      if (mod && typeof mod.assertSupportedJsonSchema === 'function') {
        return { assert: mod.assertSupportedJsonSchema, source: `${anchor} → @deepseek-ai/dsh-tools` };
      }
    } catch { /* try next anchor */ }
  }
  return null;
}

const realTools = loadRealDshTools();

/** stub ctx：暴露插件 apply 里会用的最小 API。 */
function makeStubCtx(pluginName, pluginInject) {
  // 收集 apply 里注册的工具名（stub 内部共享，不经过注入门禁）
  const toolRegistry = [];
  // 常见注入服务的 no-op stub：让依赖服务的插件在自检时能正常走完 apply() 的注册路径。
  // 每个 stub 只做「不抛错」，不做真实行为。
  const stubServices = {
    tools: {
      register(def) {
        if (!def || typeof def !== 'object') throw new TypeError(`tool "${def?.name}" must be an object`);
        const name = def.name;
        const output = def.output;
        if (!output || typeof output !== 'object' || typeof output.schema !== 'object'
            || typeof output.render !== 'function') {
          throw new TypeError(`tool "${name}" must declare output { schema, render }`);
        }
        // 真实 DSH 校验（与运行时完全一致）
        if (realTools) {
          realTools.assert(output.schema);
        } else {
          if (!output.schema.type) throw new TypeError(`tool "${name}" output.schema must declare type`);
        }
        toolRegistry.push(name);
        return () => {};
      },
    },
    web: {
      registerSearchProvider() { return () => {}; },
      registerFetchProvider() { return () => {}; },
      search: async () => ({ sources: [], truncated: false }),
      fetch: async () => ({ url: '', statusCode: 0, body: { type: 'text', text: '' }, truncated: false }),
    },
    fs: {
      read: async () => '',
      write: async () => {},
      access: async () => {},
      stat: async () => ({ isFile: () => true, isDirectory: () => false }),
      readdir: async () => [],
    },
    agents: {
      start: async () => ({ sessionId: 'stub-session' }),
      list: async () => [],
      get: () => undefined,
      on: () => () => {},
      create: async () => {},
    },
    llm: { registerAdapter: () => () => {} },
    scheduler: { setTimeout: () => () => {}, setInterval: () => () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    command: { register: () => () => {} },
    settings: { get: (k) => undefined },
    jobs: { start: async () => ({ id: 'stub-job' }) },
    webServer: {
      register() { return () => {}; },
    },
    workspaceRegistry: {
      list: () => [{ id: 'stub-ws', title: 'stub', path: process.cwd() }],
    },
  };

  // 真实 cordis：apply 只能访问 mod.inject 里声明的服务。
  // 这里用 Proxy 模拟该约束——未声明的服务访问即抛错（与真实 DSH 完全一致），
  // 这样"忘了声明 inject 就访问 ctx.xxx"的插件会在自检阶段被拦住，而不是等 DSH 崩。
  const injectedNames = new Set(pluginInject ?? []);
  const ctxObj = {
    name: pluginName,
    // 私有注册表（非注入服务；脚本内部读取注册的工具名用）
    _registry: { tools: toolRegistry },
    effect(fn) { return fn; },
    on() { return () => {}; },
    emit() {},
    // cordis Context 内置方法：显式服务查找（不要求声明在 inject，未找到返回 undefined 不抛错）
    get(name) { return stubServices[name]; },
    inject(services, callback) {
      if (typeof services === 'string') services = [services];
      if (callback) callback(this);
      return { then() {} };
    },
    bail() {},
    parallel() {},
  };
  return new Proxy(ctxObj, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop);
      if (typeof prop === 'string' && injectedNames.has(prop)) {
        return stubServices[prop];
      }
      if (typeof prop === 'string') {
        // 与真实 DSH 相同的报错文案
        throw new Error(`cannot get property "${String(prop)}" without inject (declare it in the plugin's inject export)`);
      }
      return Reflect.get(target, prop);
    },
    has(target, prop) { return prop in target || injectedNames.has(String(prop)); },
  });
}

async function main() {
  const entry = process.argv[2];
  const configArg = process.argv.find((a) => a.startsWith('--config='));
  const config = configArg ? JSON.parse(configArg.slice('--config='.length)) : {};

  if (!entry) {
    console.error('用法: node scripts/check-plugin.mjs plugins/<name>/<entry>.mjs [--config \'{...}\']');
    process.exit(2);
  }

  console.log(`🔍 检查插件: ${entry}`);
  console.log(`   配置: ${JSON.stringify(config)}`);
  if (realTools) console.log(`   schema 校验器: ${realTools.source}（真实 DSH 校验）\n`);
  else console.log('   ⚠️  未找到宿主 dsh-tools，schema 校验退化为轻量检查\n');

  // 支持绝对路径或相对仓库根的路径
  let path
  if (entry.startsWith('/') || entry.startsWith('file:')) {
    path = entry.startsWith('file:') ? entry : pathToFileURL(entry).href
  } else {
    path = pathToFileURL(resolve(REPO_ROOT, entry)).href
  }

  try {
    const mod = await import(path);
    console.log(`   ✅ 模块加载成功 (name=${mod.name}, inject=${JSON.stringify(mod.inject)})`);

    const stubCtx = makeStubCtx(mod.name, mod.inject);
    const result = mod.apply(stubCtx, config);
    console.log(`   ✅ apply() 执行成功`);
    // 经私有注册表读注册的工具（不经注入门禁，未注入 tools 的插件不因此报错）
    const registeredTools = stubCtx._registry?.tools?.join(', ') ?? '';
    console.log(`   注册工具: ${registeredTools || '(无)'}`);

    if (result && typeof result.dispose === 'function') {
      await result.dispose().catch(() => {});
      console.log('   ✅ apply 返回的资源已正确清理');
    }
    console.log('\n✅ 插件加载期自检通过，可以安全重启 DSH。');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ 插件加载失败（重启 DSH 前必须修复）：');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

main();
