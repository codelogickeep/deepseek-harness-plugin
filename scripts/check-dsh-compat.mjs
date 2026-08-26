#!/usr/bin/env node
/**
 * check-dsh-compat.mjs — DSH 宿主 API wire 契约「升级适配」检查脚手架
 *
 * 在升级 DSH（或怀疑协议漂移）后，把本项目桥接器实际发送的请求 payload
 * 与宿主当前真实声明的 API schema 做对比，提前暴露：
 *   - payload 使用了宿主 schema 不认识的字段（zod 默认 strip → 静默丢弃）
 *   - 必须字段缺失（host 新增了必填字段，我们没发）
 *   - 宿主 schema 不可用（host 升级后 schema 模块路径/形状变化）
 *
 * 方法存在性由 schema 模块能否加载到对应 RequestSchema 间接覆盖——
 * 若某方法在宿主已删除/改名，其 RequestSchema 键会缺失，脚本会以
 * 「宿主 schema 不可用」报告该方法。
 *
 * 为什么需要：zod 的 `.parse()` 默认会在**边界 strip 未知字段**——我们发
 * 一个 host 不认识的字段不会报错，只会被静默忽略（上一轮的 `limit` vs
 * `maxMessages` 正是这种事故）。只有拿宿主真实 schema 对照才能发现。
 *
 * 与真实 DSH 的保真度：schema 直接从宿主依赖根（~/.dsh/profiles 锚点）
 * 动态 import 真实的 @deepseek-ai/dsh-host-apiproxy 的 schema 模块
 * （与 scripts/check-plugin.mjs 加载真实 dsh-tools 同一技巧）。
 *
 * 用法：
 *   node scripts/check-dsh-compat.mjs          # 全量检查并输出报告
 *   node scripts/check-dsh-compat.mjs --json   # 输出 JSON 报告（便于脚本消费）
 *   node scripts/check-dsh-compat.mjs --only session.history   # 只看某个方法
 *   node scripts/check-dsh-compat.mjs --strict-scan  # 额外交叉校验源码字面量（低优先提示）
 *
 * 返回码：0=当前宿主契约全部兼容；1=检测到破坏性差异。
 * 解析不到宿主 schema 时给出警告并返回 2（非阻断，但需人工确认）。
 *
 * 字段对比以 EXPECTED_CALLS（下方权威声明）为准；`--strict-scan` 的源码
 * 扫描仅作防漏同步提示——变量构造/条件字段（如 payload.xxx = ...）可合法
 * 产生"声明未在字面量中找见"或"字面量多出"的噪音，故默认关闭。
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const PROFILE_ROOT = join(DSH_HOME, 'profiles');

// ---------------------------------------------------------------------------
// 宿主 schema 定位
// ---------------------------------------------------------------------------

const HOST_ANCHORS = [PROFILE_ROOT, join(PROFILE_ROOT, 'web')];

/** 解析宿主依赖根下的一个包入口（resolve 到真实文件路径）。 */
function resolveHostPath(spec) {
  for (const anchor of HOST_ANCHORS) {
    try {
      const req = createRequire(resolve(anchor, '__probe__.cjs'));
      return req.resolve(spec); // 返回文件系统绝对路径
    } catch { /* try next anchor */ }
  }
  return null;
}

/**
 * 加载宿主 API schema 模块（dsh-host-apiproxy/api/*.schema.js）。
 * 解析不到时回退：仅内置轻量契约（方法名存在性检查），字段级检查不可用。
 */
async function loadHostSchemas() {
  const apiproxyPkg = resolveHostPath('@deepseek-ai/dsh-host-apiproxy/package.json');
  if (!apiproxyPkg) {
    return { schemas: null, sessionModules: null, workspaceModules: null, version: null, source: null };
  }
  const pkgDir = dirname(apiproxyPkg);
  const schemaDir = join(pkgDir, 'lib', 'types', 'api');
  // 宿主包版本（可通过全局 dsh 的依赖清单判断，这里取 apiproxy 自身版本）
  let version = null;
  try { version = JSON.parse(readFileSync(apiproxyPkg, 'utf8')).version; } catch {}
  if (!existsSync(schemaDir)) return { schemas: null, sessionModules: null, workspaceModules: null, version, source: null };

  let sessionModules = null;
  let workspaceModules = null;
  try {
    sessionModules = await import(pathToFileURL(join(schemaDir, 'sessions.schema.js')).href);
  } catch (e) {
    console.warn(`⚠️  加载 session schema 失败：${e.message}`);
  }
  try {
    workspaceModules = await import(pathToFileURL(join(schemaDir, 'workspace.schema.js')).href);
  } catch (e) {
    console.warn(`⚠️  加载 workspace schema 失败：${e.message}`);
  }
  return { schemas: true, sessionModules, workspaceModules, version, source: pkgDir };
}

// ---------------------------------------------------------------------------
// 项目期望的 wire 契约（唯一真相源 = 桥接器实际发送的调用）
//  —— 若桥接器新增/修改调用，需同步更新这里（脚本提示会协助发现漏改）
// ---------------------------------------------------------------------------

