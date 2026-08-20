# Showcase: 5 DSH plugins + a one-command scaffold — including a live-git-status file tree

> 🐘 Repo: [codelogickeep/deepseek-harness-plugin](https://github.com/codelogickeep/deepseek-harness-plugin)
> License: MIT · 4 host plugins + 1 client-bundle plugin + 1 agent preset + install scaffold

## What's inside

| Plugin | Type | What it does |
| --- | --- | --- |
| **ui-enhance** | client bundle | Right-side **file tree** matching the left sidebar's light theme: recursive dirs, **live git badges (M/A/D/U)**, drag-to-resize, **double-click to open in your IDE** (VS Code/Cursor/Windsurf/Trae), copyable path header, git summary footer |
| **browser-reader** | host `.mjs` | `web_read` family tools driving real Chromium/Edge (SSR-proof reads, console, screenshots) |
| **minimax-search** | host `.mjs` | MiniMax as DSH web-search provider → `web_search` just works |
| **cron-scheduler** | host `.mjs` | 5-field cron scheduling (`0 10 * * *`), config-driven, crash-safe against double-fire |
| **flash-worker** | agent preset | adds `flash_agent`: pro orchestrates, flash executes |
| **dingtalk bridge** | standalone process | chat with your DSH agent from DingTalk |

## Highlight: live file tree (ui-enhance)

Unlike a static tree, this one updates **in real time** — `fs.watch` + SSE push a `changed` event and the client refreshes its git badges instantly. Commit a file and watch the `M` badge disappear without touching the page.

![file tree](../docs/demo-filetree.png)

## One-command scaffold (the part I'm most proud of)

Install *everything* (build + self-check + install into the profile + **append plugin references into `cordis.patch.yml`**) with one command:

```bash
npm install
cd plugins/ui-enhance && pnpm install && cd ../..
npm run install:plugins   # idempotent; keeps your hand-edited patch entries
```

The scaffold:
1. Runs a **load-time self-check** on every plugin before install (a stub `ctx` with a Proxy that mimics Cordis' inject gate — a plugin that would crash DSH at boot is rejected *before* it's installed)
2. Builds client bundles via tsdown closure-factory
3. Appends only the *missing* plugin references into `cordis.patch.yml` (never overwrites what you already have)

## Try it

```bash
npx @deepseek-ai/dsh web   # first, let it generate cordis.patch.yml
git clone https://github.com/codelogickeep/deepseek-harness-plugin.git
cd deepseek-harness-plugin
npm install
cd plugins/ui-enhance && pnpm install && cd ../..
npm run install:plugins
# restart dsh — all plugins live
```

Docs are in Chinese (deep-dive architecture, incident postmortems in `docs/`). Happy to answer questions here!

> ⚠️ DSH is in developer preview — these plugins target current `dsh web`.
