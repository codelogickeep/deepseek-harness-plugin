#!/usr/bin/env node
/**
 * install-plugins.mjs — DSH 宿主插件安装脚手架
 *
 * 把本仓库 `plugins/<name>/` 下的 DSH 宿主插件同步到 DSH 的 profile plugins 目录
 * （默认 `~/.dsh/profiles/web/plugins/`），使宿主 `cordis.patch.yml` 能加载它们。
 *
 * 设计原则：
 *   - 仓库是插件源码的唯一真相源（single source of truth）
 *   - 本脚本做「发布/安装」动作：从仓库 COPY 到宿主（不是软链，避免宿主误改影响仓库；
 *     也避免软链在部分 macOS 工具下失效）
 *   - 可重复执行、幂等（每次全量覆盖目标文件）
 *
 * 用法：
 *   npm run install:plugins              # 安装全部插件到默认 web profile
 *   node scripts/install-plugins.mjs     # 同上
 *   DSH_PROFILE=tui node scripts/install-plugins.mjs   # 装到指定 profile
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGINS_SRC = join(REPO_ROOT, 'plugins');
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'web';

function main() {
  if (!existsSync(PLUGINS_SRC)) {
    console.log(`⚠️  仓库没有 plugins/ 目录（${PLUGINS_SRC}），无需安装。`);
    process.exit(0);
  }

  const pluginDirs = readdirSync(PLUGINS_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (pluginDirs.length === 0) {
    console.log('⚠️  plugins/ 下没有插件子目录，无需安装。');
    process.exit(0);
  }

  const destRoot = join(DSH_HOME, 'profiles', PROFILE, 'plugins');
  mkdirSync(destRoot, { recursive: true });

  let installed = 0;
  for (const name of pluginDirs) {
    const srcDir = join(PLUGINS_SRC, name);
    // 该插件目录下所有文件（当前仅单文件，后续可扩展多文件）
    const files = readdirSync(srcDir).filter((f) => statSync(join(srcDir, f)).isFile());
    for (const f of files) {
      cpSync(join(srcDir, f), join(destRoot, f), { force: true });
      installed += 1;
    }
    console.log(`✅ 安装插件 [${name}] → ${join(destRoot)}/ (${files.join(', ')})`);
  }

  console.log(`\n已完成：共安装 ${installed} 个文件。`);
  console.log(`目标宿主：${destRoot}`);
  console.log('提示：修改后若 HMR 未生效，请重启 DSH（或确认 cordis.patch.yml 已引用插件）。');
}

main();
