/**
 * bridge.js
 *
 * 双向桥接核心：
 *   钉钉消息 → DSH 会话（session.prompt）
 *   DSH assistant 回复 → 钉钉会话（sessionWebhook 回发）
 *
 * 策略：
 *   - 每个钉钉会话稳定映射到一个 DSH 会话（SessionMapper 持久化）。
 *   - 钉钉消息以 mode:"queue" 入队，Agent 处理完会产生 assistant/message，
 *     桥接器从 events.mux 事件流识别对应 sessionId 的新回复并发回钉钉。
 *   - 支持 /new 命令：为当前钉钉会话重开一个干净的 DSH 会话。
 */

import { assistantText } from './dsh-client.js';

export class Bridge {
  /**
   * @param {object} deps
   * @param {import('./dsh-client.js').DSHClient} deps.dsh
   * @param {import('./dingtalk-client.js').DingTalkClient} deps.dingtalk
   * @param {import('./sessions.js').SessionMapper} deps.mapper
   * @param {object} deps.config  完整配置（含 mapping/bridge 段）
   * @param {(line:string)=>void} [deps.log]
   */
  constructor(deps) {
    this.dsh = deps.dsh;
    this.dingtalk = deps.dingtalk;
    this.mapper = deps.mapper;
    this.config = deps.config;
    this.log = deps.log || ((line) => console.log(`[bridge] ${line}`));
    /** 处理中的会话集合，防止并发 prompt 叠加 */
    this.pending = new Set();
    /** dshSessionId -> { conversationId, msg } 最近一次发送者，用于回复路由 */
    this.replyTargets = new Map();
    this._onMuxEvent = (ev) => this._handleSessionEvent(ev);
    this._onDingMessage = (msg) => this._handleDingMessage(msg);
  }

  start() {
    // 钉钉消息入
    this.dingtalk.on('message', this._onDingMessage);
    // DSH 回复出
    this.dsh.on('session/event', this._onMuxEvent);
    // 事件流上线后，检查是否有未完成的 prompt（幂等重试场景可扩展）
    this.log('bridge started');
  }

  stop() {
    this.dingtalk?.off?.('message', this._onDingMessage);
    this.dsh?.off?.('session/event', this._onMuxEvent);
  }

  /** 处理一条钉钉机器人消息。 */
  async _handleDingMessage(msg) {
    try {
      const convId = msg?.conversationId;
      if (!convId) {
        this.log(`[recv] 丢弃：无 conversationId ${JSON.stringify(msg)?.slice(0, 200)}`);
        return;
      }
      this.log(`[recv] 收到消息 conv=${convId} type=${msg.conversationType} msgtype=${msg.msgtype} 内容=${JSON.stringify(this._rawText(msg))?.slice(0, 100)}`);

      // 记录回复目标（sessionWebhook 会随时间/会话变化，取最新）
      this.replyTargets.set(convId, msg);
      // 持久化投递 webhook，供「主动推送」使用（DSH 主动/定时消息 → 钉钉）
      if (msg?.sessionWebhook) this.mapper.setWebhook(convId, msg.sessionWebhook);

      // 群聊里只响应 at 机器人的消息（可选策略；单聊总是响应）
      if (this._shouldIgnore(msg)) {
        this.log(`[recv] conv=${convId} 被忽略（群聊且未 @ 机器人，或策略过滤）`);
        return;
      }

      const text = this._extractText(msg);
      if (!text) {
        this.log(`[recv] conv=${convId} 文本为空，忽略（非 text 类型或空内容）`);
        return;
      }

      // 会话管理指令（不投给 Agent，直接处理）
      if (/^\/(status|状态)/.test(text)) {
        await this._handleStatus(msg);
        return;
      }
      if (/^\/(list|列表)\b/.test(text)) {
        await this._handleList(msg, text);
        return;
      }
      if (/^\/(use|切换|switch)\b/.test(text)) {
        await this._handleUse(msg, text);
        return;
      }
      if (/^\/(new|reset|clear)\b/.test(text)) {
        await this._handleNewCommand(msg, text);
        return;
      }
      if (/^\/(help|帮助)\b/.test(text)) {
        await this._handleHelp(msg);
        return;
      }

      if (this.pending.has(convId)) {
        this.log(`conversation ${convId} is busy, queueing anyway`);
      }

      const dshSessionId = await this._resolveTarget(msg);
      if (!dshSessionId) {
        await this._replyText(msg, '⚠️ 无法确定 DSH 会话，请检查 DSH 是否在线。');
        return;
      }
      this.log(`[recv] conv=${convId} -> DSH 会话 ${dshSessionId}，提交文本`);

      await this._prompt(msg, dshSessionId, text);
      this.log(`[recv] conv=${convId} 已提交给 DSH`);
    } catch (err) {
      this.log(`handle ding message error: ${err?.stack || err}`);
      try {
        await this._replyText(msg, `⚠️ 内部错误：${err?.message || err}`);
      } catch { /* noop */ }
    }
  }

