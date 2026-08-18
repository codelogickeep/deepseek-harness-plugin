#!/usr/bin/env node
/**
 * setup.mjs — 一键式安装脚手架
 *
 * 依次执行：
 *   1. install-plugins.mjs      安装 DSH 宿主插件（plugins/ → 宿主 profile）
 *   2. install-flash-preset.mjs 安装 flash-worker preset（presets/ → 用户 preset 根）
 *
 * 全部命令行参数透传给 install-flash-preset.mjs，例如：
 *   npm run setup -- --provider deepseek-official --model deepseek-v4-flash --set-default
 *
 * 等价于分开执行：
 *   npm run install:plugins
 *   npm run install:flash-worker -- --provider <p> --model <m> [--set-default]
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname);

/** 同步跑一个子脚本，继承 stdio 以透传交互。 */
function run(script, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(SCRIPTS, script), ...args], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${script} 退出码 ${code}`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  console.log('== 步骤 1/2：安装 DSH 宿主插件 ==');
  await run('install-plugins.mjs', []);

  console.log('\n== 步骤 2/2：安装 flash-worker preset ==');
  await run('install-flash-preset.mjs', args);

  console.log('\n✅ 全部安装完成。');
  console.log('提示：若切换了默认 preset，请重启 DSH 后新建会话验证 flash_agent 工具。');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
