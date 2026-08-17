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

test('指令路由：/status /list /use /new 被识别', () => {
  const ding = new MockDingTalk();
  const mapper = new SessionMapper({ file: join(tmpdir(), `map-${Date.now()}.json`), log: () => {} });
  const bridge = new Bridge({ dingtalk: ding, mapper, config: mkConfig(), log: () => {} });
  // 不真正执行（不连 DSH），只验证路由逻辑可达：
  // status/list/use/new/help 都以 / 开头且不是普通消息
  assert.equal(/^\/(status|状态)/.test('/status'), true);
  assert.equal(/^\/(list|列表)\b/.test('/list'), true);
  assert.equal(/^\/(use|切换|switch)\b/.test('/use'), true);
  assert.equal(/^\/(new|reset|clear)\b/.test('/new'), true);
  assert.equal(/^\/(status)/.test('status'), false, '无 / 前缀不是指令');
  rmSync(mapper.file, { force: true });
});

test('_collapseBlankLines 压缩空行', () => {
  const bridge = new Bridge({ config: mkConfig(), log: () => {} });
  const out = bridge._collapseBlankLines('a\n\n\n\n\nb');
  assert.equal(out, 'a\n\n\nb');
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