  _shouldIgnore(msg) {
    // 群聊消息：仅在消息体包含 @机器人 时响应
    if (msg?.conversationType === '2') {
      // 直接用原始消息内容判断（不要走 _extractText，它已去掉 @ 前缀）
      const content = (msg?.text?.content) || '';
      const nick = msg.robotCode || msg.chatbotUserId || '';
      // 判定：以 @ 开头（常见形态），或文本里出现机器人名字/自身 userid
      const direct = /^@/.test(content.trim());
      const atMention = content.includes('@') && (nick ? content.includes(nick) : true);
      return !(direct || atMention);
    }
    // 单聊：总是响应
    return false;
  }

  _extractText(msg) {
    if (msg?.msgtype === 'text' && typeof msg?.text?.content === 'string') {
      // 去掉 @机器人 前缀
      return msg.text.content.replace(/^@[^\s]+/, '').trim();
    }
    // 其他类型（图片/文件/链接等）暂不支持，返回空
    return '';
  }

  /** 取原始文本（不做任何清理），仅用于日志诊断。 */
  _rawText(msg) {
    return msg?.msgtype === 'text' ? msg?.text?.content : '';
  }

  async _handleNewCommand(msg, text) {
    // /new [路径]: 为当前钉钉会话新建 DSH 会话并设为投递目标
    const convId = msg.conversationId;
    const arg = text.replace(/^\/(new|reset|clear)\b/, '').trim();
    const cwd = arg || this.config.mapping.sessionCwd;
    const result = await this.dsh.createSession({
      cwd,
      agentPreset: this.config.mapping.agentPreset,
    });
    if (result.ok && result.sessionId) {
      // 记录历史 + 设为 active（保留历史，切回可续聊）
      this.mapper.setActive(convId, result.sessionId, { keepHistory: true });
      // 给新会话命名（用路径 basename），方便 /list 里识别
      const base = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
      const title = `[${base}]`;
      this.dsh.renameSession(result.sessionId, title).catch(() => {});
      const label = arg ? `（路径：${cwd}）` : '';
      await this._replyText(msg, `✅ 已新建 DSH 会话并切换为当前目标。\n会话：${result.sessionId}\n${cwd}${label}\n提示：之前的会话仍保留，可用 /list 和 /use 切回续聊。`);
    } else {
      await this._replyText(msg, `⚠️ 无法创建新会话：${result.error?.message || '未知错误'}`);
    }
  }

  /** /status: 显示当前投递目标。 */
  async _handleStatus(msg) {
    const convId = msg.conversationId;
    const active = this.mapper.getActive(convId);
    if (!active) {
      await this._replyText(msg, '📊 当前没有投递目标。发一条普通消息会自动跟随当前运行的会话，或用 /list、/use 选择。');
      return;
    }
    const sessions = await this.dsh.listSessions().catch(() => []);
    const s = sessions.find((x) => x.sessionId === active);
    if (!s) {
      await this._replyText(msg, `📊 当前投递目标：\n  会话：${active}\n  （该会话不在 DSH 会话列表中，可能已被归档）`);
      return;
    }
    const title = s.projections?.values?.title || '(无标题)';
    await this._replyText(msg, `📊 当前投递目标：\n  会话：${active}\n  项目：${s.cwd}\n  标题：${title}\n  状态：${s.running ? '🟢 运行中' : '⚪ 空闲'}`);
  }

