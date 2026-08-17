/**
 * index.js
 *
 * 钉钉 ↔ DeepSeek Harness 桥接器入口。
 *
 * 启动流程：
 *   1. 加载并校验配置
 *   2. 创建 DSHClient 并启动事件流（WS）
 *   3. 创建 DingTalkClient 连接 Stream 网关
 *   4. 创建 SessionMapper 恢复历史映射
 *   5. 启动 Bridge 双向转发
 *   6. 注册优雅关闭
 */

import { getConfig, validateConfig } from './config.js';
import { DSHClient } from './dsh-client.js';
import { DingTalkClient } from './dingtalk-client.js';
import { SessionMapper } from './sessions.js';
import { Bridge } from './bridge.js';

function stamp() {
  return new Date().toISOString();
}

function makeLog(tag) {
  return (line) => console.log(`[${stamp()} ${tag}] ${line}`);
}

async function main() {
  const cfg = getConfig();
  const log = makeLog('main');

  const missing = validateConfig(cfg);
  if (missing.length > 0) {
    console.error('==============================================');
    console.error('配置缺失，无法启动：');
    for (const m of missing) console.error(`  - 缺少 ${m}`);
    console.error('请先参照 .env.example / config/config.example.json 填写配置，');
    console.error('并在钉钉开放平台创建企业内部应用（详见 docs/DEPLOYMENT.md）。');
    console.error('==============================================');
    process.exit(1);
  }

  log(`DSH base: ${cfg.dsh.baseUrl}`);

  const dsh = new DSHClient({ baseUrl: cfg.dsh.baseUrl, log: makeLog('dsh') });
  const dingtalk = new DingTalkClient({
    appKey: cfg.dingtalk.appKey,
    appSecret: cfg.dingtalk.appSecret,
    log: makeLog('dingtalk'),
  });
  const mapper = new SessionMapper({ file: cfg.mapping.file, log: makeLog('mapping') });

  const bridge = new Bridge({ dsh, dingtalk, mapper, config: cfg, log: makeLog('bridge') });
  bridge.start();

  // 事件流（自动重连）；在 main 结束时需要 stop
  dsh.startEventStream();

  // 钉钉 Stream 连接
  if (cfg.dingtalk.streamEnabled) {
    dingtalk.connect();
  } else {
    log('Stream 已禁用（DINGTALK_STREAM_ENABLED=false），仅连接 DSH 侧。');
  }

  dsh.on('stream/online', () => log('DSH 事件流已连接'));
  dsh.on('stream/offline', () => log('DSH 事件流已断开，等待重连…'));
  dingtalk.onEvent('close', () => log('钉钉 Stream 连接关闭'));

  // 启动信息
  log('桥接器已启动。等待钉钉消息…');
  log('提示：DSH 会话引用即当前运行中的 Agent 会话。');

  // 优雅关闭
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭…`);
    try {
      bridge.stop();
      dsh.stopEventStream();
      dingtalk.disconnect();
    } finally {
      log('已关闭。');
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
