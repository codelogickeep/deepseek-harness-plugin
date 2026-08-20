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
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGINS_SRC = join(REPO_ROOT, 'plugins');
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'web';

/**
 * 插件声明的宿主依赖（需要在 profile 的 node_modules 里可解析的包）。
 * 键 = 插件名，值 = npm 包名。安装插件时确保这些包在 profile 可用。
 * browser-reader 依赖 playwright-core 驱动真实浏览器。
 */
const PLUGIN_PROFILE_DEPS = {
  'browser-reader': ['playwright-core'],
};

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

/**
 * 确保 profile 的依赖里存在给定 npm 包（幂等）。
 * 在 profile 目录跑 `pnpm add <pkg...>`（hoisted 到 web/node_modules）。
 * 用 createRequire 实测解析而非只测目录名，避免「装了但 DSH 解析不到」的假成功。
 */
function ensureProfileDeps(profileDir, packages) {
  const missing = packages.filter((pkg) => {
    try {
      createRequire(profileDir + '/').resolve(`${pkg}/package.json`);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length === 0) {
    console.log(`ℹ️  profile 依赖已就绪：${packages.join(', ')}（无需安装）`);
    return;
  }
  console.log(`📦 正在为插件安装 profile 依赖：${missing.join(', ')} …`);
  const result = spawnSync('pnpm', ['add', ...missing], {
    cwd: profileDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`⚠️  pnpm add ${missing.join(' ')} 失败（退出码 ${result.status}）。`);
    console.error('   可手动重试：cd ' + profileDir + ' && pnpm add ' + missing.join(' '));
  } else {
    console.log(`✅ profile 依赖安装完成：${missing.join(', ')}`);
  }
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
  const profileDir = join(DSH_HOME, 'profiles', PROFILE);

  let installed = 0;
  const failed = [];
  for (const name of pluginNames) {
    const srcDir = join(PLUGINS_SRC, name);
    const destDir = join(destRoot, name);

    // 1) 复制前先对源码跑「加载期自检」（不依赖宿主，从仓库源码验证）
    //    自检通过才安装；失败则跳过，杜绝「安装了个会让 DSH 起不来的插件」。
    const checkResult = runPluginCheck(srcDir);
    if (checkResult === false) {
      console.error(`❌ 插件 [${name}] 自检失败，已跳过安装（不会写入 patch，DSH 不会因此起不来）。`);
      failed.push(name);
      continue;
    }
    if (checkResult === true) console.log(`✅ 插件 [${name}] 自检通过`);

    // 2) 幂等复制
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    const n = copyTree(srcDir, destDir);
    installed += n;
    console.log(`✅ 安装插件 [${name}] → ${destDir}/ (${n} 个文件)`);

    // 3) 有宿主依赖声明的插件，确保依赖在 profile 可解析
    const deps = PLUGIN_PROFILE_DEPS[name];
    if (deps) ensureProfileDeps(profileDir, deps);
  }

  if (failed.length > 0) {
    console.error(`\n⚠️  ${failed.length} 个插件自检失败未安装：${failed.join(', ')}`);
    console.error('   这些插件的模块未就位，请勿在 cordis.patch.yml 里引用它们，否则 DSH 会启动失败。');
    console.error('   修复后重跑本脚本即可。');
  }

  console.log(`\n已完成：共安装 ${installed} 个文件。`);
  console.log(`目标宿主：${destRoot}`);
  console.log('提示：修改后若 HMR 未生效，请重启 DSH（或确认 cordis.patch.yml 已引用插件）。');
  if (failed.length > 0) process.exit(1);
}

/**
 * 对插件目录跑「加载期自检」：找到 *.mjs 入口，用 stub ctx 真实执行 apply()，
 * 并用 DSH 真实 schema 校验器验证所有工具 output.schema。
 * 复用 scripts/check-plugin.mjs 的检查内核（独立子进程，避免污染本脚本状态）。
 * @param {string} pluginDir - 插件源码目录或宿主安装目录。
 * @returns {boolean|null} true=通过；false=失败；null=目录里没有 *.mjs 入口（跳过自检）
 */
function runPluginCheck(pluginDir) {
  const checkScript = join(REPO_ROOT, 'scripts', 'check-plugin.mjs');
  if (!existsSync(checkScript)) return null;

  // 找插件目录下的 .mjs 入口文件（顶层；不深入 skills/ 等子目录）
  const rootFiles = readdirSync(pluginDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => e.name)
    // 排除测试/工具类命名
    .filter((n) => !/^\./.test(n) && !/test|spec|fixture/i.test(n));

  if (rootFiles.length === 0) {
    // 没有顶层 .mjs（例如纯 skill/资源包）——跳过自检
    return null;
  }

  let allPass = true;
  for (const file of rootFiles) {
    const entryPath = join(pluginDir, file);
    const result = spawnSync(
      process.execPath,
      [checkScript, entryPath],
      { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) allPass = false;
  }
  return allPass;
}

main();
