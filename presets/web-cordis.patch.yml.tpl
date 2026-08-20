# 仓库维护的 DSH 插件 patch 片段（供 install-plugins.mjs 合并到
# `~/.dsh/profiles/<profile>/cordis.patch.yml`，幂等：按 id 检测，缺失才追加）。
#
# 注意：这是「我们插件的 insert 引用」唯一真相源。官方/用户已有条目
# （如 web-search-deepseek 禁用、web.searchProvider、schedule 定时器）
# 不属于本文件——它们仍在 profile 里手工维护，本片段只负责追加插件引用。
#
# 合并策略（见 scripts/install-plugins.mjs ensurePluginPatchRefs）：
#   解析目标 patch，对每个插件 id：
#   1) 已在文件中（顶层或 insert 内）→ 跳过；
#   2) 缺失 → 把本条（含完整缩进）插入到目标 `- insert:` 数组的最后一个成员之后。
#
# 缩进约定：本文件与 cordis.patch.yml 一致——`insert` 是顶层 key（0 缩进），
# 其数组成员 4 空格缩进（`    - id: ...`），成员字段再 +2（6 空格）。
insert:
    - id: minimax-search
      name: ./plugins/minimax-search/minimax-search.mjs

    - id: cron-scheduler
      name: ./plugins/cron-scheduler/cron-scheduler.mjs
      # v2: lastFired 状态文件兜底 + 不再写 cron/dispatch 自定义事件;整目录自包含(核心 cron.js/scheduler.js 随插件)

    - id: browser-reader
      name: ./plugins/browser-reader/browser-reader.mjs
      # 真实浏览器阅读：web_read / web_read_continue / web_read_console / web_read_screenshot / web_read_close
      # 依赖：profile 已装 playwright-core（install-plugins.mjs 自动处理）
      config:
          headless: true
          browserChannels: [chrome, msedge, chromium]
          allowedHosts: []

    - id: ui-enhance
      name: '@dsh-local/ui-enhance'
      # 增强型 UI 交互界面客户端插件（dsh.client 声明 + ./client bundle）
      # 源码: plugins/ui-enhance/ ；构建: tsdown → lib/client.js；安装: pnpm add file: 到 profile
