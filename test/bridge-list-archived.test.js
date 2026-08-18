/**
 * bridge-list-archived.test.js
 *
 * 验证已归档会话在 /list、/use 里被过滤（不依赖真实 DSH）：
 *  - _visibleWorkspaces 从工作区剔除 archivedSessionIds
 *  - _handleList 输出的回复不包含已归档会话
 *  - _handleUse 无法通过序号/sessionId命中已归档会话
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionMapper } from '../src/sessions.js';
import { Bridge } from '../src/bridge.js';

/** 模拟钉钉客户端 */
class MockDingTalk extends EventEmitter {
  constructor() { super(); this.replies = []; this.onEvent = (n, fn) => this.on(n, fn); }
  connect() { return this; }
  disconnect() {}
  async reply(msg, text) { this.replies.push({ conversationId: msg.conversationId, text }); return { ok: true }; }
  inject(msg) { this.emit('message', msg); }
  lastReply(conversationId) { return [...this.replies].reverse().find((r) => r.conversationId === conversationId); }
}

function mkSession(id, { title = '(无标题)', cwd = '/proj', running = false } = {}) {
  return { sessionId: id, updatedAt: 1, running, blank: false, cwd, agentPreset: 'code', projections: { values: { title } } };
}

/** 构造 Bridge + mock dsh（可注入 workspace/session 数据） */
function mkBridge({ workspaces, archivedSessionIds, sessions } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bul-'));
  const mappingFile = join(dir, 'mapping.json');
  const dingtalk = new MockDingTalk();
  const mapper = new SessionMapper({ file: mappingFile, log: () => {} });
  const dshEvents = new EventEmitter();
  const dsh = {
    on: (...a) => dshEvents.on(...a),
    off: (...a) => dshEvents.off(...a),
    listWorkspaces: async () => ({ items: workspaces || [], archivedSessionIds: archivedSessionIds || [] }),
    listSessions: async () => (sessions || []),
    createSession: async () => ({ ok: true, sessionId: 'session-created' }),
    renameSession: async () => ({ ok: true }),
    callResult: async () => ({ ok: true, value: {} }),
    sessionHistory: async () => null,
  };
  const bridge = new Bridge({ dsh, dingtalk, mapper, config: { mapping: { perConversation: true, sessionCwd: '/proj', agentPreset: 'code' }, bridge: {} }, log: () => {} });
  return { bridge, dingtalk, mapper, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mkMsg(conv, text) {
  return { conversationId: conv, conversationType: '1', msgtype: 'text', text: { content: text }, senderId: 'u', sessionWebhook: 'http://fake', robotCode: 'rc' };
}

test('_visibleWorkspaces 剔除已归档会话', async () => {
  const { bridge, cleanup } = mkBridge();
  try {
    const workspaces = [
      { title: 'W1', path: '/w1', sessionIds: ['session-a', 'session-archived', 'session-b'] },
      { title: 'W2', path: '/w2', sessionIds: ['session-c'] },
    ];
    const archived = new Set(['session-archived']);
    const visible = bridge._visibleWorkspaces(workspaces, archived);
    assert.deepEqual(visible[0].sessionIds, ['session-a', 'session-b'], 'W1 剔除已归档');
    assert.deepEqual(visible[1].sessionIds, ['session-c'], 'W2 不变');
  } finally { cleanup(); }
});

test('/list 回复不包含已归档会话', async () => {
  const conv = 'conv-1';
  const { bridge, dingtalk, cleanup } = mkBridge({
    workspaces: [
      { title: 'projA', path: '/projA', sessionIds: ['session-a', 'session-archived'] },
    ],
    archivedSessionIds: ['session-archived'],
    sessions: [
      mkSession('session-a', { title: '活会话A' }),
      mkSession('session-archived', { title: 'history unavail 归档', cwd: '/projA' }),
    ],
  });
  try {
    bridge.start();
    dingtalk.inject(mkMsg(conv, '/list'));
    // 立即刷新事件循环，让异步 _handleList 跑完
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    const rep = dingtalk.lastReply(conv);
    assert.ok(rep, '应有 /list 回复');
    assert.ok(!rep.text.includes('session-archived'), '回复不应包含已归档会话 ID');
    assert.ok(rep.text.includes('session-a'), '回复应包含活跃会话');
    assert.ok(!rep.text.includes('history unavail'), '回复不应包含已归档会话标题');
  } finally {
    bridge.stop();
    cleanup();
  }
});

test('/use 序号无法命中已归档会话', async () => {
  const conv = 'conv-1';
  const { bridge, dingtalk, cleanup } = mkBridge({
    workspaces: [
      { title: 'projA', path: '/projA', sessionIds: ['session-live', 'session-archived'] },
    ],
    archivedSessionIds: ['session-archived'],
    sessions: [
      mkSession('session-live', { title: '活跃' }),
      mkSession('session-archived', { title: '已归档', cwd: '/projA' }),
    ],
  });
  try {
    bridge.start();
    // /use 1 → 应切到 session-live（已归档的 session-archived 不应占序号）
    dingtalk.inject(mkMsg(conv, '/use 1'));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    const rep = dingtalk.lastReply(conv);
    assert.ok(rep.text.includes('session-live'), `/use 1 应切到 session-live，实际: ${rep.text}`);
    assert.equal(bridge.mapper.getActive(conv), 'session-live', 'active 应为 session-live');
    // /use 2 应提示超范围（因为只剩 1 个可见会话）
    dingtalk.inject(mkMsg(conv, '/use 2'));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    const rep2 = dingtalk.lastReply(conv);
    assert.ok(/超出范围|找不到/.test(rep2.text), '序号 2 应超范围，实际: ' + rep2.text);
  } finally {
    bridge.stop();
    cleanup();
  }
});

test('/use sessionId 直接命中已归档会话时被拒绝', async () => {
  const conv = 'conv-1';
  const { bridge, dingtalk, cleanup } = mkBridge({
    workspaces: [{ title: 'W', path: '/w', sessionIds: ['session-live'] }],
    archivedSessionIds: ['session-archived'],
    sessions: [
      mkSession('session-live', { title: '活跃' }),
      mkSession('session-archived', { title: '已归档', cwd: '/w' }),
    ],
  });
  try {
    bridge.start();
    dingtalk.inject(mkMsg(conv, '/use session-archived'));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    const rep = dingtalk.lastReply(conv);
    assert.ok(/找不到|不存在/.test(rep.text), `应拒绝已归档会话，实际: ${rep.text}`);
    assert.equal(bridge.mapper.getActive(conv), null, 'active 不应被设为已归档会话');
  } finally {
    bridge.stop();
    cleanup();
  }
});
