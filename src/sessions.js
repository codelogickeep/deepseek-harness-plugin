/**
 * sessions.js
 *
 * 钉钉会话 ↔ DSH 会话 映射（升级版：会话管理控制台）。
 *
 * 每个钉钉会话（conversationId，单聊/群聊都有独立 id）持有：
 *   - activeSessionId: 当前投递目标（/use 切换、/new 新建后更新）
 *   - sessions: 该钉钉会话用过的 DSH 会话历史（keys = dshSessionId）
 *     —— 让 /use 切回原会话时能续聊（DSH 持久化历史仍在）
 *
 * 映射持久化到 data/session-mapping.json，重启后恢复。
 * 兼容旧格式 { dshSessionId, createdAt }：加载时自动迁移到新结构。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class SessionMapper {
  /**
   * @param {object} opts
   * @param {string} opts.file      映射存储文件
   * @param {(line:string)=>void} [opts.log]
   */
  constructor(opts) {
    this.file = opts.file;
    this.log = opts.log || ((line) => console.log(`[mapping] ${line}`));
    /** conversationId -> { activeSessionId, sessions: Record<dshSessionId, {lastUsedAt}> } */
    this.map = new Map();
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    let migrated = false;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (!v || typeof v !== 'object') continue;
          if (v.activeSessionId) {
            // 新版格式
            this.map.set(k, {
              activeSessionId: v.activeSessionId,
              sessions: (v.sessions && typeof v.sessions === 'object') ? v.sessions : {},
            });
          } else if (v.dshSessionId) {
            // 旧版格式：迁移
            migrated = true;
            this.map.set(k, {
              activeSessionId: v.dshSessionId,
              sessions: { [v.dshSessionId]: { lastUsedAt: v.createdAt || Date.now() } },
            });
          }
        }
      }
      this.log(`loaded ${this.map.size} mapping(s) from ${this.file}`);
    } catch (err) {
      this.log(`load ${this.file} failed: ${err.message}`);
    }
    // 旧格式迁移后立即落盘新格式，避免磁盘永远停留旧结构
    if (migrated) this._save();
  }

  _save() {
    try {
      const obj = Object.fromEntries(this.map.entries());
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o755 });
      writeFileSync(this.file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    } catch (err) {
      this.log(`save ${this.file} failed: ${err.message}`);
    }
  }

  has(conversationId) {
    return this.map.has(conversationId);
  }

  /** 获取该钉钉会话的当前投递目标 DSH 会话 id。 */
  getActive(conversationId) {
    const entry = this.map.get(conversationId);
    return entry?.activeSessionId || null;
  }

  /** 获取该钉钉会话的完整上下文对象（无则 null）。 */
  getContext(conversationId) {
    return this.map.get(conversationId) || null;
  }

  /** 该钉钉会话用过的所有 DSH 会话 id（数组）。 */
  listSessions(conversationId) {
    const entry = this.map.get(conversationId);
    return entry ? Object.keys(entry.sessions || {}) : [];
  }

  /**
   * 设置/切换当前投递目标。
   * 把 dshSessionId 标记为该钉钉会话的 active，并记入历史 sessions。
   */
  setActive(conversationId, dshSessionId, { keepHistory = true } = {}) {
    let entry = this.map.get(conversationId);
    if (!entry) {
      entry = { activeSessionId: dshSessionId, sessions: {} };
      this.map.set(conversationId, entry);
    }
    entry.activeSessionId = dshSessionId;
    if (keepHistory) {
      entry.sessions = entry.sessions || {};
      entry.sessions[dshSessionId] = { lastUsedAt: Date.now() };
    }
    this._save();
    this.log(`setActive ${conversationId} -> ${dshSessionId}`);
    return dshSessionId;
  }

  /** 兼容旧调用的别名：setActive 的强绑定版本（保留历史，因为要支持续聊）。 */
  set(conversationId, dshSessionId) {
    return this.setActive(conversationId, dshSessionId, { keepHistory: true });
  }

  /** 列出所有映射。 */
  entries() {
    return [...this.map.entries()];
  }
}
