/**
 * dsh-client.integration.test.js
 *
 * 真实 DSH 协议集成测试（需要 DSH Web 在 127.0.0.1:3080 运行）。
 *
 * 运行：node --test test/dsh-client.integration.test.js
 * 或  npm test（若 DSH 在线则执行，否则跳过）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DSHClient } from '../src/dsh-client.js';

const BASE = process.env.DSH_TEST_BASE_URL || 'http://127.0.0.1:3080';

// 探测 DSH 是否在线
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

const online = await dshOnline();
test('DSH 在线检查', () => {
  assert.ok(online, 'DSH 不在线，跳过集成测试（需要 http://127.0.0.1:3080）');
});

const client = online ? new DSHClient({ baseUrl: BASE, log: () => {} }) : null;

test('session.list 返回会话数组', { skip: !online }, async () => {
  const items = await client.listSessions();
  assert.ok(Array.isArray(items));
  for (const it of items) {
    assert.equal(typeof it.sessionId, 'string');
  }
});

test('session.create 幂等创建', { skip: !online }, async () => {
  const sid = `session-dingtest-${Date.now()}`;
  const a = await client.createSession({ sessionId: sid, cwd: '/tmp' });
  assert.equal(a.ok, true);
  assert.equal(a.sessionId, sid);
  const b = await client.createSession({ sessionId: sid, cwd: '/tmp' });
  assert.equal(b.ok, true);
  assert.equal(b.sessionId, sid);
});

test('session.prompt 后收到 assistant 回复（端到端）', { skip: !online, timeout: 90000 }, async () => {
  const sid = `session-dingtest-e2e-${Date.now()}`;
  const created = await client.createSession({ sessionId: sid, cwd: '/tmp' });
  assert.equal(created.ok, true);

  const stop = client.startEventStream();
  const replyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回复超时')), 80000);
    client.on('session/event', (ev) => {
      if (ev.sessionId !== sid) return;
      if (ev.event?.type === 'assistant/message') {
        clearTimeout(timer);
        resolve(ev.event);
      }
    });
  });

  try {
    const r = await client.callResult('session.prompt', {
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: '只回复两个字：收到' }],
    });
    assert.equal(r.ok, true);
    const msg = await replyPromise;
    // SessionEvent: { type, seq, time, data:{ message:{...} } }
    const text = (msg.data?.message?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
    assert.ok(text.length > 0, 'assistant 文本非空');
  } finally {
    stop();
  }
});

test('事件流收到 session/subscribed 帧', { skip: !online, timeout: 20000 }, async () => {
  const stop = client.startEventStream();
  const got = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('未收到订阅帧')), 15000);
    client.on('session/subscribed', (f) => {
      clearTimeout(timer);
      resolve(f);
    });
  });
  try {
    const f = await got;
    assert.equal(typeof f.sessionId, 'string');
    assert.equal(typeof f.lastSeq, 'number');
  } finally {
    stop();
  }
});