  /**
   * /list [all|N]: 按工作区分组展示 DSH 会话（干净、与 DSH 界面一致）。
   *   - 默认（或 /list N）：按工作区分组，会话带全局连续序号
   *   - /list all：平铺展示全部会话（含无工作区的历史会话）
   */
  async _handleList(msg, text) {
    const convId = msg.conversationId;
    const arg = text.replace(/^\/(list|列表)\b/, '').trim();
    const active = this.mapper.getActive(convId);
    const { items: workspaces } = await this.dsh.listWorkspaces().catch(() => ({ items: [] }));
    const sessions = await this.dsh.listSessions().catch(() => []);

    // 建立 sessionId -> session 摘要 的索引
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));

    if (arg === 'all') {
      // 平铺模式：全部会话按更新时间降序
      if (sessions.length === 0) {
        await this._replyText(msg, '📋 DSH 里没有任何会话。');
        return;
      }
      const top = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
      const lines = top.map((s, i) => {
        const title = (s.projections?.values?.title || '(无标题)').slice(0, 24);
        const mark = s.sessionId === active ? '▶' : ' ';
        const state = s.running ? '🟢' : '  ';
        const ws = workspaces.find((w) => (w.sessionIds || []).includes(s.sessionId));
        const tag = ws ? `[${ws.title}]` : '[无工作区]';
        return `${mark}${i + 1}. ${state} ${title}  ${tag}  ${s.sessionId}`;
      });
      await this._replyText(msg, `📋 DSH 全部会话（${top.length} 个，▶=当前目标）：\n${lines.join('\n')}\n\n用 /use <序号|关键词|会话ID> 切换。`);
      return;
    }

    // 默认：按工作区分组展示（只显示工作区内的会话，未挂载的历史会话在 /list all 里）
    const limit = Math.min(parseInt(arg, 10) || 50, 50);
    let n = 0;
    const lines = [];
    for (const w of workspaces) {
      const wsSids = (w.sessionIds || []).slice(0, Math.max(0, limit - n));
      if (wsSids.length === 0) {
        lines.push(`📁 ${w.title}  ${w.path}`);
        continue;
      }
      lines.push(`📁 ${w.title}  ${w.path}`);
      for (const sid of wsSids) {
        n += 1;
        if (n > limit) break;
        const s = byId.get(sid);
        if (!s) {
          lines.push(`  ${n}. (会话不存在或已归档)`);
          continue;
        }
        const title = (s.projections?.values?.title || '(无标题)').slice(0, 24);
        const mark = sid === active ? '▶' : ' ';
        const state = s.running ? '🟢' : '  ';
        lines.push(`  ${mark}${n}. ${state} ${title}  ${s.sessionId}`);
      }
      if (n >= limit) break;
    }
    if (n === 0) {
      await this._replyText(msg, '📋 DSH 里没有任何工作区或会话。');
      return;
    }
    const summary = `（共 ${workspaces.length} 个工作区，${n} 个会话）`;
    await this._replyText(msg, `📋 DSH 工作区（▶=当前目标）:\n${lines.join('\n')}\n\n${summary}\n用 /use <序号|关键词|会话ID> 切换；/list all 查看全部平铺列表（含未挂载会话）。`);
  }

  /** /use <序号|路径关键词|会话ID>: 切换投递目标（历史保留，可切回续聊）。 */
  async _handleUse(msg, text) {
    const convId = msg.conversationId;
    const arg = text.replace(/^\/(use|切换|switch)\b/, '').trim();
    if (!arg) {
      await this._replyText(msg, '用法：/use <序号|路径关键词|会话ID>\n示例：/use 2  （用 /list 查看序号）\n     /use deepseek-harness  （按路径关键词）');
      return;
    }
    const sessions = await this.dsh.listSessions().catch(() => []);
    let target = null;

    // 1) 序号匹配：全局连续序号 = 工作区顺序 → 工作区内会话顺序（与 /list 一致）
    const idx = parseInt(arg, 10);
    if (!Number.isNaN(idx) && idx >= 1) {
      const { items: workspaces } = await this.dsh.listWorkspaces().catch(() => ({ items: [] }));
      const byId = new Map(sessions.map((s) => [s.sessionId, s]));
      const ordered = [];
      const seen = new Set();
      for (const w of workspaces) {
        for (const sid of w.sessionIds || []) {
          if (!seen.has(sid) && byId.has(sid)) { seen.add(sid); ordered.push(byId.get(sid)); }
        }
      }
      // 未挂载到工作区的会话排在最后（按时间降序）
      const orphan = sessions
        .filter((s) => !seen.has(s.sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const all = [...ordered, ...orphan];
      target = all[idx - 1] || null;
      if (!target) {
        await this._replyText(msg, `⚠️ 序号 ${idx} 超出范围（共 ${all.length} 个会话）。用 /list 查看。`);
        return;
      }
    }
    // 2) sessionId 精确匹配
    if (!target) {
      target = sessions.find((s) => s.sessionId === arg) || null;
    }
    // 2.5) sessionId 前缀匹配（列表里可能只显示部分ID也能命中）
    if (!target && arg.startsWith('session-')) {
      target = sessions.find((s) => s.sessionId.startsWith(arg)) || null;
      if (!target) {
        await this._replyText(msg, `⚠️ 找不到会话ID以 "${arg}" 开头的会话。用 /list 查看完整ID。`);
        return;
      }
    }
    // 3) 路径/标题关键词匹配（取第一个）
    if (!target) {
      const kw = arg.toLowerCase();
      target = sessions.find((s) => (s.cwd || '').toLowerCase().includes(kw) || (s.projections?.values?.title || '').toLowerCase().includes(kw)) || null;
    }
    if (!target) {
      await this._replyText(msg, `⚠️ 找不到匹配 "${arg}" 的会话。用 /list 查看所有会话。`);
      return;
    }

    // 切换（保留历史，DSH 持久化保证切回可续聊）
    this.mapper.setActive(convId, target.sessionId, { keepHistory: true });
    const title = (target.projections?.values?.title || '(无标题)').slice(0, 30);
    await this._replyText(msg, `✅ 已切换投递目标：\n  会话：${target.sessionId}\n  项目：${target.cwd}\n  标题：${title}\n\n之前的会话保留在历史中，随时可用 /list + /use 切回续聊。`);
  }

  async _handleHelp(msg) {
    await this._replyText(
      msg,
      '🤖 DeepSeek Harness 钉钉桥接器\n\n' +
        '直接发送消息与我对话。\n' +
        '会话管理指令：\n' +
        '  /status  查看当前投递目标\n' +
        '  /list    列出 DSH 会话\n' +
        '  /use <序号|关键词>  切换会话（可切回续聊）\n' +
        '  /new [路径]  新建 DSH 会话\n' +
        '  /help    显示本帮助',
    );
  }

  /** 确保该钉钉会话已映射到 DSH 会话（必要时创建）。 */
  /**
   * 解析该钉钉会话的当前投递目标 DSH 会话。
   * 优先级：activeSessionId（用户 /use、/new 设置）
   *        → MAPPING_MODE=auto-follow 时取运行中最新会话
   *        → 默认：为该钉钉会话创建独立 DSH 会话（上下文隔离，支持续聊）
   */
  async _resolveTarget(msg) {
    const convId = msg.conversationId;
    const active = this.mapper.getActive(convId);
    if (active) return active;

    // 可选：auto-follow 当前运行中最新会话（需配置开启，默认关闭）
    if (this.config.mapping?.mode === 'auto-follow') {
      const sessions = await this.dsh.listSessions().catch(() => []);
      const running = sessions.filter((s) => s.running).sort((a, b) => b.updatedAt - a.updatedAt);
      if (running.length > 0) {
        const sid = running[0].sessionId;
        this.mapper.setActive(convId, sid);
        this.log(`auto-follow 当前会话 ${sid} (cwd=${running[0].cwd})`);
        return sid;
      }
    }

    // 默认：为该钉钉会话创建独立 DSH 会话
    const result = await this.dsh.createSession({
      cwd: this.config.mapping.sessionCwd,
      agentPreset: this.config.mapping.agentPreset,
    });
    if (!result.ok || !result.sessionId) return null;
    this.mapper.setActive(convId, result.sessionId);
    this.log(`创建独立会话 ${result.sessionId} (cwd=${this.config.mapping.sessionCwd})`);
    return result.sessionId;
  }

  /** 把用户文本作为排队消息送到 DSH 会话。 */
  async _prompt(msg, dshSessionId, text) {
    const convId = msg.conversationId;
    this.pending.add(convId);
    // 记录该 DSH 会话的回复路由
    this.replyTargets.set(dshSessionId, msg);
    try {
      const r = await this.dsh.callResult('session.prompt', {
        sessionId: dshSessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      });
      if (!r.ok) {
        this.log(`prompt to ${dshSessionId} failed: ${r.error?.code} ${r.error?.message}`);
        await this._replyText(msg, `⚠️ 无法送达给 Agent：${r.error?.message || r.error?.code || '未知错误'}`).catch(() => {});
      }
    } finally {
      this.pending.delete(convId);
    }
  }

  /** 处理 events.mux 里的 session/event —— 识别 assistant 文本回复并回发钉钉。 */
  _handleSessionEvent({ sessionId, event }) {
    if (event?.type !== 'assistant/message') return;
    // 原始 SessionEvent：{ type, seq, time, data:{ message:{ content:[...] } } }
    const text = assistantText(event);
    this.log(`[reply] assistant/message session=${sessionId} seq=${event?.seq} 文本长度=${text.length}`);
    if (!text) return;

    // 去重：同一条 seq 只投递一次（避免事件重放/桥接器重连导致重复推送）
    if (this._sentSeq.has(event.seq)) return;
    this._sentSeq.add(event.seq);

    const target = this.replyTargets.get(sessionId);
    if (!target) {
      // 没有「当前正在等回复」的钉钉消息 —— 这是 DSH 主动产生的消息
      // （schedule 定时提醒、Agent 主动输出、或经其他通道触发的回复）。
      // 走「主动推送」：反查哪个钉钉会话把该 DSH 会话设为投递目标，用持久 webhook 推过去。
      const pushed = this._tryActivePush(sessionId, text);
      if (pushed) {
        this.log(`[reply] 主动推送 session=${sessionId} seq=${event?.seq} 文本长度=${text.length}`);
      } else {
        this.log(`[reply] 无回复目标(sessionId=${sessionId})，忽略`);
      }
      return;
    }
    this._replyText(target, this._formatReply(text)).catch((err) => {
      this.log(`reply to dingtalk failed: ${err?.message || err}`);
    });
    this.log(`[reply] 已回发钉钉: ${JSON.stringify(this._formatReply(text)).slice(0, 60)}…`);
  }

  /**
   * 主动推送：把 DSH 会话产生的消息推送到「把它设为投递目标 / 用过它」的钉钉会话。
   * 反查 session-mapping：遍历 mapping，找 activeSessionId === sessionId 的 conversation；
   * 若无精确 match，再退而找 sessions 历史里包含该 sessionId 的 conversation（仅当唯一）。
   * 取持久 webhook 推送。返回是否推送了。
   */
  _tryActivePush(sessionId, text) {
    if (this.config.bridge?.enableActivePush === false) {
      this.log(`[push] 主动推送已禁用（bridge.enableActivePush=false），跳过 session=${sessionId}`);
      return false;
    }
    // 候选 conversation：精确 match 优先；否则兜底历史 match
    const exact = [];
    const historical = [];
    for (const [convId, entry] of this.mapper.entries()) {
      if (!entry) continue;
      if (entry.activeSessionId === sessionId) {
        exact.push(convId);
      } else if (entry.sessions && Object.prototype.hasOwnProperty.call(entry.sessions, sessionId)) {
        historical.push(convId);
      }
    }
    const candidates = exact.length > 0 ? exact : historical;
    // 仅当唯一目标明确时才推（避免群聊/多会话歧义）
    if (candidates.length === 0) return false;
    if (candidates.length > 1) {
      this.log(`[push] 多个 conversation 可匹配 session=${sessionId}（${candidates.length}个），跳过避免误推`);
      return false;
    }
    const convId = candidates[0];
    const webhook = this.mapper.getWebhook(convId);
    if (!webhook) {
      this.log(`[push] conv=${convId} 无持久 webhook（该会话尚未给过回调），跳过主动推送`);
      return false;
    }
    // 用持久 webhook 构造最小 msg（dingtalk.reply 只认 sessionWebhook）
    const msg = { conversationId: convId, sessionWebhook: webhook };
    const body = this._formatActivePush(text);
    this._replyText(msg, body).catch((err) => {
      this.log(`[push] 主动推送失败 conv=${convId}: ${err?.message || err}`);
    });
    return true;
  }

  /** 主动推送的文本格式化（加醒目前缀，区分于普通回复）。 */
  _formatActivePush(text) {
    const pushed = this.config.bridge?.activePushPrefix || '📨 来自 Agent 的主动消息';
    const cleaned = this._collapseBlankLines(text);
    return `${pushed}\n${cleaned}`;
  }

  _sentSeq = new Set();

  _formatReply(text) {
    const prefix = this.config.bridge?.replyPrefix || '';
    const cleaned = this._collapseBlankLines(text);
    return prefix ? `${prefix}\n${cleaned}` : cleaned;
  }

  /** 压缩回复中过长的空行段（LLM 输出常见）。 */
  _collapseBlankLines(text) {
    const max = this.config.bridge?.maxBlankLines ?? 2;
    const lines = text.split('\n');
    const acc = [];
    for (const line of lines) {
      const isBlank = line.trim() === '';
      if (isBlank && acc.length > 0) {
        // 统计 acc 尾部连续空行数
        let blanks = 0;
        for (let i = acc.length - 1; i >= 0 && acc[i] === ''; i--) blanks++;
        if (blanks >= max) continue; // 超过上限则丢弃该空行
      }
      acc.push(line);
    }
    return acc.join('\n');
  }

  /** 把文本发回钉钉会话（通过消息携带的 sessionWebhook）。 */
  async _replyText(msg, text) {
    if (!text) return;
    await this.dingtalk.reply(msg, text);
  }
}
