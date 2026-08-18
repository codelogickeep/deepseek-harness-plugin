#!/usr/bin/env node
/**
 * install-flash-preset.mjs — 「pro 指挥、flash 执行」agent preset 安装脚手架
 *
 * 把本仓库 `presets/flash-worker/` 的 preset 模板渲染（注入用户自己的 flash
 * provider/model）后，安装到 DSH 的用户 preset 根目录
 * （默认 `~/.dsh/.agent-presets/flash-worker/`）。
 *
 * DSH 的 preset 发现不做缓存：安装完成后进程运行期间立即可见；切换
 * `agent-presets.default` 后，新建的会话即默认走该 preset（视 settings
 * 重读时机，必要时重启 DSH）。
 *
 * provider / model 的来源（优先级从高到低）：
 *   1. 命令行：--provider <id> --model <id>
 *   2. 环境变量：FLASH_PROVIDER / FLASH_MODEL
 *   3. 交互式询问（TTY 下；非 TTY 且未提供时直接报错）
 *
 * 用法：
 *   npm run install:flash-worker -- --provider deepseek-official --model deepseek-v4-flash
 *   FLASH_PROVIDER=deepseek-official FLASH_MODEL=deepseek-v4-flash npm run install:flash-worker
 *   npm run install:flash-worker            # 交互式
 *   npm run install:flash-worker -- --set-default   # 同时把默认 preset 切到 flash-worker
 *
 * 一键式（插件 + preset）见 scripts/setup.mjs。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PRESET_ID = 'flash-worker';
const TPL_DIR = join(REPO_ROOT, 'presets', PRESET_ID);
const TPL_FILE = join(TPL_DIR, 'agent.cordis.yml.tpl');
const PRESET_YML = join(TPL_DIR, 'preset.yml');
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh');
const SETTINGS_FILE = process.env.DSH_SETTINGS || join(DSH_HOME, 'settings.yaml');

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { provider: undefined, model: undefined, setDefault: false, show: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider' || a === '-p') args.provider = argv[++i];
    else if (a.startsWith('--provider=')) args.provider = a.slice('--provider='.length);
    else if (a === '--model' || a === '-m') args.model = argv[++i];
    else if (a.startsWith('--model=')) args.model = a.slice('--model='.length);
    else if (a === '--set-default') args.setDefault = true;
    else if (a === '--show') args.show = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function helpText() {
  return [
    '用法: node scripts/install-flash-preset.mjs [选项]',
    '',
    '把 presets/flash-worker 模板渲染并安装到 DSH 用户 preset 根目录。',
    '',
    '选项:',
    '  -p, --provider <id>   flash 模型的 provider 路由 id（如 deepseek-official）',
    '  -m, --model <id>      flash 模型的 model id（如 deepseek-v4-flash）',
    '      --set-default     同时把 settings.yaml 的 agent-presets.default 切到 flash-worker',
    '      --show            只打印当前已安装的 provider/model（不重装）',
    '  -h, --help            显示本帮助',
    '',
    'provider/model 未通过选项/环境变量提供时，交互式询问。',
  ].join('\n');
}

/** 校验 provider/model id：非空、无空白、无引号（避免破坏 YAML）。 */
function assertId(value, label) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${label} 不能为空`);
  }
  if (/\s|"|'|\\/.test(value)) {
    throw new Error(`${label} 含非法字符（空白/引号/反斜杠）：${value}`);
  }
  return value.trim();
}

/** 交互式询问一个必填值。 */
async function askValue(rl, question) {
  const answer = (await rl.question(question)).trim();
  return answer;
}

/** 解析最终的 provider/model（CLI > env > 交互式）。 */
async function resolveProviderModel(args, isTTY) {
  let provider = args.provider ?? process.env.FLASH_PROVIDER;
  let model = args.model ?? process.env.FLASH_MODEL;

  if ((!provider || !model) && !isTTY) {
    throw new Error(
      '缺少 provider/model：非交互环境下请用 --provider/--model 或 FLASH_PROVIDER/FLASH_MODEL 提供',
    );
  }

  if (!provider || !model) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      if (!provider) {
        provider = await askValue(
          rl,
          'flash 模型的 provider 路由 id（llm 服务的 provider，例如 deepseek-official）：',
        );
      }
      if (!model) {
        model = await askValue(rl, 'flash 模型的 model id（例如 deepseek-v4-flash）：');
      }
    } finally {
      rl.close();
    }
  }

  return { provider: assertId(provider, 'provider'), model: assertId(model, 'model') };
}

/** 渲染模板：替换 {{FLASH_PROVIDER}} / {{FLASH_MODEL}} 占位符。 */
function renderTemplate(provider, model) {
  const tpl = readFileSync(TPL_FILE, 'utf8');
  const rendered = tpl
    .replaceAll('{{FLASH_PROVIDER}}', provider)
    .replaceAll('{{FLASH_MODEL}}', model);
  if (rendered.includes('{{FLASH_PROVIDER}}') || rendered.includes('{{FLASH_MODEL}}')) {
    throw new Error('模板渲染后仍残留占位符，请检查 presets/flash-worker/agent.cordis.yml.tpl');
  }
  return rendered;
}

/** 安装 preset（幂等：先清目标目录，再整目录复制）。 */
function installPreset(provider, model) {
  const destDir = join(DSH_HOME, '.agent-presets', PRESET_ID);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  writeFileSync(join(destDir, 'agent.cordis.yml'), renderTemplate(provider, model), 'utf8');
  cpSync(PRESET_YML, join(destDir, 'preset.yml'), { force: true });

  return destDir;
}

/** 简单检查 settings.yaml 里是否已出现该 provider 路由（启发式，非权威）。 */
function checkProviderInSettings(provider) {
  if (!existsSync(SETTINGS_FILE)) return { found: false, reason: 'settings.yaml 不存在' };
  const text = readFileSync(SETTINGS_FILE, 'utf8');
  return {
    found: text.includes(provider),
    reason: text.includes(provider) ? undefined : `settings.yaml 中未找到 provider "${provider}"`,
  };
}

/** 把 settings.yaml 的 agent-presets.default 切到 flash-worker。 */
function setDefaultPreset() {
  if (!existsSync(SETTINGS_FILE)) {
    throw new Error(`settings.yaml 不存在（${SETTINGS_FILE}），无法切换默认 preset`);
  }
  const text = readFileSync(SETTINGS_FILE, 'utf8');
  if (!/^agent-presets:\s*$/m.test(text)) {
    throw new Error('settings.yaml 中没有 agent-presets 段，请手动添加后重试');
  }
  const next = text.replace(
    /^(agent-presets:\s*\n)(\s+default:\s*[^\n]*\n)?/m,
    (_m, head) => `${head}  default: ${PRESET_ID}\n`,
  );
  writeFileSync(SETTINGS_FILE, next, 'utf8');
  return SETTINGS_FILE;
}

/** 打印当前已安装的 provider/model 与默认 preset 状态（只读，不重装）。 */
function showInstalled() {
  const file = join(DSH_HOME, '.agent-presets', PRESET_ID, 'agent.cordis.yml');
  if (!existsSync(file)) {
    console.log(`ℹ️  [${PRESET_ID}] 尚未安装（${file} 不存在）。`);
    console.log('   安装：npm run install:flash-worker -- --provider <p> --model <m>');
    return;
  }

  const text = readFileSync(file, 'utf8');
  // agentOptions 下的值带双引号；config 的 provider: spawn 无引号，故带引号正则只命中 agentOptions。
  const provider = text.match(/^\s*provider:\s*"([^"]+)"\s*$/m)?.[1];
  const model = text.match(/^\s*model:\s*"([^"]+)"\s*$/m)?.[1];

  console.log(`[${PRESET_ID}] 已安装：`);
  console.log(`  provider: ${provider ?? '(解析失败)'}`);
  console.log(`  model:    ${model ?? '(解析失败)'}`);
  console.log(`  文件:     ${file}`);

  if (existsSync(SETTINGS_FILE)) {
    const settings = readFileSync(SETTINGS_FILE, 'utf8');
    const def = settings.match(/^\s*default:\s*(\S+)\s*$/m)?.[1];
    const isDefault = def === PRESET_ID;
    console.log(`  默认 preset: ${def ?? '(未设置)'}${isDefault ? '（✅ 指向本 preset）' : '（未指向本 preset，用 --set-default 切换）'}`);
  } else {
    console.log('  默认 preset: settings.yaml 不存在');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    process.exit(0);
  }
  if (args.show) {
    showInstalled();
    process.exit(0);
  }

  const isTTY = Boolean(process.stdin.isTTY);
  const { provider, model } = await resolveProviderModel(args, isTTY);

  if (!existsSync(TPL_FILE)) {
    console.error(`✗ 模板不存在：${TPL_FILE}`);
    process.exit(1);
  }

  const destDir = installPreset(provider, model);
  console.log(`✅ 已安装 preset [${PRESET_ID}] → ${destDir}/`);
  console.log(`   agentOptions: provider=${provider} model=${model}`);

  const check = checkProviderInSettings(provider);
  if (check.found) {
    console.log(`✅ 已在 settings.yaml 文本中找到 provider "${provider}"。`);
  } else {
    console.log(`\nℹ️  ${check.reason}（启发式检查，不代表未注册）。`);
    console.log('   provider 路由由 DSH 的 llm 适配器注册，可能写在宿主 cordis 配置或 llm-* 设置段里；');
    console.log('   请确认该 provider 已注册，否则 flash_agent 委派的子 agent 会因找不到模型路由而失败。');
  }

  if (args.setDefault) {
    try {
      const file = setDefaultPreset();
      console.log(`✅ 默认 preset 已切换为 [${PRESET_ID}]（${file}）。`);
    } catch (err) {
      console.error(`✗ 切换默认 preset 失败：${err.message}`);
    }
  } else {
    console.log('\n提示：如要把新会话默认设为该 preset，请加 --set-default，');
    console.log('或在 DSH 界面的 preset 选择器里手动选择 "Flash 执行"。');
  }

  console.log(`\npreset 安装完成。新 preset 在 DSH 运行时立即可见；`);
  console.log('若切换默认后未生效，请重启 DSH 再新建会话。');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