/**
 * `方法名 → 项目实际发送的 payload 字段`。
 * 值：
 *   string[]                      = 发送的顶层字段（undefined 值不发送，不算）
 *   { include: string[] }         = 字段 + 额外说明
 * 这些字段与宿主 schema 的 shape 键做对比：
 *   - 发送了 host 不认识的字段   → break（会被 strip 静默丢弃）
 *   - 发送了 host 必填但缺的字段 → break（host 会拒绝请求）
 */
const EXPECTED_CALLS = {
  'session.list': {
    fields: [],
    note: '分页游标（cursor）宿主已预留但 v1 未实现',
  },
  'session.create': {
    fields: ['sessionId', 'cwd', 'agentPreset'],
    note: 'sessionId/cwd 二选一或都填；宿主要么接受要么清确认',
  },
  'session.rename': {
    fields: ['sessionId', 'title'],
  },
  'session.history': {
    fields: ['sessionId', 'beforeSeq', 'maxMessages'],
    note: '字段以宿主 sessionHistoryRequestSchema 为准（曾用 limit→maxMessages 修正）',
  },
  'session.prompt': {
    fields: ['sessionId', 'mode', 'content'],
    note: 'content 为 [{type:"text",text}]；mode 为 queue/steer；clientTimeZone 为宿主可选字段（当前未发送，用默认）',
  },
  'workspace.list': {
    fields: [],
  },
};

// ---------------------------------------------------------------------------
// 源码扫描：找出实际发送的字段（防 EXPECTED_CALLS 与源码漏同步）
// ---------------------------------------------------------------------------

/** 从源码收集 `callResult('method', { ... })` / `call('method', { ... })` 的字面字段。 */
function collectSourceFields() {
  const collected = {}; // method -> Set<field>
  collectIn(join(REPO_ROOT, 'src'), collected);
  collectIn(join(REPO_ROOT, 'tools'), collected);
  return collected;
}

function collectIn(dir, collected) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      collectIn(p, collected);
    } else if (e.isFile() && /\.(js|mjs)$/.test(e.name)) {
      collectSourceFile(p, collected);
    }
  }
}

