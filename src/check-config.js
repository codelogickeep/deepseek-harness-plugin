/**
 * check-config.js
 *
 * 校验配置是否完整（无需启动完整桥接器）。
 * 用法：npm run check:config
 */

import { getConfig, validateConfig } from './config.js';

const cfg = getConfig();
const missing = validateConfig(cfg);

console.log('当前配置：');
console.log(`  DSH baseUrl     : ${cfg.dsh.baseUrl}`);
console.log(`  钉钉 AppKey     : ${cfg.dingtalk.appKey ? '***已设置***' : '(空)'}`);
console.log(`  钉钉 AppSecret  : ${cfg.dingtalk.appSecret ? '***已设置***' : '(空)'}`);
console.log(`  钉钉 robotCode  : ${cfg.dingtalk.robotCode ? '***已设置***' : '(空)'}`);
console.log(`  Stream 模式     : ${cfg.dingtalk.streamEnabled ? '启用' : '禁用'}`);
console.log(`  会话映射文件    : ${cfg.mapping.file}`);
console.log(`  映射策略        : ${cfg.mapping.perConversation ? '每会话独立 DSH 会话' : `固定会话(${cfg.mapping.fixedSessionId || '(自动创建)'})`}`);
console.log('');
if (missing.length > 0) {
  console.error('❌ 配置不完整，缺少：');
  for (const m of missing) console.error(`   - ${m}`);
  process.exit(1);
} else {
  console.log('✅ 配置完整，可以直接启动。');
  process.exit(0);
}
