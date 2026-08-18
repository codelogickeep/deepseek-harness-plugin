/**
 * dingtalk-client.js
 *
 * 钉钉企业内部应用客户端（Stream 模式）。
 *
 * 连接：官方 dingtalk-stream SDK (DWClient) 连钉钉 Stream 网关。
 * 订阅：必须用 registerCallbackListener(TOPIC_ROBOT, cb) —— 这会把
 *       { type:'CALLBACK', topic:'/v1.0/im/bot/messages/get' } 追加到
 *       subscriptions 中，机器人消息经 CALLBACK 通道分发（不是 EVENT 通道）。
 *       （对照 openhermit 项目已成功对接的实现）
 * 回复：每一条机器人消息回调都携带 sessionWebhook（该会话的专属回传地址），
 *       直接 POST 到 sessionWebhook 即可把消息发回这个会话（无需额外 token）。
 * 确认：收到消息后手动 client.send(messageId, {status:'SUCCESS'})，防止钉钉重复投递。
 *
 * 参考：https://open.dingtalk.com/document/orgapp/stream-mode
 *       https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
 */

import { EventEmitter } from 'node:events';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';

/**
 * @param {object} opts
 * @param {string} opts.appKey       企业内部应用 AppKey（作为 Stream clientId）
 * @param {string} opts.appSecret    企业内部应用 AppSecret（作为 Stream clientSecret）
 * @param {(line:string)=>void} [opts.log]
 */
export class DingTalkClient extends EventEmitter {
  constructor(opts) {
    super();
    this.appKey = opts.appKey;
    this.appSecret = opts.appSecret;
    this.log = opts.log || ((line) => console.log(`[dingtalk] ${line}`));
    // 连接守护配置（默认值；可通过 opts 覆盖）
    //  - healthCheckMs:   健康哨兵周期（0 关闭哨兵）
    //  - forceRebuildMs:  兜底强制重建周期（0 关闭；必须 > 0 才能治半开连接）
    //  - connectTimeoutMs: connect() 超时保护，防止 _connect() 永久 pending
    this.healthCheckMs = opts.healthCheckMs ?? 30_000;
    this.forceRebuildMs = opts.forceRebuildMs ?? 15 * 60_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
    this.client = null;
    // 守护定时器句柄
    this._healthTimer = null;
    this._rebuildTimer = null;
    this._connecting = false;
    this._userDisconnected = false;
    this._failStreak = 0;
    // 供测试注入的时钟/sleep
    this._now = opts._now || (() => Date.now());
    this._sleep = opts._sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // 供测试注入的 DWClient 构造器（默认用真实 SDK）；必须暴露注册回调所需方法
    this._DWClient = opts.DWClient || DWClient;
  }

  /**
   * 建立 Stream 连接并订阅机器人消息（CALLBACK 通道）。
   * 连接后启动两层守护：
   *  1) 健康哨兵：周期性检查 connected；若 SDK 已自判断开则主动重连。
   *  2) 兜底强制重建：即使半开连接（SDK 无感知、connected 仍 true 但数据不通），
   *     也定期显式重建，保证入站通道最终必然恢复。
   */
  connect() {
    if (this._connecting) return this;
    this._userDisconnected = false;
    this._connecting = true;
    // 立即建立（不 await，保持原调用语义）
    this._doConnect().catch((err) => this.log(`Stream connect error: ${err?.message || err}`));
    // 启动守护（幂等：clear 后再设）
    this._startGuards();
    return this;
  }