function collectSourceFile(file, collected) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  // 匹配 callResult('method', {...}) / call('method', {...})：取整个对象字面量（括号配平）
  const callRe = /\b(?:callResult|call)\('([a-z]+\.[a-z]+)['"]\s*,\s*\{/g;
  let m;
  while ((m = callRe.exec(text)) !== null) {
    const method = m[1];
    const start = m.index + m[0].length - 1; // 对象 '{' 的位置
    // 括号配平 + 跳过字符串/模板字面量
    let depth = 1, end = -1;
    let inStr = null;
    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;
    // 包含结尾 '}'（否则简写属性最后一项 next 读到末尾为 undefined）
    const body = text.slice(start + 1, end + 1);
    if (!collected[method]) collected[method] = new Set();
    // 收集「深度 = 1」的 key（紧贴对象体）：扫描字符，记录当前深度，遇到 `name:` 或简写 `name,`/`name}` 收集
    let d = 0, inStr2 = null;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (inStr2) {
        if (ch === '\\') { i++; continue; }
        if (ch === inStr2) inStr2 = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr2 = ch; continue; }
      if (ch === '{') { d++; continue; }
      if (ch === '}') { d--; continue; }
      if (d === 0 && /[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < body.length && /[A-Za-z0-9_$]/.test(body[j])) j++;
        const ident = body.slice(i, j);
        let k = j;
        while (k < body.length && /\s/.test(body[k])) k++;
        const next = body[k];
        // `key:`（值形式）或 `key}` / `key,`（简写属性）
        if (next === ':' || next === '}' || next === ',') collected[method].add(ident);
        i = j - 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 检查逻辑
// ---------------------------------------------------------------------------

function zodSchemaShape(schema) {
  // zod v3 object：`.shape`；v4 下也可能有 `.shape`
  return (schema && typeof schema.shape === 'object' && schema.shape) || null;
}

/** 对比一个方法的期望字段与宿主 schema 字段。 */
function checkMethod(method, expected, hostSchema, sourceFields) {
  const report = {
    method,
    hostKnown: !!hostSchema,
    knownFields: hostSchema ? Object.keys(zodSchemaShape(hostSchema) || {}) : null,
    requiredFields: hostSchema ? Object.keys(zodSchemaShape(hostSchema) || {})
      .filter((k) => hostSchema.shape[k] && hostSchema.shape[k].isOptional && !hostSchema.shape[k].isOptional()) : null,
    expectedFields: expected?.fields ?? [],
    note: expected?.note ?? null,
    sourceFields: sourceFields ? [...sourceFields].sort() : null,
    issues: [],
    notes: [],
  };
  const expectedFields = report.expectedFields;

  if (!hostSchema) {
    report.issues.push('宿主 schema 不可用（无法做字段级校验）');
    return report;
  }
  const known = new Set(report.knownFields);
  const required = new Set(report.requiredFields);

  // 1) 发送了 host 不认识的字段 → 破坏（会被 strip）
  for (const f of expectedFields) {
    if (!known.has(f)) {
      report.issues.push(`发送的字段 "${f}" 宿主 schema 不认识（会被静默 strip 丢弃）`);
    }
  }
  // 2) 宿主要求但项目没发 → 破坏（请求会被拒 / 语义变化）
  for (const f of required) {
    if (!expectedFields.includes(f)) {
      if (f === 'sessionId' && method === 'session.list') continue; // session.list 不需要
      report.issues.push(`宿主要求必填字段 "${f}" 未在项目 payload 中`);
    }
  }
  // 3) 源码实际发送的字段与声明不一致 → 提示（防止漏同步 EXPECTED_CALLS）
  //    只报「源码字面量发出但未声明」（防漏同步）；不报「声明但未找见」——
  //    后者可能是变量构造/条件字段等合法写法，噪音大于价值。
  if (sourceFields) {
    const declared = new Set(expectedFields);
    const extra = sourceFields.filter((f) => !declared.has(f));
    if (extra.length) {
      report.notes.push(`源码还发送了未声明的字段：${extra.join(', ')}（若为真使用请补进 EXPECTED_CALLS）`);
    }
  }
  return report;
}

function formatReport(reports, meta, opts) {
  const lines = [];
  const ver = meta.hostVersion ? `（apiproxy ${meta.hostVersion}）` : '';
  lines.push(`DSH API 契约检查${ver}`);
  lines.push(`schema 来源: ${meta.source || '未找到宿主 schema（降级为存在性检查）'}`);
  lines.push('');
  const issues = [];
  for (const r of reports) {
    const mark = r.hostKnown ? (r.issues.length ? '✗' : '✓') : '?';
    lines.push(`${mark} ${r.method}`);
    if (r.hostKnown) {
      lines.push(`   已知字段: ${r.knownFields.join(', ') || '(空对象)'}`);
      if (r.requiredFields?.length) lines.push(`   必填字段: ${r.requiredFields.join(', ')}`);
    } else {
      lines.push(`   (宿主 schema 不可用)`);
    }
    if (r.expectedFields?.length) lines.push(`   项目发送: ${r.expectedFields.join(', ')}`);
    if (r.note) lines.push(`   ℹ️  说明: ${r.note}`);
    for (const i of r.issues) { lines.push(`   ⚠️  ${i}`); issues.push(r.method + ': ' + i); }
    for (const n of r.notes) lines.push(`   ℹ️  ${n}`);
    lines.push('');
  }
  const summary = issues.length
    ? `发现 ${issues.length} 处破坏性差异,请修复后再重启/部署。`
    : '宿主当前契约全部兼容 ✓';
  lines.push(summary);
  const out = lines.join('\n');
  if (opts.json) {
    return JSON.stringify({ meta, reports, compatible: issues.length === 0, issues }, null, 2);
  }
  return out + (issues.length ? `\n细节:\n  - ${issues.join('\n  - ')}` : '');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes('--json');
  const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  const strictScan = args.includes('--strict-scan') || args.includes('--scan');

  const { schemas, sessionModules, workspaceModules, version, source } = await loadHostSchemas();
  const meta = {
    hostVersion: version,
    source: source || null,
    loaded: schemas === null ? false : true,
  };
  if (schemas === null) {
    console.warn('⚠️  未找到宿主 @deepseek-ai/dsh-host-apiproxy schema，字段级检查不可用。');
    console.warn('   请确认已安装 DSH 0.1.1-rc.2+ 且 ~/.dsh/profiles 存在。');
    process.exit(2);
  }

  // 方法名 → schema 模块/键
  const sessionSchemaKeys = {
    'session.list': 'sessionListRequestSchema',
    'session.create': 'sessionCreateRequestSchema',
    'session.rename': 'sessionRenameRequestSchema',
    'session.history': 'sessionHistoryRequestSchema',
    'session.prompt': 'sessionPromptRequestSchema',
  };
  const workspaceSchemaKeys = {
    'workspace.list': 'workspaceListRequestSchema',
  };

  const sourceFields = strictScan ? collectSourceFields() : null;

  const reports = [];
  for (const [method, expected] of Object.entries(EXPECTED_CALLS)) {
    if (only && method !== only) continue;
    const sessionKey = sessionSchemaKeys[method];
    const workspaceKey = workspaceSchemaKeys[method];
    const mod = sessionKey ? sessionModules : (workspaceKey ? workspaceModules : null);
    const key = sessionKey || workspaceKey;
    const hostSchema = mod?.[key] ?? null;
    const src = (sourceFields && sourceFields[method]) ? [...sourceFields[method]] : null;
    reports.push(checkMethod(method, expected, hostSchema, src));
  }

  const text = formatReport(reports, meta, { json: wantJson });
  console.log(text);
  const hasIssues = reports.some((r) => r.issues.length > 0);
  process.exit(hasIssues ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
