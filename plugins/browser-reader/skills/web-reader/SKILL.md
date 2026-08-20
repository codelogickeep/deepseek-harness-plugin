---
name: web-reader
description: 用真实浏览器阅读网页的能力——打开 JS 渲染页面、确定性读取渲染正文、检查控制台、截图、关闭。用于读动态网页内容、验证前端工作、对比页面效果。
invocation:
  modelInvocable: true
  userInvocable: true
---

# Web Reader 技能

本技能教 Agent 用 `web_read` 系列工具**确定性**地阅读真实浏览器渲染的网页。

## 为什么用这套工具

DSH 内置 `web_fetch` 只能拿到服务器返回的 HTML，读不了 JavaScript 渲染后的内容
（SPA、动态表格、懒加载列表、需要等待的内容）。`web_read` 驱动真实 Chromium/Edge，
能拿到渲染完成后的真实文本。

## 标准流程

### 1. 打开并阅读

```text
web_read(target="https://example.com/article")
```

返回 `pageId`、`title`、`content`（渲染后的正文文本）、`truncated`（是否截断）。

- **本地验证前端工作**：`web_read(target="/Users/me/project/dist/index.html")`
  或目录 `web_read(target="/Users/me/project/dist")`（自动起只读静态服务）。
- **远程站点**：本地主机默认放行；其他域名需先在 `cordis.patch.yml` 的
  `browser-reader.allowedHosts` 注册，否则报错提醒配置。

### 2. 内容过长时继续读

```text
web_read_continue(pageId="1")     # 默认向下滚动一个视口触发懒加载
web_read_continue(pageId="1", scrollPx=3000)   # 大步长滚动
```

懒加载/虚拟列表页面可能需要多次调用。直到 `truncated: false` 即读完整。

### 3. 检查页面健康度（验证前端必做）

```text
web_read_console(pageId="1")
```

返回控制台错误和失败请求。**空 = 页面健康**。有错误要排查修复。

### 4. 截图给人类复核

```text
web_read_screenshot(pageId="1", fullPage=true)
```

截图保存到工作区 `.dsh-web-read/`。截图是**给人类看**的，不要靠它做机器判断；
机器判断必须用 `web_read` / `web_read_console` 的确定性输出。

### 5. 用完关闭

```text
web_read_close(pageId="1")
```

释放浏览器资源。

## 判读规则

- 正文提取优先 `article` / `main` / `[role="main"]` 等语义容器，取渲染后的 `innerText`。
- 判定「页面是否正常渲染」：`web_read` 有正文 + `web_read_console` 无 error + 无失败请求。
- 定位元素/样式验证：用 `web_read(pageId, mode="html")` 读 outerHTML 自己分析，
  或读对应区域文本。

## 边界与注意

- **不输密码**。本技能不提供表单填写/登录能力，只是阅读。
- **截图不拍秘密**。包含 API key/令牌的页面不要截图。
- 无头渲染与真实桌面浏览器有差异（GPU、指针锁、系统弹窗），涉及这些差异时如实说明。
- 一条 DSH 进程共享一个浏览器进程；阅读完及时 `web_read_close`。