  async _doConnect() {
    if (this._userDisconnected) return;
    const client = new (this._DWClient)({
      clientId: this.appKey,
      clientSecret: this.appSecret,
      // keepAlive 保持 false（SDK 默认）：应用层 ping/pong 心跳在某些网络环境
      // （代理/NAT）会误判超时并 TERMINATE SOCKET，导致反复断连丢消息。
      // 钉钉服务端有系统级 KEEPALIVE，不依赖应用层心跳。
      // autoReconnect: SDK v2.1.5 默认 true，close/error 时 1s 自动重连；
      //   但我们有兜底强制重建，即使自动重连失效也能恢复。
      keepAlive: false,
    });
    this.client = client;

    // 关键：注册 CALLBACK 订阅（机器人消息走 CALLBACK 通道，不是 EVENT）。
    client.registerCallbackListener(TOPIC_ROBOT, (msg) => this._onCallback(msg));

    // 监听 SDK socket 层的 error/close，输出日志（当前无这些事件的日志，盲区）
    client.on('error', (err) => this.log(`SDK socket error: ${err?.message || err}`));
    client.on('close', () => this.log('SDK socket closed'));

    // connect() 带超时保护：SDK 的 getEndpoint/_connect 可能因网络 hang
    // 而不 reject，导致 _connecting 永久占用、后续无法重连。
    try {
      await Promise.race([
        client.connect(),
        this._sleep(this.connectTimeoutMs).then(() => {
          throw new Error(`connect timeout after ${this.connectTimeoutMs}ms`);
        }),
      ]);
      // SDK connect() 正常返回 = socket 已 open（见 _connect 实现）
      if (!this._userDisconnected) {
        this._failStreak = 0;
        this.log('Stream connected');
        this.emit('connected');
      }
    } catch (err) {
      if (this._userDisconnected) return;
      this._failStreak += 1;
      this.log(`Stream connect error: ${err?.message || err}（第 ${this._failStreak} 次失败，稍后哨兵/重建会重试）`);
      // 即使失败也交给守护定时器重试（这里不立即 fire，避免风暴）
    } finally {
      this._connecting = false;
    }
  }

  /** 由守护触发的一次性强制重连。 */
  async _rebuild() {
    if (this._connecting || this._userDisconnected) return;
    if (this.client) {
      try { this.client.disconnect(); } catch { /* noop */ }
      this.client = null;
    }
    this.log(`[guard] 强制重建 Stream 连接（失败连续 ${this._failStreak} 次）…`);
    await this._doConnect();
    if (!this._userDisconnected && !this.client?.connected) {
      // 重建后仍未连上，健康哨兵会再试（指数退避在哨兵处处理）
    }
  }

  /** 健康哨兵：按固定周期检查；检测到异常时重连，并按失败次数退避。 */
  _startGuards() {
    this._clearGuards();
    if (this.healthCheckMs > 0) {
      this._healthTimer = setInterval(() => {
        if (this._userDisconnected || this._connecting) return;
        const c = this.client;
        const dead = !c || c.connected !== true;
        if (dead) {
          // connected=false（SDK 已感知断开但自动重连可能已放弃）
          this._failStreak += 1;
          this.log(`[guard] 检测到连接已断开（connected=${c?.connected}），触发重连（第 ${this._failStreak} 次异常）`);
          this._rebuild().catch((e) => this.log(`[guard] 重连失败: ${e?.message || e}`));
        } else {
          // 连接本身 OK；连续成功则刷新失败计数（半开连接由 forceRebuild 兜底）
          if (this._failStreak > 0) this._failStreak = Math.max(0, this._failStreak - 1);
        }
      }, this.healthCheckMs);
      // 哨兵定时器不阻止进程退出
      if (typeof this._healthTimer?.unref === 'function') this._healthTimer.unref();
    }
    if (this.forceRebuildMs > 0) {
      this._rebuildTimer = setInterval(() => {
        if (this._userDisconnected || this._connecting) return;
        // 兜底：无论 SDK 认为连接是否健康，周期性强制重建。
        // 根治半开连接（SDK 无事件、connected 仍 true、但数据不通）。
        this._rebuild().catch((e) => this.log(`[guard] 强制重建失败: ${e?.message || e}`));
      }, this.forceRebuildMs);
      if (typeof this._rebuildTimer?.unref === 'function') this._rebuildTimer.unref();
    }
  }

