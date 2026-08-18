/**
 * bridge.e2e.test.js
 *
 * 桥接核心端到端测试（不需要真实钉钉）：
 *  - 用 MockDingTalk 模拟钉钉 Stream 客户端收发消息
 *  - 用真实 DSH（若在线）验证：钉钉消息 → DSH 会话 → assistant 回复 → 钉钉 webhook 收到
 *
 * 运行：npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DSHClient } from '../src/dsh-client.js';
import { SessionMapper } from '../src/sessions.js';
import { Bridge } from '../src/bridge.js';
import { looksLikeMarkdown, activePushTitle } from '../src/dingtalk-client.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.DSH_TEST_BASE_URL || 'http://127.0.0.1:3080';

async function dshOnline() {
  try {
    const r = await fetch(`${BASE}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session.list', payload: {} }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// 模拟钉钉客户端：connect 时不真正连，提供 emit 注入和 reply 捕获
class MockDingTalk extends EventEmitter {
  constructor() { super(); this.replies = []; this.onEvent = (n, fn) => this.on(n, fn); }
  connect() { return this; }
  disconnect() {}
  async reply(msg, text) {
    this.replies.push({ conversationId: msg.conversationId, text });
    return { ok: true };
  }
  // 注入一条机器人消息
  inject(msg) { this.emit('message', msg); }
  lastReply(conversationId) {
    return [...this.replies].reverse().find((r) => r.conversationId === conversationId);
  }
}

const online = await dshOnline();

function mkConfig() {
  return {
    mapping: { perConversation: true, sessionCwd: '/tmp', agentPreset: 'code' },
    bridge: { replyPrefix: '', maxBlankLines: 2 },
  };
}

function mkMsg(conversationId, text, extra = {}) {
  return {
    conversationId,
    conversationType: '1',
    msgtype: 'text',
    text: { content: text },
    senderId: 'u-1',
    senderNick: '测试用户',
    sessionWebhook: 'http://fake',
    robotCode: 'rc',
    ...extra,
  };
}

test('桥接端到端：钉钉消息→DSH→回复→钉钉', { skip: !online, timeout: 120000 }, async () => {
  const dsh = new DSHClient({ baseUrl: BASE, log: () => {} });
  const ding = new MockDingTalk();
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-'));
  const mapper = new SessionMapper({ file: join(tmpdirName, 'map.json'), log: () => {} });
  const bridge = new Bridge({ dsh, dingtalk: ding, mapper, config: mkConfig(), log: () => {} });
  bridge.start();
  const stopStream = dsh.startEventStream();

  const conversationId = `cid-e2e-${Date.now()}`;
  const userText = '只回复两个字：收到';

  const replyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待钉钉回复超时')), 90000);
    const check = setInterval(() => {
      const hit = ding.replies.find((r) => r.conversationId === conversationId);
      if (hit) { clearInterval(check); clearTimeout(timer); resolve(hit.text); }
    }, 200);
  });

  ding.inject(mkMsg(conversationId, userText));

  const reply = await replyPromise;
  assert.ok(reply.includes('收到'), `回复应包含"收到"，实际: ${JSON.stringify(reply)}`);
  assert.ok(mapper.has(conversationId), '映射应建立');

  bridge.stop();
  stopStream();
  rmSync(tmpdirName, { recursive: true, force: true });
});

test('会话映射持久化恢复（新格式）', () => {
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-map-'));
  const file = join(tmpdirName, 'map.json');
  const m1 = new SessionMapper({ file, log: () => {} });
  m1.setActive('cid-1', 'session-x');
  m1.setActive('cid-1', 'session-y'); // 切到 y，历史保留 x
  const m2 = new SessionMapper({ file, log: () => {} });
  assert.equal(m2.getActive('cid-1'), 'session-y');
  assert.deepEqual(m2.listSessions('cid-1').sort(), ['session-x', 'session-y']);
  rmSync(tmpdirName, { recursive: true, force: true });
});

test('会话映射旧格式迁移', () => {
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-map-'));
  const file = join(tmpdirName, 'map.json');
  // 手写旧格式
  writeFileSync(file, JSON.stringify({ 'cid-old': { dshSessionId: 'session-old', createdAt: 123 } }), 'utf8');
  const m = new SessionMapper({ file, log: () => {} });
  assert.equal(m.getActive('cid-old'), 'session-old');
  assert.ok(m.listSessions('cid-old').includes('session-old'));
  rmSync(tmpdirName, { recursive: true, force: true });
});

test('/use 切换后保留历史（可续聊）', () => {
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-use-'));
  const file = join(tmpdirName, 'map.json');
  const mapper = new SessionMapper({ file, log: () => {} });
  mapper.setActive('cid', 'session-a');
  mapper.setActive('cid', 'session-b'); // 切到 b
  mapper.setActive('cid', 'session-a'); // 切回 a
  assert.equal(mapper.getActive('cid'), 'session-a', '切回后 active 应为 a');
  assert.deepEqual(mapper.listSessions('cid').sort(), ['session-a', 'session-b'], '历史应保留两个');
  rmSync(tmpdirName, { recursive: true, force: true });
});

test('指令路由：/status /list /use /new /sched 被识别', () => {
  const ding = new MockDingTalk();
  const mapper = new SessionMapper({ file: join(tmpdir(), `map-${Date.now()}.json`), log: () => {} });
  const bridge = new Bridge({ dingtalk: ding, mapper, config: mkConfig(), log: () => {} });
  // 不真正执行（不连 DSH），只验证路由逻辑可达：
  // status/list/use/new/help/sched 都以 / 开头且不是普通消息
  assert.equal(/^\/(status|状态)/.test('/status'), true);
  assert.equal(/^\/(list|列表)\b/.test('/list'), true);
  assert.equal(/^\/(use|切换|switch)\b/.test('/use'), true);
  assert.equal(/^\/(new|reset|clear)\b/.test('/new'), true);
  assert.equal(/^\/(sched|定时|schedule)\b/.test('/sched'), true);
  assert.equal(/^\/(sched|定时|schedule)\b/.test('/sched list'), true);
  assert.equal(/^\/(sched|定时|schedule)\b/.test('/sched cancel schedule-x'), true);
  assert.equal(/^\/(status)/.test('status'), false, '无 / 前缀不是指令');
  rmSync(mapper.file, { force: true });
});

test('_collapseBlankLines 压缩空行', () => {
  const bridge = new Bridge({ config: mkConfig(), log: () => {} });
  const out = bridge._collapseBlankLines('a\n\n\n\n\nb');
  assert.equal(out, 'a\n\n\nb');
});

test('looksLikeMarkdown 判断钉钉 markdown 渲染', () => {
  assert.equal(looksLikeMarkdown('**加粗** 文本'), true, '**bold** 应识别');
  assert.equal(looksLikeMarkdown('- 列表项'), true, '列表应识别');
  assert.equal(looksLikeMarkdown('`code` 片段'), true, '行内代码应识别');
  assert.equal(looksLikeMarkdown('# 标题'), true, '标题应识别');
  assert.equal(looksLikeMarkdown('[链接](http://a.b)'), true, '链接应识别');
  assert.equal(looksLikeMarkdown('纯文本消息没有md'), false, '纯文本不应识别');
  assert.equal(looksLikeMarkdown(''), false, '空串不应识别');
  assert.equal(looksLikeMarkdown('文本带一个 * 星号'), false, '单个星号不是 md');
});

test('activePushTitle 生成钉钉 markdown 必填 title', () => {
  assert.equal(activePushTitle('**加粗** 标题行\n第二行'), '加粗 标题行', '应取首行并去除 md 符号');
  assert.equal(activePushTitle('📋 **当前定时任务**\n表格...'), '📋 当前定时任务', '应保留 emoji 去加粗');
  assert.equal(activePushTitle('  纯文本首位\n正文'), '纯文本首位', '应 trim');
  assert.equal(activePushTitle('\n\n   '), '消息', '全空时给默认');
  const long = activePushTitle('A'.repeat(100));
  assert.equal(long.length, 40, '应截断到 40 字符');
  assert.ok(activePushTitle(''), '空输入不抛错');
});

test('群聊 @ 过滤逻辑', () => {
  const bridge = new Bridge({ config: mkConfig(), log: () => {} });
  assert.equal(bridge._shouldIgnore({ conversationType: '1', msgtype: 'text', text: { content: '你好' } }), false);
  assert.equal(bridge._shouldIgnore({ conversationType: '2', msgtype: 'text', text: { content: '@我的机器人 你好' }, robotCode: 'rc-bot' }), false);
  assert.equal(bridge._shouldIgnore({ conversationType: '2', msgtype: 'text', text: { content: '@ 你好' }, robotCode: 'rc-bot' }), false);
  assert.equal(bridge._shouldIgnore({ conversationType: '2', msgtype: 'text', text: { content: '你好@rc-bot 请回答' }, robotCode: 'rc-bot' }), false);
  assert.equal(bridge._shouldIgnore({ conversationType: '2', msgtype: 'text', text: { content: '今天天气' }, robotCode: 'rc-bot' }), true);
  assert.equal(bridge._extractText({ msgtype: 'text', text: { content: '@我的机器人 你好' } }), '你好');
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('主动推送：DSH 无回复目标的 assistant 消息 → 钉钉（持久 webhook）', async () => {
  const ding = new MockDingTalk();
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-push-'));
  const mapper = new SessionMapper({ file: join(tmpdirName, 'map.json'), log: () => {} });
  const bridge = new Bridge({ dingtalk: ding, mapper, config: mkConfig(), log: () => {} });
  bridge._sentSeq = new Map(); // 独立去重（sessionId -> Set<seq>），避免跨测试干扰

  // 1. 先有钉钉会话（持久 webhook + active 投递目标为该 DSH 会话）
  const convId = `cid-push-${Date.now()}`;
  const webhookVal = `http://fake-webhook/${convId}`;
  mapper.setWebhook(convId, webhookVal);
  mapper.setActive(convId, 'session-push-target');

  // 2. 模拟定时提醒注入（user/message：data.content + source.plugin=schedule → 打开提醒窗口）
  bridge._handleSessionEvent({
    sessionId: 'session-push-target',
    event: {
      type: 'user/message',
      seq: 99000,
      data: {
        content: [{ type: 'text', text: '[SCHEDULE REMINDER]\n提醒内容' }],
        source: { kind: 'plugin', plugin: 'schedule' },
        role: 'user',
      },
    },
  });

  // 3. 来自 DSH 的 assistant/message（无 replyTarget —— 提醒触发后的回复）
  const ev = {
    sessionId: 'session-push-target',
    event: {
      type: 'assistant/message',
      seq: 99001,
      data: { message: { content: [{ type: 'text', text: '⏰ 这是定时提醒内容' }] } },
    },
  };
  bridge._handleSessionEvent(ev);
  // turn/end = 回复完成，立即推送
  bridge._handleSessionEvent({ sessionId: 'session-push-target', event: { type: 'turn/end', seq: 99002 } });

  // 4. 等异步回发（.finally 日志）+ webhook 断言
  await wait(50);
  assert.ok(mapper.getWebhook(convId) === webhookVal, 'webhook 应已持久化');
  const hit = ding.replies.find((r) => r.conversationId === convId);
  assert.ok(hit, '应主动推送到钉钉');
  assert.ok(hit.text.includes('定时提醒内容'), `内容应含提醒文本；实际: ${JSON.stringify(hit)}`);
  assert.ok(!hit.text.includes('Agent 主动消息') && !hit.text.includes('来自 Agent'), `推送不应带额外前缀（纯内容）；实际: ${JSON.stringify(hit)}`);

  bridge.stop();
  rmSync(tmpdirName, { recursive: true, force: true });
});

test('主动推送：非定时提醒的 agent 自发言不推', async () => {
  const ding = new MockDingTalk();
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-push-non-'));
  const mapper = new SessionMapper({ file: join(tmpdirName, 'map.json'), log: () => {} });
  const bridge = new Bridge({ dingtalk: ding, mapper, config: mkConfig(), log: () => {} });
  bridge._sentSeq = new Map();

  const convId = `cid-pushnon-${Date.now()}`;
  mapper.setWebhook(convId, `http://fake/${convId}`);
  mapper.setActive(convId, 'session-normal');

  // 无 [SCHEDULE REMINDER] 注入，普通 agent 自发言（assistant/message + turn/end）
  bridge._handleSessionEvent({
    sessionId: 'session-normal',
    event: { type: 'assistant/message', seq: 99020, data: { message: { content: [{ type: 'text', text: '我自言自语的一句话' }] } } },
  });
  bridge._handleSessionEvent({ sessionId: 'session-normal', event: { type: 'turn/end', seq: 99021 } });

  await wait(50);
  const hit = ding.replies.find((r) => r.conversationId === convId);
  assert.ok(!hit, '非定时提醒的 agent 自发言不应推送');
  bridge.stop();
  rmSync(tmpdirName, { recursive: true, force: true });
});

test('主动推送：enableActivePush=false 时跳过', async () => {
  const ding = new MockDingTalk();
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-push-off-'));
  const mapper = new SessionMapper({ file: join(tmpdirName, 'map.json'), log: () => {} });
  const cfg = mkConfig();
  cfg.bridge.enableActivePush = false;
  const bridge = new Bridge({ dingtalk: ding, mapper, config: cfg, log: () => {} });
  bridge._sentSeq = new Map();

  const convId = `cid-pushoff-${Date.now()}`;
  mapper.setWebhook(convId, `http://fake/${convId}`);
  mapper.setActive(convId, 'session-push-off');

  const ev = {
    sessionId: 'session-push-off',
    event: { type: 'assistant/message', seq: 99002, data: { message: { content: [{ type: 'text', text: '不应推送' }] } } },
  };
  bridge._handleSessionEvent(ev);
  bridge._handleSessionEvent({ sessionId: 'session-push-off', event: { type: 'turn/end', seq: 99003 } });

  await wait(50);
  const hit = ding.replies.find((r) => r.conversationId === convId);
  assert.ok(!hit, '禁用后不应推送');
  bridge.stop();
  rmSync(tmpdirName, { recursive: true, force: true });
});

test('主动推送：历史使用过该会话（非 active）也兜底推送', async () => {
  const ding = new MockDingTalk();
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-push-hist-'));
  const mapper = new SessionMapper({ file: join(tmpdirName, 'map.json'), log: () => {} });
  const bridge = new Bridge({ dingtalk: ding, mapper, config: mkConfig(), log: () => {} });
  bridge._sentSeq = new Map();

  const convId = `cid-pushhist-${Date.now()}`;
  mapper.setWebhook(convId, `http://fake/${convId}`);
  // active 指向 A 会话，但历史里包含 B 会话
  mapper.setActive(convId, 'session-active-a');
  const ctx = mapper.getContext(convId);
  ctx.sessions['session-historical-b'] = { lastUsedAt: Date.now() };
  mapper.setActive(convId, 'session-active-a'); // 重写（保持 sessions 含 B）

  // 定时提醒注入（开窗；这里无 [SCHEDULE REMINDER] 文本，仅靠 source.plugin=schedule 识别）
  bridge._handleSessionEvent({
    sessionId: 'session-historical-b',
    event: { type: 'user/message', seq: 99002, data: { content: [{ type: 'text', text: '新格式提醒' }], source: { kind: 'plugin', plugin: 'schedule' }, role: 'user' } },
  });
  // B 会话产生主动消息（非 active，但历史匹配）
  const ev = {
    sessionId: 'session-historical-b',
    event: { type: 'assistant/message', seq: 99003, data: { message: { content: [{ type: 'text', text: '历史会话的主动消息' }] } } },
  };
  bridge._handleSessionEvent(ev);
  bridge._handleSessionEvent({ sessionId: 'session-historical-b', event: { type: 'turn/end', seq: 99004 } });

  await wait(50);
  const hit = ding.replies.find((r) => r.conversationId === convId);
  assert.ok(hit, '历史使用过的会话也应兜底推送');
  assert.ok(hit.text.includes('历史会话的主动消息'), `内容应匹配；实际: ${JSON.stringify(hit)}`);
  bridge.stop();
  rmSync(tmpdirName, { recursive: true, force: true });
});

test('主动推送：只推最终结果（中间输出不推）', async () => {
  const ding = new MockDingTalk();
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-push-final-'));
  const mapper = new SessionMapper({ file: join(tmpdirName, 'map.json'), log: () => {} });
  const bridge = new Bridge({ dingtalk: ding, mapper, config: mkConfig(), log: () => {} });
  bridge._sentSeq = new Map();

  const convId = `cid-pushfinal-${Date.now()}`;
  mapper.setWebhook(convId, `http://fake/${convId}`);
  mapper.setActive(convId, 'session-final');

  // 定时提醒注入（开窗）
  bridge._handleSessionEvent({
    sessionId: 'session-final',
    event: { type: 'user/message', seq: 99009, data: { content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nreminder' }], source: { plugin: 'schedule' } } },
  });

  // 模拟一轮：中间输出(assistant/message) → tool/call → tool/result → 最终输出(assistant/message) → turn/end
  bridge._handleSessionEvent({
    sessionId: 'session-final',
    event: { type: 'assistant/message', seq: 99010, data: { message: { content: [{ type: 'text', text: '第一步：我想想' }] } } },
  });
  bridge._handleSessionEvent({ sessionId: 'session-final', event: { type: 'tool/call', seq: 99011, data: {} } });
  bridge._handleSessionEvent({ sessionId: 'session-final', event: { type: 'tool/result', seq: 99012, data: {} } });
  bridge._handleSessionEvent({ sessionId: 'session-final', event: { type: 'step/end', seq: 99013 } });
  bridge._handleSessionEvent({
    sessionId: 'session-final',
    event: { type: 'assistant/message', seq: 99014, data: { message: { content: [{ type: 'text', text: '最终结果：完成了' }] } } },
  });
  bridge._handleSessionEvent({ sessionId: 'session-final', event: { type: 'turn/end', seq: 99015 } });

  await wait(50);

  const hits = ding.replies.filter((r) => r.conversationId === convId);
  assert.equal(hits.length, 1, `应只推送 1 条最终结果；实际 ${hits.length} 条: ${JSON.stringify(hits)}`);
  assert.ok(hits[0].text.includes('最终结果'), `应推送最终结果；实际: ${JSON.stringify(hits[0])}`);
  assert.ok(!hits[0].text.includes('第一步'), '不应推送中间输出');
  bridge.stop();
  rmSync(tmpdirName, { recursive: true, force: true });
});
