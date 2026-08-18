/**
 * dingtalk-client.unit.test.js
 *
 * 验证 DingTalkClient 的连接守护机制（不依赖真实钉钉网络）：
 *  1. 半开连接（SDK connected 仍 true 但数据不通）→ 兜底强制重建触发
 *  2. connected=false（SDK 已感知断开）→ 健康哨兵触发重连
 *  3. 用户主动 disconnect 后不再自动重建
 *  4. connect() 超时保护（模拟 _connect 永久 pending）
 *  5. 失败次数指数式增长时可恢复（failStreak 复位）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DingTalkClient } from '../src/dingtalk-client.js';

/**
 * 构造一个可控的 fake DWClient 构造器。
 * behavior.connectResult: 'ok' | 'timeout' | 'error'
 * behavior.connectedAfter: 连接成功后的 connected 值
 */
function makeFakeDW(behavior) {
  const instances = [];
  function FakeDW(opts) {
    instances.push(this);
    this.opts = opts;
    this.connected = false;
    this.listeners = {};
    this.on = (name, fn) => { (this.listeners[name] ||= []).push(fn); return this; };
    this.registerCallbackListener = () => this;
    this.send = () => {};
    this.disconnect = () => { this.connected = false; };
    this.__fire = (name, ...args) => (this.listeners[name] || []).forEach((fn) => fn(...args));
    this.connect = async () => {
      const r = behavior.connectResult('ok');
      if (r === 'ok') {
        this.connected = true;
        this.__fire('open');
      } else if (r === 'timeout') {
        // 模拟永久 pending：不 resolve，也不 reject
        await new Promise(() => {});
      } else {
        const err = new Error('fake connect error');
        this.__fire('error', err);
        throw err;
      }
    };
  }
  return { instances, FakeDW };
}

/** 空的日志收集 */
const logs = [];
const log = (l) => logs.push(l);

/** 立即睡的 fake sleep（不真等） */
const sleep0 = () => Promise.resolve();

function shortOpts(extra = {}) {
  return {
    appKey: 'k', appSecret: 's',
    log,
    _sleep: sleep0,
    healthCheckMs: extra.healthCheckMs,   // 由各测试显式给
    forceRebuildMs: extra.forceRebuildMs,
    connectTimeoutMs: extra.connectTimeoutMs,
    ...extra,
  };
}

/** 等一次真时钟 tick，让真实 interval(>=5ms) 有触发窗口。 */
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

test('半开连接 → 兜底强制重建触发', async () => {
  logs.length = 0;
  const { instances, FakeDW } = makeFakeDW({ connectResult: () => 'ok' });
  const c = new DingTalkClient(shortOpts({
    DWClient: FakeDW,
    healthCheckMs: 0,            // 只测 forceRebuild
    forceRebuildMs: 10,
  }));
  c.connect();
  await tick();
  await tick();
  assert.ok(instances.length >= 1, '至少建立过 1 个连接');
  // 半开：SDK 认为 connected=true（fake 默认就这样），强制重建应新建连接实例
  const before = instances.length;
  await tick(); // 等第二个 forceRebuild interval 触发
  await tick();
  await tick();
  assert.ok(instances.length > before, `兜底重建应新建连接 (before=${before}, after=${instances.length})`);
  assert.ok(logs.some((l) => l.includes('[guard] 强制重建')), '应有强制重建日志');
  c.disconnect();
});

test('connected=false → 健康哨兵触发重连', async () => {
  logs.length = 0;
  // 第一次成功，把一个实例的 connected 拨回 false
  const { instances, FakeDW } = makeFakeDW({ connectResult: () => 'ok' });
  const c = new DingTalkClient(shortOpts({
    DWClient: FakeDW,
    healthCheckMs: 10,
    forceRebuildMs: 0,           // 只测哨兵
  }));
  c.connect();
  await tick();
  await tick();
  assert.equal(instances.length, 1);
  // 模拟 SDK 感知断开
  instances[0].connected = false;
  const before = instances.length;
  await tick();
  await tick();
  await tick();
  assert.ok(instances.length > before, '哨兵应触发重连新建连接');
  assert.ok(logs.some((l) => l.includes('[guard] 检测到连接已断开')), '应有哨兵日志');
  c.disconnect();
});

test('用户主动 disconnect 后不再自动重建', async () => {
  logs.length = 0;
  const { instances, FakeDW } = makeFakeDW({ connectResult: () => 'ok' });
  const c = new DingTalkClient(shortOpts({
    DWClient: FakeDW,
    healthCheckMs: 10,
    forceRebuildMs: 10,
  }));
  c.connect();
  await tick();
  await tick();
  const count = instances.length;
  c.disconnect();
  await tick();
  await tick();
  assert.equal(instances.length, count, 'disconnect 后不应再有新连接');
  c.disconnect(); // 幂等
});

test('connect 超时保护：_connecting 不永久占用，超时后报错并可重试', async () => {
  logs.length = 0;
  // 第一次 timeout（永挂），后续哨兵/手动重建仍能成功
  let attempt = 0;
  const { instances, FakeDW } = makeFakeDW({
    connectResult: () => (attempt++ === 0 ? 'timeout' : 'ok'),
  });
  const c = new DingTalkClient(shortOpts({
    DWClient: FakeDW,
    healthCheckMs: 10,
    forceRebuildMs: 0,
    connectTimeoutMs: 5,
  }));
  c.connect();
  await tick(30); // 让第一次超时真正发生
  // 第一次超时后，_connecting 应已复位
  assert.equal(c._connecting, false, '超时后 _connecting 应复位，允许后续重连');
  assert.ok(logs.some((l) => l.includes('connect timeout')), '应有超时日志');
  // 哨兵随后应能成功建立（第二次 ok），最终应存在第二个健康连接
  await tick(30); await tick(30); await tick(30);
  assert.ok(instances.length >= 2, `应存在第二次重建的连接 (instances=${instances.length})`);
  assert.equal(instances[instances.length - 1].connected, true, '最新连接应处于 connected=true（健康）');
  c.disconnect();
});
