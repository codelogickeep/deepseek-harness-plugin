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
    this.client = null;
  }

  /** 建立 Stream 连接并订阅机器人消息（CALLBACK 通道）。 */
  connect() {
    this.client = new DWClient({
      clientId: this.appKey,
      clientSecret: this.appSecret,
      // keepAlive 保持 false（SDK 默认）：应用层 ping/pong 心跳在某些网络环境
      // （代理/NAT）会误判超时并 TERMINATE SOCKET，导致反复断连丢消息。
      // 钉钉服务端有系统级 KEEPALIVE，不依赖应用层心跳。
      keepAlive: false,
    });

    // 关键：注册 CALLBACK 订阅（机器人消息走 CALLBACK 通道，不是 EVENT）。
    // registerAllEventListener 订阅的是 EVENT 通道，收不到机器人消息。
    this.client.registerCallbackListener(TOPIC_ROBOT, (msg) => this._onCallback(msg));

    this.client
      .connect()
      .then(() => {
        this.log('Stream connected');
        // 注意：不要用 SDK 的 registered 字段判断注册状态——
        // 实测（含 openhermit 成功用的 SDK 2.0.4）该字段在钉钉当前网关下
        // 始终为 false（服务端不发送对应 SYSTEM 确认）。连接成功即认为就绪。
      })
      .catch((err) => this.log(`Stream connect error: ${err?.message || err}`));
    return this;
  }

  disconnect() {
    if (this._regTimer) { clearTimeout(this._regTimer); this._regTimer = null; }
    if (this.client) {
      try { this.client.disconnect(); } catch { /* noop */ }
      this.client = null;
    }
  }

  /** 透传 SDK 的连接/断开事件。 */
  onEvent(name, fn) {
    if (!this.client) return;
    this.client.on(name, fn);
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
   * 链接、标题等），否则退回 text。
   * @param {object} msg  机器人消息负载（含 sessionWebhook）
   * @param {string} text 回复文本
   */
  async reply(msg, text, { forceMarkdown } = {}) {
    const webhook = msg?.sessionWebhook;
    if (!webhook) throw new Error('no sessionWebhook in message');
    const useMarkdown = forceMarkdown === true || looksLikeMarkdown(text);
    const body = useMarkdown
      ? { msgtype: 'markdown', markdown: { text } }
      : { msgtype: 'text', text: { content: text } };
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`reply HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    return res;
  }
}

/** 粗略判断文本是否包含钉钉支持的 markdown 语法。 */
export function looksLikeMarkdown(text) {
  if (!text) return false;
  return (
    /\*\*[*\s]/.test(text) ||        // **加粗**
    /(^|\n)\s*[-*] /.test(text) ||   // 列表
    /`[^`\n]+`/.test(text) ||        // 行内代码
    /(^|\n)\s*#{1,4} /.test(text) || // 标题
    /\[[^\]]+\]\([^)]+\)/.test(text) // 链接
  );
}