  _clearGuards() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    if (this._rebuildTimer) { clearInterval(this._rebuildTimer); this._rebuildTimer = null; }
  }

  disconnect() {
    this._userDisconnected = true;
    this._clearGuards();
    if (this.client) {
      try { this.client.disconnect(); } catch { /* noop */ }
      this.client = null;
    }
  }

  /** 透传 SDK 的连接/断开事件。 */
  onEvent(name, fn) {
    if (this.client) {
      this.client.on(name, fn);
    } else {
      this.once('connected', () => { this.client?.on(name, fn); });
    }
  }

  /**
   * CALLBACK 通道回调：msg = { specVersion, type:'CALLBACK', headers:{...}, data:string }
   * data 是机器人消息 JSON（conversationId / sessionWebhook / text 等）。
   * 与 EVENT 通道的结构（type 为 'EVENT'）不同，这里是 headers.topic === TOPIC_ROBOT。
   */
  _onCallback(msg) {
    try {
      const topic = msg?.headers?.topic;
      this.log(`[raw] 收到 CALLBACK 消息 topic=${topic} messageId=${msg?.headers?.messageId}`);
      if (topic !== TOPIC_ROBOT) {
        this.log(`[raw] 非机器人 CALLBACK topic，忽略：${topic}`);
        return;
      }
      const payload = JSON.parse(msg.data);
      this.emit('message', payload);

      // 手动 ACK，防止钉钉重复投递
      try {
        if (this.client && msg?.headers?.messageId) {
          this.client.send(msg.headers.messageId, { status: 'SUCCESS' });
        }
      } catch (err) {
        this.log(`ACK 发送失败: ${err?.message || err}`);
      }
    } catch (err) {
      this.log(`callback parse error: ${err?.message || err}`);
    }
  }

  /**
   * 回复一条消息到会话。
   * 优先使用回调携带的 sessionWebhook（最可靠、无需 access_token）。
   * 若文本包含 markdown 语法则用钉钉 markdown 消息（渲染 **加粗**、`代码`、列表、
   * 链接、标题等；markdown 必须带 title 字段），否则退回 text。
   * @param {object} msg  机器人消息负载（含 sessionWebhook）
   * @param {string} text 回复文本
   */
  async reply(msg, text, { forceMarkdown } = {}) {
    const webhook = msg?.sessionWebhook;
    if (!webhook) throw new Error('no sessionWebhook in message');
    const useMarkdown = forceMarkdown === true || looksLikeMarkdown(text);
    const body = useMarkdown
      ? { msgtype: 'markdown', markdown: { title: activePushTitle(text), text } }
      : { msgtype: 'text', text: { content: text } };
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const textBody = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`reply HTTP ${res.status}: ${textBody.slice(0, 200)}`);
    }
    // 钉钉业务错误：HTTP 200 但 body { errcode, errmsg }，如 markdown 缺 title → 400402
    try {
      const j = textBody ? JSON.parse(textBody) : null;
      if (j && typeof j.errcode === 'number' && j.errcode !== 0) {
        throw new Error(`dingtalk errcode=${j.errcode} errmsg=${j.errmsg || ''}`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // 非 JSON（可能是空响应），忽略
      } else {
        throw e;
      }
    }
    return res;
  }
}

/**
 * markdown 消息的标题（钉钉必填）。取首行非空文本，截断到 40 字符。
 */
export function activePushTitle(text) {
  const firstLine = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const clean = (firstLine || '消息').replace(/\*\*|`|#/g, '').trim();
  return clean.slice(0, 40) || '消息';
}

/** 粗略判断文本是否包含钉钉支持的 markdown 语法。 */
export function looksLikeMarkdown(text) {  if (!text) return false;
  return (
    /\*\*[*\s]/.test(text) ||        // **加粗**
    /(^|\n)\s*[-*] /.test(text) ||   // 列表
    /`[^`\n]+`/.test(text) ||        // 行内代码
    /(^|\n)\s*#{1,4} /.test(text) || // 标题
    /\[[^\]]+\]\([^)]+\)/.test(text) // 链接
  );
}
