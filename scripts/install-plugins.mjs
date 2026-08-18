#!/usr/bin/env node
/**
 * install-plugins.mjs — DSH 宿主插件安装脚手架
 *
 * 把本仓库 `plugins/<name>/` 下的 DSH 宿主插件整目录同步到 DSH 的 profile plugins 目录
 * （默认 `~/.dsh/profiles/web/plugins/`），使宿主 `cordis.patch.yml` 能加载它们。
 *
 * 目录规矩（README「脚手架」）：
 *   - 每个 DSH 宿主插件 = `plugins/<name>/` 一个自包含子目录（源码 + 依赖）
 *   - 复制目标 = `plugins/<name>/`（保持子目录结构与文件层次）
 *   - cordis.patch.yml 引用 `./plugins/<name>/<入口文件>`
 *
 * 设计原则：
 *   - 仓库是插件源码的唯一真相源（single source of truth）
 *   - 本脚本做「发布/安装」动作：从仓库 COPY 到宿主（不是软链，避免宿主误改影响仓库；
 *     也避免软链在部分 macOS 工具下失效）
 *   - 可重复执行、幂等（每次全量覆盖目标文件；先清掉宿主旧版本再装新版本）
 *
 * 用法：
 *   npm run install:plugins              # 安装全部插件到默认 web profile
 *   node scripts/install-plugins.mjs     # 同上
 *   DSH_PROFILE=tui node scripts/install-plugins.mjs   # 装到指定 profile
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGINS_SRC = join(REPO_ROOT, 'plugins');
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'web';

/** 递归复制 srcDir 到 destDir。 */
function copyTree(srcDir, destDir) {
  let count = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      count += copyTree(src, dest);
    } else if (entry.isFile()) {
      cpSync(src, dest, { force: true });
      count += 1;
    }
  }
  return count;
}

function main() {
  if (!existsSync(PLUGINS_SRC)) {
    console.log(`⚠️  仓库没有 plugins/ 目录（${PLUGINS_SRC}），无需安装。`);
    process.exit(0);
  }

  const pluginNames = readdirSync(PLUGINS_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (pluginNames.length === 0) {
    console.log('⚠️  plugins/ 下没有插件子目录，无需安装。');
    process.exit(0);
  }

  const destRoot = join(DSH_HOME, 'profiles', PROFILE, 'plugins');
  mkdirSync(destRoot, { recursive: true });

  let installed = 0;
  for (const name of pluginNames) {
    const srcDir = join(PLUGINS_SRC, name);
    const destDir = join(destRoot, name);
    // 幂等：先移除宿主旧版本，再整目录安装
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    const n = copyTree(srcDir, destDir);
    installed += n;
    console.log(`✅ 安装插件 [${name}] → ${destDir}/ (${n} 个文件)`);
  }

  console.log(`\n已完成：共安装 ${installed} 个文件。`);
  console.log(`目标宿主：${destRoot}`);
  console.log('提示：修改后若 HMR 未生效，请重启 DSH（或确认 cordis.patch.yml 已引用插件）。');
}

main();
