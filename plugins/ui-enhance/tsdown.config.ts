/**
 * ui-enhance — client bundle 构建配置（轻量版，参考 dsh-webui 的 external 策略）
 *
 * 产出：lib/client.js —— 一个调用 window.__ModuleLoader__.load({id, factory}) 的自包含
 * bundle（closure-factory 形态），react 全家桶与 @deepseek-ai/* 平台包走 external
 * （由 DSH 宿主的模块表回答），其余依赖内联。
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-local/ui-enhance'

/** 平台模块（loader 模块表可应答）：react 全家桶 + 全部 @deepseek-ai/* 平台包。 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  /^@deepseek-ai\//,
]

function isExternal(id: string): boolean {
  if (id.startsWith('\0')) return false
  return CLIENT_EXTERNALS.some((ext) => {
    if (ext instanceof RegExp) return ext.test(id)
    return ext === id
  })
}

// CSS 内联约定：把 .css 变成「注入 <style> 标签」的 JS。
const CSS_PREFIX = '\0ui-enhance-css:'
const CSS_SUFFIX = '.mjs'

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: (id: string) => {
      if (id.startsWith('\0')) return true
      if (isExternal(id)) return true
      return false
    },
    alwaysBundle: (id: string) => !isExternal(id),
  },
  // 关键：DSH client bundle 必须是 closure-factory 形态
  // （window.__ModuleLoader__.load({id, factory})），banner/footer 负责包装。
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {
var module = { exports: {} };
var exports = module.exports;`,
  footer: 'return module.exports; } });',
  plugins: [{
    name: 'ui-enhance-css-inline',
    async resolveId(source, importer) {
      if (!source.endsWith('.css')) return null
      if (source.startsWith('.')) {
        if (importer === undefined) return null
        return CSS_PREFIX + resolve(dirname(importer), source) + CSS_SUFFIX
      }
      return null
    },
    async load(id) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const path = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      const css = await readFile(path, 'utf8')
      const tagId = `${PLUGIN_ID}/${basename(path)}`
      return [
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {',
        '  const tag = document.createElement("style");',
        `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        `  tag.textContent = ${JSON.stringify(css)};`,
        '  document.head.appendChild(tag);',
        '}',
      ].join('\n')
    },
  }],
}

const hostBundle: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: false,
  outExtensions: () => ({ js: '.js' }),
}

export default [hostBundle, clientBundle]
