---
title: browser-reader：DSH 浏览器阅读插件（真实浏览器渲染 + 确定性读页）
description: Playwright 驱动 Chromium/Edge，web_read 系列工具读 JS 渲染页面。含工具说明、安全模型、配置、安装。
tags: [dsh, plugins, browser, playwright, web-read]
date: 2026-08-20
status: active
---
# browser-reader：DSH 浏览器阅读插件

给 DSH Agent 一个「真浏览器阅读」能力：用 Playwright 驱动本机 Chromium/Edge，
打开 JS 渲染页面后**确定性**读出渲染文本，而不是靠视觉模型猜。相比 DSH 内置
`web_fetch`（只拿 HTML，读不了 JS 渲染内容），这是完整浏览器阅读。

> 参考社区 [Viger1/dsh-preview](https://github.com/Viger1/dsh-preview) 的定位差异：
> dsh-preview 面向「前端自验证」提供交互工具 + 技能；本插件聚焦「阅读」，
> 提供 `web_read` 系列（打开→读→继续→console→截图→关闭），附带 `web-reader` skill。

## 工具集

| 工具 | 作用 |
| --- | --- |
| `web_read` | 打开 URL / 本地文件或目录，返回渲染后的正文文本（含 `pageId`/`title`/`content`/`truncated`）。`mode=html` 返回 outerHTML；`waitMs` 可等懒加载 |
| `web_read_continue` | 在已打开页面向下滚动（触发懒加载/虚拟列表），返回最新正文 |
| `web_read_console` | 页面的控制台消息 + 失败请求（判断页面健康度，验证前端必做） |
| `web_read_screenshot` | 截图保存到工作区 `.dsh-web-read/`（`fullPage` 整页）——**给人类复核**，机器判断仍靠 read/console |
| `web_read_close` | 关闭页面，释放浏览器资源 |

## 关键设计

- **无视觉确定性阅读**：正文提取优先 `article` / `main` / `[role=main]` 语义容器，取渲染后
  `innerText`；未经视觉模型，不靠像素判断。
- **本地静态伺服**：本地文件/目录自动以 `127.0.0.1` 临时端口只读伺服（SPA 回退 index.html），
  无需 nginx/静态服务器。
- **安全默认**：远程域名默认拒绝，需加入 `allowedHosts`；本地主机（localhost/127.0.0.1）开箱即用。
- **一个浏览器实例共享**：一条 DSH 进程一个 Chromium 进程（多会话复用），页面按 `pageId` 隔离；
  闲置 `keepAliveMs`（默认 15min）自动关闭。
- **依赖动态解析**：`playwright-core` 从宿主解析（安装脚本自动装到 profile），缺依赖时给出可读提示而非崩溃。

## 安装与配置

1. 仓库 `plugins/browser-reader/` 是源码唯一真相源；`npm run install:plugins` 自动：
   - 整目录同步到 `~/.dsh/profiles/web/plugins/browser-reader/`
   - 确保 `playwright-core` 已装进 profile（`~/.dsh/profiles/web/node_modules/`）
   - **先跑加载期自检**（`scripts/check-plugin.mjs`）再复制，杜绝装上起不来
2. patch 引用（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: browser-reader
      name: ./plugins/browser-reader/browser-reader.mjs
      config:
        headless: true
        browserChannels: [chrome, msedge, chromium]
        allowedHosts: []          # 远程站点域名（如 baidu.com）
```

3. 重启 DSH 生效。

### 依赖环境

- **Node**：DSH 同款（≥22）
- **浏览器**：自动识别本机 Chrome / Edge；都没有时运行一次
  `npx playwright install chromium` 并把 `browserChannels` 改为 `["chromium"]`
  （playwright 自带的 Chromium 会被下载到 `~/Library/Caches/ms-playwright`）。
  本机已验证 `~/Library/Caches/ms-playwright/chromium-1217/1228` 存在。

## 配置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `headless` | `true` | 无头运行（不弹窗口） |
| `browserChannels` | `[chrome, msedge, chromium]` | 依序尝试的浏览器通道 |
| `viewportWidth/Height` | 1280×800 | 新页面视口 |
| `navigationTimeoutMs` | 20000 | 导航超时 |
| `actionTimeoutMs` | 8000 | 截图等动作超时 |
| `screenshotDir` | `.dsh-web-read` | 截图目录（相对工作目录） |
| `maxReadChars` | 30000 | 单次读文字符上限（超限置 `truncated`）|
| `maxConsoleMessages` | 200 | 每页保留的 console 消息数 |
| `allowedHosts` | `[]` | 额外放行的远程主机名 |
| `keepAliveMs` | 15min | 无页面闲置后关闭浏览器 |

## 安全模型

- 本地 `localhost`/`127.0.0.1`/`::1` 永远放行（前端验证需要）。
- 远程主机 **默认拒绝**；要访问须先 `allowedHosts` 登记，工具错误信息会明确告知。
- 本地路径只读伺服有路径包含防护（`..` 拒绝）。
- 插件不提供登录/表单填写，不输密码；skill 禁止给含密钥页面截图。

## 附带 skill：web-reader

`skills/web-reader/SKILL.md` 教 Agent 标准流程：
**打开 → 读正文 → 过长继续读 → console 检查健康 → 截图给人类 → 关闭**，并给出判读规则
与边界（无头差异、不拍秘密）。启用方式参考 `@deepseek-ai/dsh-skill` 的 provider 注册；
默认工具本身已自述，skill 是增强项。

## 开发与验证

```bash
# 加载期自检（schema/apply，真 DSH 校验器）
node scripts/check-plugin.mjs plugins/browser-reader/browser-reader.mjs
# 冒烟：打开本地 HTML
node scripts/check-plugin.mjs plugins/browser-reader/browser-reader.mjs --config '{"headless":true}'
```

## 已知坑位（本次事故沉淀）

### `createRequire is not a function`（2026-08-20 修复）
- **现象**：插件在 DSH 里注册成功、启动正常，但一调用 `web_read` 就报
  `createRequire is not a function`。
- **根因**：动态加载 playwright-core 时写了 `const { createRequire } = globalThis`。
  `createRequire` 是 `node:module` 的导出，**普通 Node/DSH 运行环境的
  `globalThis` 上没有它**（Code Mode 沙箱更精简）。
- **为什么启动不崩**：`_loadPlaywright()` 是懒加载——`apply()` 只注册工具声明、
  不触发浏览器加载，所以自检/启动都通过；**真正执行工具时才崩**。
- **修复**：文件顶部 `import { createRequire } from 'node:module'`，然后直接 `createRequire(base)`。
- **教训**：① `.mjs` 里要用 Node 内置能力（require/globalThis 魔法）必须显式从
  `node:*` 导入，**别假设 globalThis 上有**；② 宿主插件验证不能只停 in apply——
  工具 execute 路径也要冒烟（本插件的浏览器启动已单独验证）。

### `page.evaluate` 传字符串导致 content 为函数对象（2026-08-20 修复）
- **现象**：修好 createRequire 后，`web_read` 仍报
  `Cannot read properties of undefined (reading 'length')`（execute 第 406 行）。
- **根因**：正文提取脚本 `EXTRACT_TEXT_FN` 用**模板字符串**写成了
  `"() => {...}"` 字符串，直接 `page.evaluate(EXTRACT_TEXT_FN)`。
  Playwright 的 `page.evaluate` 对**字符串按表达式求值**，`() => {...}` 会被当作
  **函数对象**返回（不是调用结果），于是 `content` 变成函数而非文本，后续
  `content.length` 崩。
- **修复**：把 `EXTRACT_TEXT_FN` 改为**真实函数声明**（纯函数、无闭包外依赖），
  `page.evaluate(EXTRACT_TEXT_FN)` 传函数引用，Playwright 自动序列化到浏览器执行。
- **教训**：① Playwright `evaluate` 传字符串是「表达式求值」不是「调用函数」，
  想执行一段逻辑请传**真实函数**；② 写完用最小驱动（stub ctx 拿 execute 直接调）
  验证 execute 路径，别等 Agent 会话烧额度才暴露。
