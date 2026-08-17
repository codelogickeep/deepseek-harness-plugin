/**
 * config.js
 *
 * 配置加载：环境变量优先，其次 config/config.json，最后默认值。
 * 支持 .env 文件（如果安装了 dotenv）——为了零依赖，这里内置一个极简解析器。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

/** 极简 .env 解析（只处理 KEY=VALUE 行，忽略注释与引号）。 */
function loadDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** 加载 config/config.json（若有）。 */
function loadJsonConfig() {
  const file = join(PROJECT_ROOT, 'config', 'config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[config] 解析 config/config.json 失败: ${err.message}`);
    return {};
  }
}

const env = { ...process.env, ...loadDotEnv(join(PROJECT_ROOT, '.env')) };
const file = loadJsonConfig();

function pick(envKey, filePath, fallback) {
  if (env[envKey] !== undefined && env[envKey] !== '') return env[envKey];
  const cursor = filePath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), file);
  if (cursor !== undefined && cursor !== null && cursor !== '') return cursor;
  return fallback;
}

export function getConfig() {
  return {
    /** DSH Web 地址 */
    dsh: {
      baseUrl: pick('DSH_BASE_URL', 'dsh.baseUrl', 'http://127.0.0.1:3080'),
    },
    dingtalk: {
      /** 企业内部应用 AppKey（也用于 clientId） */
      appKey: pick('DINGTALK_APP_KEY', 'dingtalk.appKey', ''),
      /** 应用 AppSecret（Stream 模式下仅用于换取 access_token 发消息，可选） */
      appSecret: pick('DINGTALK_APP_SECRET', 'dingtalk.appSecret', ''),
      /** 机器人编码（发消息到单聊时通常与 AppKey 相同） */
      robotCode: pick('DINGTALK_ROBOT_CODE', 'dingtalk.robotCode', ''),
      /** 是否启用 Stream 模式（默认 true；false 时为未来 HTTP 回调预留） */
      streamEnabled: (pick('DINGTALK_STREAM_ENABLED', 'dingtalk.streamEnabled', 'true') === 'true'),
    },
    mapping: {
      /** 会话映射存储文件（JSONL） */
      file: pick('MAPPING_FILE', 'mapping.file', join(PROJECT_ROOT, 'data', 'session-mapping.json')),
      /** 是否把每个钉钉会话映射到独立 DSH 会话 */
      perConversation: (pick('MAPPING_PER_CONVERSATION', 'mapping.perConversation', 'true') === 'true'),
      /** 映射模式：independent（默认，每钉钉会话独立）| auto-follow（无映射时跟随运行中最新会话） */
      mode: pick('MAPPING_MODE', 'mapping.mode', 'independent'),
      /** 单一固定 DSH 会话 id（perConversation=false 时使用；留空则自动创建） */
      fixedSessionId: pick('MAPPING_FIXED_SESSION_ID', 'mapping.fixedSessionId', ''),
      /** 映射创建会话时使用的 cwd */
      sessionCwd: pick('MAPPING_SESSION_CWD', 'mapping.sessionCwd', PROJECT_ROOT),
      /** 映射创建会话时使用的 agent preset */
      agentPreset: pick('MAPPING_AGENT_PRESET', 'mapping.agentPreset', 'code'),
    },
    bridge: {
      /** 回复拼接时允许的空行数量上限（压缩合并） */
      maxBlankLines: 2,
      /** 是否在回复头部附带"[DSH]"前缀 */
      replyPrefix: pick('REPLY_PREFIX', 'bridge.replyPrefix', ''),
    },
    log: {
      level: pick('LOG_LEVEL', 'log.level', 'info'),
    },
  };
}

/** 校验核心配置，返回缺失项列表。 */
export function validateConfig(cfg) {
  const missing = [];
  if (!cfg.dingtalk.appKey) missing.push('dingtalk.appKey (DINGTALK_APP_KEY)');
  if (!cfg.dingtalk.appSecret) missing.push('dingtalk.appSecret (DINGTALK_APP_SECRET)');
  if (!cfg.dingtalk.robotCode) missing.push('dingtalk.robotCode (DINGTALK_ROBOT_CODE)');
  return missing;
}
