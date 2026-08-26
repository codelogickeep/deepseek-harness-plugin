/**
 * bridge-workspace-mount.test.js
 *
 * 回归测试：桥接器新建 DSH 会话时会把 workspaceId 传给 session.create，
 * 使新会话挂载进对应路径的工作区（/list 按工作区分组时可见）。
 *
 * 背景 bug：桥接器先前只传 cwd（不传 workspaceId），DSH host 侧
 * session.create 仅在传 workspaceId 时 attachSession，导致钉钉 /new 创建的
 * 会话从不进入 workspace.sessionIds，在 /list 默认分组里消失。
 *
 * 本测试不依赖真实 DSH：mock dsh.ensureWorkspace / createSession 断言调用参数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
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

function mkMsg(conv, text) {
  return { conversationId: conv, conversationType: '1', msgtype: 'text', text: { content: text }, senderId: 'u', sessionWebhook: 'http://fake', robotCode: 'rc' };
}

/** 记录 createSession 入参的 mock dsh。 */
function mkDsh(overrides = {}) {
  const createCalls = [];
  const dsh = {
    on: () => {},
    off: () => {},
    listWorkspaces: async () => ({ items: [], archivedSessionIds: [] }),
    listSessions: async () => [],
    ensureWorkspace: async (path) => ({ ok: true, workspaceId: 'ws-mock', created: false }),
    createSession: async (payload) => {
      createCalls.push(payload);
      return { ok: true, sessionId: 'session-new' };
    },
    renameSession: async () => ({ ok: true }),
    sessionHistory: async () => null,
    ...overrides,
  };
  return { dsh, createCalls };
}

function mkBridge(dsh, { sessionCwd = '/proj' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bwm-'));
  const mapper = new SessionMapper({ file: join(dir, 'm.json'), log: () => {} });
  const dingtalk = new MockDingTalk();
  const bridge = new Bridge({ dsh, dingtalk, mapper, config: { mapping: { perConversation: true, sessionCwd, agentPreset: 'code' }, bridge: {} }, log: () => {} });
  return { bridge, dingtalk, mapper, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('/new 创建会话时传入 workspaceId（挂载进工作区）', async () => {
  const { dsh, createCalls } = mkDsh();
  const { bridge, dingtalk, cleanup } = mkBridge(dsh);
  try {
    bridge.start();
    dingtalk.inject(mkMsg('conv-1', '/new'));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(createCalls.length, 1, '应调用一次 createSession');
    assert.equal(createCalls[0].workspaceId, 'ws-mock', '应传 workspaceId 而非仅 cwd');
    assert.equal('cwd' in createCalls[0], false, 'workspaceId 与 cwd 互斥，不应同时传 cwd');
    assert.ok(dingtalk.lastReply('conv-1')?.text.includes('session-new'), '应回复新建成功');
  } finally { cleanup(); }
});

test('首次消息自动创建会话时也传入 workspaceId', async () => {
  const { dsh, createCalls } = mkDsh();
  const { bridge, dingtalk, cleanup } = mkBridge(dsh);
  try {
    bridge.start();
    // 无 active 映射的钉钉会话发普通消息 → _resolveTarget 创建独立会话
    dingtalk.inject(mkMsg('conv-2', '你好'));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(createCalls.length, 1, '应创建一次会话');
    assert.equal(createCalls[0].workspaceId, 'ws-mock', '应传 workspaceId');
  } finally { cleanup(); }
});

test('工作区解析失败时回退为仅传 cwd（不中断创建）', async () => {
  const { dsh, createCalls } = mkDsh({
    ensureWorkspace: async () => ({ ok: false, error: { code: 'workspace-invalid-path', message: 'bad dir' } }),
  });
  const { bridge, dingtalk, cleanup } = mkBridge(dsh);
  try {
    bridge.start();
    dingtalk.inject(mkMsg('conv-3', '/new'));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(createCalls.length, 1, '仍应创建会话');
    assert.equal(createCalls[0].cwd, '/proj', 'fallback 应传 cwd');
    assert.equal('workspaceId' in createCalls[0], false, 'fallback 不应传 workspaceId');
    assert.ok(dingtalk.lastReply('conv-3')?.text.includes('session-new'), '回退场景也应成功回复');
  } finally { cleanup(); }
});
