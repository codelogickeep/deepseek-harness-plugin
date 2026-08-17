/**
 * dsh-client.js
 *
 * DeepSeek Harness (DSH) 外部客户端。
 *
 * 复用 DSH 浏览器同款线上协议（见 @deepseek-ai/dsh-client-connection）：
 *   - 上行 unary RPC：POST /api/<method>，消息体为 ClientRequest 信封
 *       { type:'client-request', rpcId, method, payload }
 *   - 下行事件流：WS /api/events.mux（只下行；客户端不在该 socket 上发业务数据）
 *      每条消息是一个 ServerRequest 信封 { type:'server-request', rpcId, method, payload }
 *      payload 为 MuxFrame（type: 'session/event' | 'session/subscribed' | ...）
 *
 * 本类只做协议搬运：帧校验、rpcId 回显校验、事件解码、重连。业务决策一律交给上层。
 */

import { EventEmitter } from 'node:events';

const HEARTBEAT_MS = 25_000;

/**
 * @param {string} baseUrl  e.g. http://127.0.0.1:3080
 */
export class DSHClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl DSH Web 地址
   * @param {number}  [opts.timeoutMs=30000] unary 请求超时
   * @param {number}  [opts.reconnectDelayMs=3000] WS 断开后重连间隔
   * @param {(line:string)=>void} [opts.log] 日志函数
   */
  constructor(opts) {
    super();
    this.baseUrl = String(opts.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 3_000;
    this.log = opts.log || ((line) => console.log(`[dsh] ${line}`));
    this.ws = null;
    this.wsClosed = true;
    this._stop = false;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    /** sessionId -> 用于去重的最近事件 seq */
    this._lastSeqs = new Map();
  }

  /** 用真实 rpcId 调用一个 unary RPC。返回 {rpcId, body}（body 为完整 ServerResponse）。 */
  async call(method, payload, { timeoutMs } = {}) {
    const rpcId = crypto.randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: payload ?? {} }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`);
      const body = await res.json();
      if (body.rpcId !== rpcId) throw new Error(`rpcId mismatch on ${method}: sent ${rpcId}, got ${body.rpcId}`);
      return { rpcId, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 便捷包装：返回 result（{ok:true,value} / {ok:false,error}），网络异常折叠为 {ok:false,error:{code:'internal'}}。 */
  async callResult(method, payload, opts) {
    try {
      const { body } = await this.call(method, payload, opts);
      return body.result;
    } catch (err) {
      this.log(`call ${method} transport error: ${err.message}`);
      return { ok: false, error: { code: 'internal', message: String(err?.message || err), details: {} } };
    }
  }

  /** 拉取所有会话的摘要（session.list）。 */
  async listSessions() {
    const r = await this.callResult('session.list', {});
    return r.ok ? (r.value.items || []) : [];
  }

  /** 拉取所有工作区（workspace.list）。 */
  async listWorkspaces() {
    const r = await this.callResult('workspace.list', {});
    return r.ok
      ? { items: r.value.items || [], archivedSessionIds: r.value.archivedSessionIds || [] }
      : { items: [], archivedSessionIds: [] };
  }

  /**
   * 创建会话。可指定稳定 sessionId（同一 id + cwd 幂等）。
   * @returns {Promise<{ok:boolean, sessionId?:string, error?:object}>}
   */
  async createSession({ sessionId, cwd, agentPreset } = {}) {
    const payload = {};
    if (sessionId) payload.sessionId = sessionId;
    if (cwd) payload.cwd = cwd;
    if (agentPreset) payload.agentPreset = agentPreset;
    const r = await this.callResult('session.create', payload);
    if (r.ok) return { ok: true, sessionId: r.value.sessionId };
    return { ok: false, error: r.error };
  }

  /** 重命名会话（返回新标题）。 */
  async renameSession(sessionId, title) {
    const r = await this.callResult('session.rename', { sessionId, title });
    if (r.ok) return { ok: true, title: r.value.title };
    return { ok: false, error: r.error };
  }

  /** 开启持续事件流（自动重连）。返回停止函数。 */
  startEventStream() {
    this._stop = false;
    this._openMux();
    return () => this.stopEventStream();
  }

  stopEventStream() {
    this._stop = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
  }

  _openMux() {
    if (this._stop) return;
    const url = this.baseUrl.replace(/^http/, 'ws') + '/api/events.mux';
    this.log(`WS connect ${url}`);
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.log(`WS constructor error: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener('open', () => {
      this.wsClosed = false;
      this.log('WS open');
      this.emit('stream/online');
      this._startHeartbeat();
    });

    socket.addEventListener('message', (ev) => {
      let frame;
      try {
        if (typeof ev.data !== 'string') return;
        frame = JSON.parse(ev.data);
      } catch {
        this.log('dropping malformed WS frame');
        return;
      }
      this._dispatch(frame);
    });

    socket.addEventListener('error', (ev) => {
      this.log(`WS error: ${ev?.message || 'unknown'}`);
    });

    socket.addEventListener('close', (ev) => {
      this.wsClosed = true;
      this._stopHeartbeat();
      this.log(`WS closed code=${ev.code} reason=${ev.reason || ''}`);
      this.emit('stream/offline');
      this.ws = null;
      this._scheduleReconnect();
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    // WS 连接的活体检测：若 ws 已非 OPEN，主动 close 触发重连逻辑
    this._heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (this.ws) { try { this.ws.close(); } catch { /* noop */ } }
      }
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  _scheduleReconnect() {
    if (this._stop || this._reconnectTimer) return;
    this.log(`WS reconnect in ${this.reconnectDelayMs}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openMux();
    }, this.reconnectDelayMs);
  }

  _dispatch(full) {
    if (!full || full.type !== 'server-request') return;
    this.emit('raw-frame', full);
    const payload = full.payload;
    if (!payload || typeof payload !== 'object') return;

    switch (payload.type) {
      case 'session/subscribed':
        this._lastSeqs.set(payload.sessionId, payload.lastSeq);
        this.log(`session/subscribed ${payload.sessionId} lastSeq=${payload.lastSeq}`);
        this.emit('session/subscribed', payload);
        break;
      case 'session/event': {
        // 基本去重：事件 seq 单调，忽略 <= 已见过的 seq
        const evt = payload.event;
        const last = this._lastSeqs.get(payload.sessionId);
        if (typeof evt?.seq === 'number' && last != null && evt.seq <= last) {
          this.log(`DROP session/event ${payload.sessionId} type=${evt.type} seq=${evt.seq} (已见 last=${last})`);
          return;
        }
        if (typeof evt?.seq === 'number') this._lastSeqs.set(payload.sessionId, evt.seq);
        // 只记录有业务意义的事件（assistant/message 等），chunk 流不刷屏
        if (evt?.type !== 'assistant/chunk') {
          this.log(`EVENT ${payload.sessionId} type=${evt?.type} seq=${evt?.seq}`);
        }
        this.emit('session/event', {
          sessionId: payload.sessionId,
          event: evt,
          view: payload.view,
        });
        break;
      }
      case 'question/requested':
        this.emit('question/requested', payload);
        break;
      case 'approval/requested':
        this.emit('approval/requested', payload);
        break;
      default:
        this.emit('frame', payload);
    }
  }
}

/**
 * 从 assistant/message 的原始 SessionEvent 中提取纯文本。
 * 注意：WS 帧里的 SessionEvent 结构为 { type, seq, time, data:{...} }，
 * 真正的 AssistantMessage 在 event.data.message（content 是 ContentBlock[]）。
 */
export function assistantMessageData(event) {
  return event?.data?.message;
}

/** 从 assistant/message 事件中提取纯文本（拼接所有 text block）。 */
export function assistantText(event) {
  const message = event?.data?.message;
  if (!message?.content) return '';
  return message.content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}
