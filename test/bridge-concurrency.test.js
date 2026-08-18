/**
 * bridge-concurrency.test.js
 *
 * 并发多会话回复回归测试（对应 review #2/#3 的引爆点）：
 *  - #2 去重键 _sentSeq 必须按 sessionId 隔离（不同会话 seq 相同不能互相误吞）
 *  - #3 回复候选必须 per-session（两个会话同时回复不能互相覆盖丢消息）
 * 纯单元测试，不依赖真实 DSH / 钉钉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SessionMapper } from '../src/sessions.js';
import { Bridge } from '../src/bridge.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class MockDSH extends EventEmitter {}
class MockDingTalk extends EventEmitter {
  constructor() { super(); this.replies = []; this.onEvent = (n, fn) => this.on(n, fn); }
  connect() { return this; }
  disconnect() {}
  async reply(msg, text) {
    this.replies.push({ conversationId: msg.conversationId, text });
    return { ok: true };
  }
}

function mkConfig() {
  return {
    mapping: { perConversation: true, sessionCwd: '/tmp', agentPreset: 'code' },
    bridge: { replyPrefix: '', maxBlankLines: 2, replyFallbackMs: 60000 },
  };
}

function msg(conversationId) {
  return { conversationId, conversationType: '1', msgtype: 'text', text: { content: 'x' }, sessionWebhook: 'http://fake' };
}

function assistantEvt(sessionId, seq, text) {
  return { sessionId, event: { type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } } };
}

function endEvt(sessionId) {
  return { sessionId, event: { type: 'turn/end' } };
}

function makeBridge() {
  const dsh = new MockDSH();
  const ding = new MockDingTalk();
  const tmpdirName = mkdtempSync(join(tmpdir(), 'dshbridge-conc-'));
  const mapper = new SessionMapper({ file: join(tmpdirName, 'map.json'), log: () => {} });
  const bridge = new Bridge({ dsh, dingtalk: ding, mapper, config: mkConfig(), log: () => {} });
  bridge.start();
  return { bridge, dsh, ding, tmpdirName };
}

const tick = () => new Promise((r) => setImmediate(r));

test('S2+S3：两个会话同 seq 并发回复，各自正确投递不互吞', async () => {
  const { bridge, dsh, ding, tmpdirName } = makeBridge();
  try {
    // 两个会话各自映射到不同钉钉会话（模拟用户消息触发的回复路由）
    bridge.replyTargets.set('session-A', msg('cid-A'));
    bridge.replyTargets.set('session-B', msg('cid-B'));

    // 两个会话「同时」产生 seq=100 的 assistant/message（seq 每会话独立递增）
    dsh.emit('session/event', assistantEvt('session-A', 100, 'A 的回复'));
    dsh.emit('session/event', assistantEvt('session-B', 100, 'B 的回复'));

    // 各自 turn/end
    dsh.emit('session/event', endEvt('session-A'));
    dsh.emit('session/event', endEvt('session-B'));
    await tick();

    const a = ding.replies.find((r) => r.conversationId === 'cid-A');
    const b = ding.replies.find((r) => r.conversationId === 'cid-B');
    assert.ok(a, '会话 A 应收到回复（修复前被会话 B 覆盖而丢失）');
    assert.ok(b, '会话 B 应收到回复');
    assert.ok(a.text.includes('A 的回复'), `A 内容正确：${a.text}`);
    assert.ok(b.text.includes('B 的回复'), `B 内容正确：${b.text}`);
    assert.equal(ding.replies.length, 2, '应恰好两条回复（各一条）');
  } finally {
    bridge.stop();
    rmSync(tmpdirName, { recursive: true, force: true });
  }
});

test('S2：同会话同 seq 重放仍去重，不同会话同 seq 不误吞', async () => {
  const { bridge, dsh, ding, tmpdirName } = makeBridge();
  try {
    bridge.replyTargets.set('session-A', msg('cid-A'));
    bridge.replyTargets.set('session-B', msg('cid-B'));

    // 会话 A 同 seq=7 重放两次（去重应只保留第一次）
    dsh.emit('session/event', assistantEvt('session-A', 7, '第一次'));
    dsh.emit('session/event', assistantEvt('session-A', 7, '重放应被丢弃'));
    // 会话 B 也用 seq=7（不同会话，不应被 A 的去重误吞）
    dsh.emit('session/event', assistantEvt('session-B', 7, 'B 的 seq7'));

    dsh.emit('session/event', endEvt('session-A'));
    dsh.emit('session/event', endEvt('session-B'));
    await tick();

    const a = ding.replies.find((r) => r.conversationId === 'cid-A');
    const b = ding.replies.find((r) => r.conversationId === 'cid-B');
    assert.ok(a.text.includes('第一次') && !a.text.includes('重放'), '同会话同 seq 重放应被去重');
    assert.ok(b.text.includes('B 的 seq7'), '不同会话同 seq 不应被误吞');
    assert.equal(ding.replies.length, 2);
  } finally {
    bridge.stop();
    rmSync(tmpdirName, { recursive: true, force: true });
  }
});
