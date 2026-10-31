/**
 * 画布交付导出（ROADMAP Phase 1 / KR4）—— 把当前画布导出为**单个自包含 HTML 文件**。
 *
 * 交付物形态（双击离线可打开）：
 * - 内联 `<style>`，无外部脚本/字体/图片/CDN 引用（样式见 `export-report-style.ts`）
 * - 报头与摘要（含漂移告警）→ 血缘连线图（内联 SVG）→ 五类节点卡片静态快照
 *   → 附录 A（每个 dataFrame 节点的 Analysis Manifest，含 permissionDecisionId）
 *   → 附录 B（与画布节点关联的权限确认记录）
 *
 * 数据来源纪律（任务范围）：**只消费画布 store 已有的节点数据**（结构、SQL、Manifest、
 * 复跑记录）+ 一个只读审计通道（`GET /api/permission-audit`，仅当前会话的 sidecar）。
 * 不读 parquet、不调 govio-cli、不调模型，因此导出文件里**没有任何数据行内容**：
 * dataFrame 只导出列名与 dtype，图表只导出「导出时刻用节点已有 Plotly 配置渲染的静态图像」。
 *
 * 结构：本文件上半部分是**纯函数**（`buildDeliveryReportHtml` 及其渲染器，可在 Node 里
 * 直接跑，`scripts/verify-export-report.ts` 用它构造样例画布并断言产物）；下半部分是
 * 浏览器侧副作用（Plotly 静态渲染、审计只读拉取、Blob 下载），由 `CanvasToolbar`
 * 动态 import，不进主 bundle。
 */
import type { Edge, Node } from '@xyflow/react';
import type {
  AnalysisManifest,
  ChartConfig,
  ChartNodeData,
  ChartTrace,
  DataFrameNodeData,
  NodeType,
  ReportNodeData,
  RerunRecord,
  SourceTableNodeData,
  SQLQueryNodeData,
  TableField,
} from '../types';
import { RERUN_OUTCOME_LABELS, formatRerunTime, hasDrift, latestRerun } from './rerun';
import { manifestModelLabel, manifestOriginLabel } from './manifest-labels';
import { REPORT_CSS } from './export-report-style';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

/** 节点类型 → 卡片左边框 / 血缘图盒子的颜色（与画布 MiniMap、节点组件同值） */
export const NODE_COLORS: Record<NodeType, string> = {
  sourceTable: 'hsl(270, 60%, 60%)',
  sqlQuery: 'hsl(152, 58%, 52%)',
  dataFrame: 'hsl(25, 75%, 55%)',
  report: 'hsl(270, 60%, 70%)',
  chart: 'hsl(200, 70%, 55%)',
};

/** 节点类型 → 中文标签 */
export const NODE_LABELS: Record<NodeType, string> = {
  sourceTable: '数据源表',
  sqlQuery: 'SQL 查询',
  dataFrame: 'DataFrame',
  report: '分析报告',
  chart: '图表',
};

/** report 节点的类型标签（配色沿用 ReportNode：diff 用 warning，correlation 用浅紫） */
const REPORT_TYPE_LABELS: Record<string, string> = {
  diff: '差异对比',
  correlation: '相关性分析',
};

/** 血缘示意图的格子尺寸（与画布上卡片的真实尺寸无关，只求层次可读） */
const LINEAGE = { boxW: 210, boxH: 52, gapX: 96, gapY: 26, pad: 20 } as const;

/** 导出时 Plotly 静态渲染的画布尺寸（px） */
export const CHART_RENDER = { width: 680, height: 400 } as const;

/** 附录里表格类内容的行数上限：结构信息通常远小于此，只为兜住异常大的表 */
const MAX_TABLE_ROWS = 200;

/** 图表静态渲染结果：成功给内联 data URL，失败给原因（卡片降级为配置摘要） */
export interface ChartRenderResult {
  ok: boolean;
  /** 成功时的内联图片（`data:image/svg+xml;base64,...` 或 png） */
  dataUrl?: string;
  width?: number;
  height?: number;
  /** 失败原因（渲染异常、Plotly 不可用、配置无效等） */
  reason?: string;
}

/** nodeId → 图表渲染结果 */
export type ChartRenderMap = Record<string, ChartRenderResult>;

/**
 * 权限确认记录的**前端视图**（附录 B 用）。
 *
 * 线格式的真源是 `server/permission-audit.ts`（`PermissionAuditEntry`）。这里不直接
 * import 服务端类型：那会让 `src/` 反向依赖 `server/`（把 `node:fs` 拖进 app 的
 * tsconfig），而 HTTP JSON 本来就需要在边界上校验一次（版本错配、坏行、字段缺失）。
 * 因此用 `parseAuditEntries()` 按白名单挑字段，未知字段丢弃、缺失字段留空。
 */
export interface AuditEntryView {
  /** 记录类型：`permission_request` / `permission_decision` / `permission_mode`（未知值原样保留） */
  type: string;
  at: string;
  decisionId: string;
  sessionId?: string;
  command?: string;
  editedCommand?: string;
  reason?: string;
  decision?: string;
  source?: string;
  gate?: string;
  followsDecisionId?: string;
  elapsedMs?: number;
  v?: number;
  acceptAll?: boolean;
  pendingAffected?: number;
}

/** 附录 B 的输入：审计通道可用性 + 带出的记录 */
export interface AuditAppendix {
  /** 是否成功读到审计 sidecar（false 时 `reason` 说明为什么没有记录） */
  available: boolean;
  /** 不可用 / 无记录的原因，直接渲染进报告，不静默省略 */
  reason?: string;
  sessionId?: string;
  /** 审计 sidecar 路径（`<session-file>.audit.jsonl` 的主体），写进报告以便质证；渲染时只取 basename（不外泄操作者本机目录结构） */
  sessionFile?: string;
  /** 本次请求过滤用的 decisionId（来自画布节点的 Manifest） */
  requestedDecisionIds: string[];
  /** 服务端实际参与过滤的 decisionId 数（截断前）；缺失时退回 requestedDecisionIds.length */
  serverRequested?: number;
  /** 服务端因上限（200 个，见 parquet-api.ts MAX_AUDIT_DECISION_IDS）发生截断时为 true，报告必须如实告知 */
  truncated?: boolean;
  /** 会话审计里的记录总数（未过滤时等于 entries.length） */
  totalInSession?: number;
  entries: AuditEntryView[];
}

/** `buildDeliveryReportHtml` 的输入（纯数据，不含任何运行时依赖） */
export interface DeliveryReportInput {
  nodes: Node[];
  edges: Edge[];
  /** ISO 8601 导出时间；由调用方给定，保证同一输入产出同一份 HTML（可复现） */
  exportedAt: string;
  appVersion?: string;
  title?: string;
  /** 图表静态渲染结果；缺省的图表节点降级为配置摘要 */
  chartResults?: ChartRenderMap;
  /** 附录 B 输入；null = 未尝试获取（例如非浏览器环境） */
  audit?: AuditAppendix | null;
}

/** `exportCanvasDeliveryReport` 的结果（工具栏用来提示用户） */
export interface ExportOutcome {
  fileName: string;
  bytes: number;
  nodeCount: number;
  chartImageCount: number;
  audit: AuditAppendix | null;
}

// ---------------------------------------------------------------------------
// 纯工具：转义 / 格式化
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * HTML 转义（文本与属性共用）。**所有**来自节点/审计的字符串都必须过这里：
 * SQL、报告正文、表名、命令原文都是外部内容，未转义就等于把画布内容当代码执行。
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** 截断长文本（先截断再转义，避免把实体切断） */
export function truncate(text: string, max: number): string {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/** 千分位（手写而不用 `toLocaleString`：导出产物要跨环境逐字节可复现） */
export function groupDigits(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n ?? '—');
  const [int, dec] = String(n).split('.');
  const grouped = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${grouped}.${dec}` : grouped;
}

/** `2026-10-31 00:45:16`（本地时区）；非法/缺失时间原样返回或 `—` */
export function formatTimestamp(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 耗时：`3.2s` / `820ms` */
function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * 审计 sidecar 的展示名：只取 basename。
 * 交付报告会发给其他人，服务端返回的 sessionFile 是本机绝对路径，
 * 原样渲染会外泄操作者的目录结构（含用户名）；质证只需文件名可对应。
 */
export function auditSidecarLabel(sessionFile: string): string {
  const base = String(sessionFile ?? '').split(/[\\/]/).pop() || String(sessionFile ?? '');
  return `${base}.audit.jsonl`;
}

function dataOf<T>(node: Node): T {
  return node.data as unknown as T;
}

const KNOWN_NODE_TYPES: NodeType[] = ['sourceTable', 'sqlQuery', 'dataFrame', 'report', 'chart'];

/** 节点类型：优先 `data.type`（store 一定会写），退回 ReactFlow 的 `node.type` */
export function nodeKind(node: Node): NodeType {
  const fromData = (node.data as { type?: string } | undefined)?.type;
  const candidate = (KNOWN_NODE_TYPES as string[]).includes(fromData ?? '')
    ? fromData
    : node.type;
  return (KNOWN_NODE_TYPES as string[]).includes(candidate ?? '')
    ? (candidate as NodeType)
    // 未知类型按 dataFrame 渲染：字段读取全部带默认值，只会显示空结构，不会抛错
    : 'dataFrame';
}

/** 卡片标题：title → dfName/tableName → 节点 ID */
export function nodeTitle(node: Node): string {
  const d = node.data as { title?: string; dfName?: string; tableName?: string } | undefined;
  return d?.title || d?.dfName || d?.tableName || node.id;
}

/** 卡片左侧强调色：report 按 reportType 分色，其余按节点类型 */
export function accentOf(node: Node): string {
  const kind = nodeKind(node);
  if (kind === 'report') {
    return dataOf<ReportNodeData>(node).reportType === 'diff' ? '#f59b23' : NODE_COLORS.report;
  }
  return NODE_COLORS[kind];
}

// ---------------------------------------------------------------------------
// 血缘图：简化层次布局（不复用 ReactFlow 运行时）
// ---------------------------------------------------------------------------

export interface LineageBox {
  id: string;
  label: string;
  typeLabel: string;
  color: string;
  level: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LineageEdgeView {
  id: string;
  source: string;
  target: string;
  /** 三次贝塞尔路径（源盒子右侧中点 → 目标盒子左侧中点） */
  path: string;
}

export interface LineageLayout {
  boxes: LineageBox[];
  edges: LineageEdgeView[];
  width: number;
  height: number;
  /** 阅读顺序：层次优先、同层按画布插入顺序。节点卡片章节沿用这个顺序 */
  order: string[];
  /** 被丢弃的边（端点不在画布里 / 自环），报告里如实说明 */
  droppedEdges: number;
}

/**
 * 按「最长路径层次」把节点排成从左到右的列，同层按画布顺序纵向排列。
 *
 * 取舍：不复用 `@dagrejs/dagre`（画布自动布局用它），也不复用 ReactFlow——导出是
 * 一次性静态渲染，几十行确定性布局换来「产物不依赖任何运行时库」，也便于验证脚本
 * 在 Node 里直接断言坐标。环（画布上可以画出来）用 visiting 集合断开，不会死递归。
 */
export function layoutLineage(nodes: Node[], edges: Edge[]): LineageLayout {
  const list = Array.isArray(nodes) ? nodes : [];
  const ids = new Set(list.map((n) => n.id));
  const rawEdges = Array.isArray(edges) ? edges : [];
  const live = rawEdges.filter(
    (e) => e && ids.has(e.source) && ids.has(e.target) && e.source !== e.target,
  );
  const droppedEdges = rawEdges.length - live.length;

  const parents = new Map<string, string[]>();
  for (const e of live) {
    const arr = parents.get(e.target) ?? [];
    arr.push(e.source);
    parents.set(e.target, arr);
  }

  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = level.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // 环：断开，本层记为 0
    visiting.add(id);
    const ps = parents.get(id) ?? [];
    const depth = ps.length === 0 ? 0 : 1 + Math.max(...ps.map(depthOf));
    visiting.delete(id);
    level.set(id, depth);
    return depth;
  };
  for (const n of list) depthOf(n.id);

  const byLevel = new Map<number, Node[]>();
  for (const n of list) {
    const l = level.get(n.id) ?? 0;
    const arr = byLevel.get(l) ?? [];
    arr.push(n);
    byLevel.set(l, arr);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);

  const boxes: LineageBox[] = [];
  const order: string[] = [];
  let maxRows = 1;
  levels.forEach((l, col) => {
    const row = byLevel.get(l) ?? [];
    maxRows = Math.max(maxRows, row.length);
    row.forEach((n, i) => {
      const kind = nodeKind(n);
      boxes.push({
        id: n.id,
        label: nodeTitle(n),
        typeLabel: NODE_LABELS[kind],
        color: accentOf(n),
        level: l,
        x: LINEAGE.pad + col * (LINEAGE.boxW + LINEAGE.gapX),
        y: LINEAGE.pad + i * (LINEAGE.boxH + LINEAGE.gapY),
        width: LINEAGE.boxW,
        height: LINEAGE.boxH,
      });
      order.push(n.id);
    });
  });

  const boxById = new Map(boxes.map((b) => [b.id, b]));
  const lineageEdges: LineageEdgeView[] = [];
  for (const e of live) {
    const s = boxById.get(e.source);
    const t = boxById.get(e.target);
    if (!s || !t) continue;
    lineageEdges.push({
      id: e.id || `${e.source}->${e.target}`,
      source: e.source,
      target: e.target,
      path: edgePath(s, t),
    });
  }

  const cols = Math.max(1, levels.length);
  return {
    boxes,
    edges: lineageEdges,
    order,
    droppedEdges,
    width: LINEAGE.pad * 2 + cols * LINEAGE.boxW + (cols - 1) * LINEAGE.gapX,
    height: LINEAGE.pad * 2 + maxRows * LINEAGE.boxH + (maxRows - 1) * LINEAGE.gapY,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function edgePath(s: LineageBox, t: LineageBox): string {
  const x1 = s.x + s.width;
  const y1 = s.y + s.height / 2;
  const x2 = t.x;
  const y2 = t.y + t.height / 2;
  const dx = Math.max(28, Math.abs(x2 - x1) * 0.45);
  return `M ${round1(x1)} ${round1(y1)} C ${round1(x1 + dx)} ${round1(y1)}, ${round1(x2 - dx)} ${round1(y2)}, ${round1(x2)} ${round1(y2)}`;
}

/** 血缘图 SVG（内联，节点盒子可点击跳到对应卡片） */
export function lineageSvg(layout: LineageLayout): string {
  const parts: string[] = [
    `<svg class="lineage" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" ` +
      `role="img" aria-label="画布血缘连线图">`,
    `<defs><marker id="govio-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M0,0 L10,5 L0,10 z" fill="#1db954"/></marker></defs>`,
  ];
  for (const e of layout.edges) {
    parts.push(
      `<path d="${e.path}" fill="none" stroke="#1db954" stroke-width="1.6" marker-end="url(#govio-arrow)">` +
        `<title>${esc(e.source)} → ${esc(e.target)}</title></path>`,
    );
  }
  for (const b of layout.boxes) {
    const anchor = `#card-${esc(b.id)}`;
    parts.push(
      `<a href="${anchor}" xlink:href="${anchor}"><g transform="translate(${b.x},${b.y})">` +
        `<rect class="box" width="${b.width}" height="${b.height}" rx="7" fill="#ffffff" stroke="#d4d4d4"/>` +
        `<rect width="4" height="${b.height}" rx="2" fill="${esc(b.color)}"/>` +
        `<text class="lt" x="14" y="22">${esc(truncate(b.label, 26))}</text>` +
        `<text class="ls" x="14" y="39">${esc(b.typeLabel)} · ${esc(truncate(b.id, 22))}</text>` +
        `</g></a>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// 渲染：小部件
// ---------------------------------------------------------------------------

function kv(rows: Array<[string, string]>): string {
  const body = rows
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`) // v 由调用方负责转义（可能含链接）
    .join('');
  return `<dl class="kv">${body}</dl>`;
}

function label(text: string): string {
  return `<div class="lbl">${esc(text)}</div>`;
}

function chips(items: string[]): string {
  if (!items.length) return '';
  return `<div class="chips">${items.map((i) => `<span class="chip">${esc(i)}</span>`).join('')}</div>`;
}

function badge(text: string, cls = '', color = ''): string {
  const style = color ? ` style="border-color:${esc(color)};color:${esc(color)}"` : '';
  return `<span class="badge${cls ? ` ${cls}` : ''}"${style}>${esc(text)}</span>`;
}

function codeBlock(text: string, cls = 'sql'): string {
  return `<pre class="${cls}">${esc(text)}</pre>`;
}

/** 长文本单元格：短的直接 `<pre>`，长的折进 `<details>`（表格不会被一条长 SQL 撑爆） */
function codeCell(text: string, limit = 160): string {
  const s = String(text ?? '');
  if (!s) return '<span class="note">—</span>';
  if (s.length <= limit) return codeBlock(s, 'sql sm');
  return `<details><summary>${esc(truncate(s.replace(/\s+/g, ' '), limit))}（全文 ${groupDigits(s.length)} 字符）</summary>${codeBlock(s, 'sql sm')}</details>`;
}

function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return '<p class="note">（无）</p>';
  return `<table class="t"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/** 权限决策 ID 的展示：有对应审计记录时链到附录 B 的那一行 */
function permissionCell(manifest: AnalysisManifest | undefined, auditIds: Set<string>): string {
  if (!manifest) return '—';
  const id = manifest.permissionDecisionId;
  if (id === null) return '<span class="note">未过确认门</span>';
  if (!id) return '<span class="note">—（旧节点无此字段）</span>';
  return auditIds.has(id) ? `<a href="#audit-${esc(id)}">${esc(id)}</a>` : esc(id);
}

// ---------------------------------------------------------------------------
// 渲染：report 节点的极简 markdown（与 ReportNode 的解析子集对齐，输出 HTML）
// ---------------------------------------------------------------------------

function inlineMd(text: string): string {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 1;
}

/**
 * report 节点正文的静态渲染。
 *
 * 只覆盖 ReportNode 的 `parseMarkdown` 已支持的子集（`#`/`##`/`###` 标题、`-`/`*`/`1.`
 * 列表、`|` 表格、`**粗体**`、`` `code` ``），其余按段落输出。取舍：不在导出文件里
 * 内联 markdown 运行时（自包含 + 无脚本），也不复用 React 版解析器（它产出的是
 * ReactNode，不是字符串）——两边都只做「够读」的子集，报告正文由助手生成，格式稳定。
 */
export function renderReportMarkdown(content: string): string {
  const lines = String(content ?? '').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isTableRow(line)) {
      const block: string[] = [];
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        block.push(lines[i] ?? '');
        i++;
      }
      const cells = block.map((r) => r.trim().slice(1, -1).split('|').map((c) => c.trim()));
      const isSep = (row: string[]) => row.every((c) => /^:?-{2,}:?$/.test(c) || c === '');
      const headerIdx = cells.length > 1 && isSep(cells[1] ?? []) ? 0 : -1;
      const header = headerIdx === 0 ? (cells[0] ?? []) : [];
      const body = cells.slice(headerIdx === 0 ? 2 : 0).filter((r) => !isSep(r));
      const headHtml = header.length
        ? `<thead><tr>${header.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead>`
        : '';
      out.push(
        `<table class="t">${headHtml}<tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    if (line.startsWith('### ')) out.push(`<div class="h3">${inlineMd(line.slice(4))}</div>`);
    else if (line.startsWith('## ')) out.push(`<div class="h2">${inlineMd(line.slice(3))}</div>`);
    else if (line.startsWith('# ')) out.push(`<div class="h2">${inlineMd(line.slice(2))}</div>`);
    else if (/^\s*[-*]\s+/.test(line)) out.push(`<div class="li">• ${inlineMd(line.replace(/^\s*[-*]\s+/, ''))}</div>`);
    else if (/^\s*\d+\.\s+/.test(line)) out.push(`<div class="li">${inlineMd(line.trim())}</div>`);
    else if (line.trim() !== '') out.push(`<div class="p">${inlineMd(line)}</div>`);
    i++;
  }
  return `<div class="md">${out.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// 渲染：五类节点卡片
// ---------------------------------------------------------------------------

interface CardContext {
  nodesById: Map<string, Node>;
  upByNode: Map<string, string[]>;
  downByNode: Map<string, string[]>;
  chartResults: ChartRenderMap;
  /** 附录 B 里出现的 decisionId（决定卡片/附录 A 上的 ID 是否可点） */
  auditIds: Set<string>;
  /** 其中由全局放行（accept-all）自动批准的 decisionId：徽标要区分人工确认与系统代答 */
  autoApprovedIds: Set<string>;
}

function nodeLink(id: string, ctx: CardContext): string {
  const n = ctx.nodesById.get(id);
  return `<a href="#card-${esc(id)}">${esc(n ? truncate(nodeTitle(n), 24) : id)}</a>`;
}

function lineageFooter(node: Node, ctx: CardContext): string {
  const up = ctx.upByNode.get(node.id) ?? [];
  const down = ctx.downByNode.get(node.id) ?? [];
  if (!up.length && !down.length) return '';
  const rows: string[] = [];
  if (up.length) rows.push(`<div>上游：${up.map((id) => nodeLink(id, ctx)).join(' · ')}</div>`);
  if (down.length) rows.push(`<div>下游：${down.map((id) => nodeLink(id, ctx)).join(' · ')}</div>`);
  return `<div class="card-ft">${rows.join('')}</div>`;
}

function fieldKeyCell(field: TableField): string {
  const marks: string[] = [];
  if (field.isPrimaryKey) marks.push('PK');
  if (field.isForeignKey) {
    marks.push(field.references ? `FK→${field.references.table}.${field.references.field}` : 'FK');
  }
  return marks.length ? esc(marks.join(' ')) : '<span class="note">—</span>';
}

function sourceTableBody(d: SourceTableNodeData): string {
  const fields = Array.isArray(d.fields) ? d.fields : [];
  const shown = fields.slice(0, MAX_TABLE_ROWS);
  const rows = shown.map((f, i) => [
    String(i),
    esc(f.name),
    esc(f.type),
    f.nullable ? '是' : '否',
    fieldKeyCell(f),
    esc(f.description ?? ''),
  ]);
  const info: Array<[string, string]> = [
    ['表名', esc(d.tableName ?? d.title ?? '—')],
    ['数据源', esc(d.database || '—')],
    ['行数', typeof d.rowCount === 'number' ? esc(groupDigits(d.rowCount)) : '—'],
    ['字段数', esc(groupDigits(fields.length))],
  ];
  if (d.description) info.push(['说明', esc(d.description)]);
  return (
    kv(info) +
    label(`字段结构（${shown.length}${fields.length > shown.length ? ` / 共 ${fields.length}` : ''}）`) +
    `<div class="scroll">${table(['#', '字段', '类型', '可空', '键 / 引用', '说明'], rows)}</div>` +
    (fields.length > shown.length
      ? `<p class="note">为控制文件体积，仅列出前 ${MAX_TABLE_ROWS} 个字段。</p>`
      : '')
  );
}

function manifestBlock(manifest: AnalysisManifest | undefined, ctx: CardContext, withAppendixLink: boolean): string {
  if (!manifest) {
    return '<p class="note">该节点没有分析留痕（Manifest）：由画布恢复 / 数据源面板补出，或早于 T1.1 上线。</p>';
  }
  const checksum = manifest.checksum;
  const rows: Array<[string, string]> = [
    ['来源', esc(manifestOriginLabel(manifest.origin))],
    ['数据源', esc(manifest.datasource || '—')],
    ['执行时间', esc(formatTimestamp(manifest.executedAt))],
  ];
  // 一致复跑会刷新 executedAt；首次交付时间另列一行（相同时不渲染，避免噪音）。
  if (manifest.firstExecutedAt && manifest.firstExecutedAt !== manifest.executedAt) {
    rows.push(['首次交付', esc(formatTimestamp(manifest.firstExecutedAt))]);
  }
  if (manifest.dfName) rows.push(['DataFrame', esc(manifest.dfName)]);
  if (typeof manifest.rowCount === 'number') {
    rows.push(['行 × 列', esc(`${groupDigits(manifest.rowCount)} × ${manifest.columnCount ?? '?'}`)]);
  }
  if (checksum) {
    rows.push([
      '校验和',
      `<span title="规模 ${esc(checksum.rowCount)} 行 × ${esc(checksum.columnCount)} 列；结构哈希含列名与 dtype，不含数据内容">` +
        `${esc(checksum.algorithm)}: schema ${esc(checksum.schemaHash)} · sql ${esc(checksum.sqlHash)}</span>`,
    ]);
  }
  rows.push(['生成模型', esc(manifestModelLabel(manifest))]);
  rows.push(['权限决策', permissionCell(manifest, ctx.auditIds)]);
  rows.push(['会话', esc(manifest.sessionId || '—')]);
  if (manifest.sourceDataFrames?.length) {
    rows.push(['上游 DF', esc(manifest.sourceDataFrames.join(', '))]);
  }
  return (
    label(`分析留痕 · Manifest v${manifest.schemaVersion}`) +
    kv(rows) +
    (withAppendixLink ? '<p class="note">完整字段与 SQL 全文见<a href="#appendix-a">附录 A</a>。</p>' : '')
  );
}

function sqlQueryBody(d: SQLQueryNodeData, ctx: CardContext): string {
  return (
    label('SQL') +
    (d.sql ? codeBlock(d.sql) : '<p class="note">（空 SQL：双击节点可在画布里编辑）</p>') +
    (d.outputColumns?.length ? label('输出列') + chips(d.outputColumns) : '') +
    manifestBlock(d.manifest, ctx, false)
  );
}

function rerunBanner(d: DataFrameNodeData): string {
  const latest = latestRerun(d);
  if (!latest) return '';
  if (latest.outcome === 'drift') {
    return `<div class="box warn"><div class="t">⚠ 漂移警告（最近一次复跑 ${esc(formatRerunTime(latest.rerunAt))}）</div>` +
      `<div>${esc(latest.diff?.summary ?? '结果与原留痕不一致')}</div>` +
      `<div class="note">原 Manifest 未被覆盖：下方的行 × 列仍是<strong>已交付</strong>的那份结果，新旧对比见复跑记录。</div></div>`;
  }
  if (latest.outcome === 'error') {
    return `<div class="box err"><div class="t">✗ 最近一次复跑失败（${esc(formatRerunTime(latest.rerunAt))}）</div>` +
      `<div>${esc(latest.error ?? '未知原因')}</div></div>`;
  }
  const after = latest.after;
  return `<div class="box ok"><div class="t">✓ 最近一次复跑复现一致（${esc(formatRerunTime(latest.rerunAt))}）</div>` +
    (after ? `<div class="note">${esc(groupDigits(after.rowCount ?? 0))} 行 × ${esc(after.columnCount ?? '?')} 列，校验和与原留痕一致</div>` : '') +
    `</div>`;
}

function rerunRecordLine(record: RerunRecord, index: number): string {
  const outcome = RERUN_OUTCOME_LABELS[record.outcome] ?? record.outcome;
  const before = record.before;
  const after = record.after;
  const parts = [
    `#${index + 1} ${formatRerunTime(record.rerunAt)} · ${outcome}`,
    before ? `原 ${before.rowCount ?? '?'} 行 × ${before.columnCount ?? '?'} 列` : '',
    after ? `本次 ${after.rowCount ?? '?'} 行 × ${after.columnCount ?? '?'} 列` : '',
    record.diff ? record.diff.summary : '',
    record.error ? `原因：${record.error}` : '',
    typeof record.durationMs === 'number' ? `耗时 ${formatDuration(record.durationMs)}` : '',
    record.tempDfName ? `临时 DF ${record.tempDfName}（比对后已释放）` : '',
  ].filter(Boolean);
  return `<li>${esc(parts.join(' · '))}</li>`;
}

function rerunSummary(d: DataFrameNodeData): string {
  const history = d.rerunHistory ?? [];
  if (!history.length) {
    return '<p class="note">尚未复跑过：画布上点「复跑」可按留痕固化的 SQL 重新执行并对比。</p>';
  }
  return (
    label(`复跑记录（${history.length} 次，最新在前）`) +
    `<ul class="plain">${history.map(rerunRecordLine).join('')}</ul>`
  );
}

function dataFrameBody(node: Node, ctx: CardContext): string {
  const d = dataOf<DataFrameNodeData>(node);
  const columns = Array.isArray(d.columns) ? d.columns : [];
  const shown = columns.slice(0, MAX_TABLE_ROWS);
  const rows = shown.map((c, i) => [String(i), esc(c.name), esc(groupDigits(c.nonNull ?? 0)), esc(c.dtype)]);
  return (
    rerunBanner(d) +
    kv([
      ['DataFrame', esc(d.dfName || '—')],
      ['数据源', esc(d.sourceName || d.manifest?.datasource || '—')],
      ['行 × 列', esc(`${groupDigits(d.totalRows ?? 0)} × ${groupDigits(d.totalColumns ?? 0)}`)],
      ['内存占用', esc(d.memoryUsage || '—')],
    ]) +
    label(`列结构（${shown.length}${columns.length > shown.length ? ` / 共 ${columns.length}` : ''}）`) +
    `<div class="scroll">${table(['#', '列名', 'Non-Null', 'Dtype'], rows)}</div>` +
    rerunSummary(d) +
    manifestBlock(d.manifest, ctx, true)
  );
}

function reportBody(d: ReportNodeData): string {
  const refs = (d.sourceRefs ?? []).map((r) => r?.label).filter(Boolean) as string[];
  return (
    kv([['报告类型', esc(REPORT_TYPE_LABELS[d.reportType] ?? d.reportType ?? '—')]]) +
    (refs.length ? label('对比对象') + chips(refs) : '') +
    label('正文') +
    renderReportMarkdown(d.content ?? '')
  );
}

/** trace 的数据点个数（只数长度，不取值） */
export function tracePointCount(trace: ChartTrace): number | null {
  for (const key of ['values', 'y', 'x', 'labels', 'ids'] as const) {
    const v = trace[key];
    if (Array.isArray(v)) return v.length;
  }
  return null;
}

/** trace 的标量属性（白名单：只取字段名/模式这类元信息，绝不取数据数组） */
function traceMeta(trace: ChartTrace): string {
  const parts: string[] = [];
  for (const key of ['mode', 'hole', 'branchvalues', 'key', 'treeDf', 'orientation'] as const) {
    const v = trace[key];
    if (typeof v === 'string' || typeof v === 'number') parts.push(`${key}=${v}`);
  }
  return parts.join(' ');
}

/** Plotly layout 里的标题类文本（`title` 可能是字符串或 `{text}`） */
function layoutText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function chartConfigSummary(config: ChartConfig): string {
  const traces = Array.isArray(config?.data) ? config.data : [];
  const rows = traces.map((t, i) => {
    const points = tracePointCount(t);
    return [
      String(i),
      esc(t?.type ?? '—'),
      esc(t?.name ?? '—'),
      points === null ? '—' : esc(groupDigits(points)),
      esc(traceMeta(t) || '—'),
    ];
  });
  const layout = (config?.layout ?? {}) as Record<string, unknown>;
  const axis = (name: string): string => {
    const a = layout[name] as Record<string, unknown> | undefined;
    return layoutText(a?.title);
  };
  return (
    kv([
      ['图表类型', esc(config?.type || '—')],
      ['标题', esc(layoutText(layout.title) || '—')],
      ['X 轴', esc(axis('xaxis') || '—')],
      ['Y 轴', esc(axis('yaxis') || '—')],
      ['trace 数', esc(groupDigits(traces.length))],
    ]) +
    label('trace 摘要（不含数据值）') +
    table(['#', '类型', '名称', '数据点', '模式 / 参数'], rows) +
    (Object.keys(layout).length
      ? label('布局键') + chips(Object.keys(layout).slice(0, 40))
      : '')
  );
}

function chartBody(node: Node, ctx: CardContext): string {
  const d = dataOf<ChartNodeData>(node);
  const result = ctx.chartResults[node.id];
  const metaRows: Array<[string, string]> = [['图表类型', esc(d.config?.type || '—')]];
  if (d.sourceDf) metaRows.push(['数据源 DF', esc(d.sourceDf)]);
  const meta = kv(metaRows);
  if (result?.ok && result.dataUrl) {
    return (
      `<img class="chart" src="${esc(result.dataUrl)}" width="${result.width ?? CHART_RENDER.width}" ` +
      `height="${result.height ?? CHART_RENDER.height}" alt="图表静态快照：${esc(nodeTitle(node))}">` +
      '<p class="note">导出时用节点已有的 Plotly 配置渲染为内联图片：静态、不可交互，' +
      '不引用任何外部脚本或网络资源。</p>' +
      meta
    );
  }
  const reason = result?.reason ?? '导出环境未渲染图像（例如无浏览器绘图能力）';
  return (
    `<div class="box info"><div class="t">图表未静态渲染，降级为配置摘要</div>` +
    `<div class="note">${esc(reason)}</div></div>` +
    meta +
    chartConfigSummary(d.config ?? { type: 'unknown', data: [] })
  );
}

function renderNodeCard(node: Node, ctx: CardContext): string {
  const kind = nodeKind(node);
  const accent = accentOf(node);
  const d = dataOf<{ createdAt?: string }>(node);
  const badges: string[] = [badge(NODE_LABELS[kind], '', accent)];
  if (kind === 'report') {
    const rt = dataOf<ReportNodeData>(node).reportType;
    if (rt) badges.push(badge(REPORT_TYPE_LABELS[rt] ?? rt));
  }
  if (kind === 'chart') {
    const ct = dataOf<ChartNodeData>(node).config?.type;
    if (ct) badges.push(badge(ct));
  }
  if (kind === 'dataFrame') {
    const df = dataOf<DataFrameNodeData>(node);
    const latest = latestRerun(df);
    if (hasDrift(df)) badges.push(badge('漂移', 'drift'));
    else if (latest?.outcome === 'identical') badges.push(badge('复现一致', 'ok'));
    else if (latest?.outcome === 'error') badges.push(badge('复跑失败', 'err'));
    const pdid = df.manifest?.permissionDecisionId;
    if (pdid) {
      // 区分「用户亲手确认」与「Accept All 自动放行」；拿不到审计条目时用中性措辞
      badges.push(badge(ctx.autoApprovedIds.has(pdid) ? '已过确认门（自动放行）' : '已过确认门'));
    }
  }
  const body =
    kind === 'sourceTable' ? sourceTableBody(dataOf<SourceTableNodeData>(node))
    : kind === 'sqlQuery' ? sqlQueryBody(dataOf<SQLQueryNodeData>(node), ctx)
    : kind === 'dataFrame' ? dataFrameBody(node, ctx)
    : kind === 'report' ? reportBody(dataOf<ReportNodeData>(node))
    : chartBody(node, ctx);
  const drifted = kind === 'dataFrame' && hasDrift(dataOf<DataFrameNodeData>(node));
  return (
    `<article class="card${drifted ? ' drift' : ''}" id="card-${esc(node.id)}" style="border-left-color:${esc(accent)}">` +
    `<div class="card-hd"><div class="row">${badges.join('')}<span class="t">${esc(nodeTitle(node))}</span></div>` +
    `<div class="row"><span class="at">创建于 ${esc(formatTimestamp(d?.createdAt))}</span>` +
    `<span class="id">${esc(node.id)}</span></div></div>` +
    `<div class="card-bd">${body}</div>` +
    lineageFooter(node, ctx) +
    `</article>`
  );
}

// ---------------------------------------------------------------------------
// 渲染：附录 A（Manifest）与附录 B（权限确认记录）
// ---------------------------------------------------------------------------

function dataframeNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => nodeKind(n) === 'dataFrame');
}

export function renderAppendixA(nodes: Node[], ctx: CardContext): string {
  const frames = dataframeNodes(nodes);
  const withManifest = frames.filter((n) => dataOf<DataFrameNodeData>(n).manifest);
  const rows = frames.map((n) => {
    const d = dataOf<DataFrameNodeData>(n);
    const m = d.manifest;
    const latest = latestRerun(d);
    const rerunCell = latest
      ? `${RERUN_OUTCOME_LABELS[latest.outcome] ?? latest.outcome} · ${formatRerunTime(latest.rerunAt)}`
      : '未复跑';
    return [
      nodeLink(n.id, ctx),
      esc(d.dfName || '—'),
      esc(m ? manifestOriginLabel(m.origin) : '—'),
      esc(m?.datasource || d.sourceName || '—'),
      esc(m ? formatTimestamp(m.executedAt) : '—'),
      esc(m && typeof m.rowCount === 'number' ? `${groupDigits(m.rowCount)} × ${m.columnCount ?? '?'}` : '—'),
      esc(m?.checksum?.schemaHash ?? '—'),
      esc(m?.checksum?.sqlHash ?? '—'),
      esc(m ? manifestModelLabel(m) : '—'),
      m ? permissionCell(m, ctx.auditIds) : '<span class="note">无 Manifest</span>',
      `<span class="${hasDrift(d) ? 'badge drift' : 'note'}">${esc(rerunCell)}</span>`,
    ];
  });
  const details = frames
    .filter((n) => dataOf<DataFrameNodeData>(n).manifest)
    .map((n) => {
      const d = dataOf<DataFrameNodeData>(n);
      const m = d.manifest as AnalysisManifest;
      const checksum = m.checksum;
      return (
        `<details id="manifest-${esc(n.id)}"><summary>SQL 全文与完整字段 · ${esc(d.dfName || n.id)}</summary>` +
        kv([
          ['schemaVersion', esc(m.schemaVersion)],
          ['origin', esc(m.origin)],
          ['datasource', esc(m.datasource || '—')],
          ['dfName', esc(m.dfName ?? '—')],
          ['executedAt', esc(m.executedAt)],
          ['firstExecutedAt', esc(m.firstExecutedAt ?? '—')],
          ['rowCount', esc(m.rowCount ?? '—')],
          ['columnCount', esc(m.columnCount ?? '—')],
          [
            'checksum',
            checksum
              ? esc(`${checksum.algorithm} · rows ${checksum.rowCount} · cols ${checksum.columnCount} · schema ${checksum.schemaHash} · sql ${checksum.sqlHash}`)
              : '—（无列信息，T1.1 不产出校验和）',
          ],
          ['model', esc(m.model ? JSON.stringify(m.model) : '—（人工执行）')],
          ['sessionId', esc(m.sessionId || '—')],
          ['permissionDecisionId', permissionCell(m, ctx.auditIds)],
          ['sourceDataFrames', esc(m.sourceDataFrames?.length ? m.sourceDataFrames.join(', ') : '—')],
          ['可一键复跑', m.sql.trim() ? '是（SQL 与数据源齐全）' : '否（无 SQL 上下文）'],
        ]) +
        label('SQL 全文（原样固化）') +
        (m.sql ? codeBlock(m.sql) : '<p class="note">无 SQL 上下文（该节点不可一键复跑）</p>') +
        `</details>`
      );
    });
  return (
    `<section id="appendix-a"><h2><span class="n">附录 A</span> DataFrame 分析留痕（Analysis Manifest）</h2>` +
    `<p class="note">共 ${frames.length} 个 dataFrame 节点，其中 ${withManifest.length} 个带 Manifest。` +
    `Manifest 由服务端在结果产生时固化、只读；唯一的受控例外是复跑结论为「一致」时刷新 ` +
    `<code>executedAt</code>，首次交付时间另存于不可变的 <code>firstExecutedAt</code>（逐次旧值另见复跑记录的 <code>before</code>，见 T1.2 设计说明）。` +
    `<code>permissionDecisionId</code> 为 <em>未过确认门</em> 表示这次取数没有触发取数确认门（例如不带 <code>-o</code> 的加载、SQL 编辑器人工执行）。</p>` +
    (frames.length
      ? `<div class="scroll"><table class="t wide"><thead><tr>` +
        ['节点', 'DataFrame', '来源', '数据源', '执行时间', '行 × 列', '结构哈希', 'SQL 哈希', '生成模型', '权限决策 ID', '最近复跑']
          .map((h) => `<th>${h}</th>`)
          .join('') +
        `</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<p class="note">画布上没有 dataFrame 节点。</p>') +
    details.join('') +
    `</section>`
  );
}

const AUDIT_TYPE_LABELS: Record<string, string> = {
  permission_request: '确认请求',
  permission_decision: '确认决策',
  permission_mode: '放行模式变更',
};

const AUDIT_DECISION_LABELS: Record<string, string> = {
  allow: '允许',
  deny: '拒绝',
  edit: '修改后放行',
};

/** `source`：区分「用户亲手点的」与「系统代答的」（T1.3 审计的核心列） */
const AUDIT_SOURCE_LABELS: Record<string, string> = {
  user: '用户',
  'accept-all': '全局放行（自动）',
  timeout: '超时自动拒绝',
  abort: '中止自动拒绝',
  reset: '会话重置自动拒绝',
};

function auditEntryRow(
  entry: AuditEntryView,
  nodeIds: string[],
  ctx: CardContext,
  anchor: boolean,
): string {
  const kind = AUDIT_TYPE_LABELS[entry.type] ?? entry.type;
  const decision = entry.decision ? (AUDIT_DECISION_LABELS[entry.decision] ?? entry.decision) : '—';
  const source = entry.source ? (AUDIT_SOURCE_LABELS[entry.source] ?? entry.source) : '—';
  const extra =
    entry.type === 'permission_mode'
      ? `acceptAll=${entry.acceptAll ? '开' : '关'} · 影响挂起请求 ${entry.pendingAffected ?? 0}`
      : entry.type === 'permission_request'
        ? `闸门：${entry.gate === 'accept-all' ? '全局放行' : '人工确认'}${entry.followsDecisionId ? ` · 承接 ${entry.followsDecisionId}` : ''}`
        : '';
  // 同一次确认有「请求 + 决策」两条记录共用 decisionId：锚点只给第一条，避免重复 id
  const idAttr = anchor ? ` id="audit-${esc(entry.decisionId)}"` : '';
  return (
    `<tr${idAttr}>` +
    `<td>${esc(formatTimestamp(entry.at))}</td>` +
    `<td>${esc(kind)}</td>` +
    `<td>${esc(decision)}</td>` +
    `<td>${esc(source)}</td>` +
    `<td><code>${esc(entry.decisionId)}</code></td>` +
    `<td class="num">${typeof entry.elapsedMs === 'number' ? esc(formatDuration(entry.elapsedMs)) : '—'}</td>` +
    `<td>${codeCell(entry.command ?? '')}</td>` +
    `<td>${codeCell(entry.editedCommand ?? '')}</td>` +
    `<td>${esc([entry.reason ?? '', extra].filter(Boolean).join(' · ') || '—')}</td>` +
    `<td>${nodeIds.length ? nodeIds.map((id) => nodeLink(id, ctx)).join('<br>') : '<span class="note">—</span>'}</td>` +
    `</tr>`
  );
}

export function renderAppendixB(audit: AuditAppendix | null | undefined, nodes: Node[], ctx: CardContext): string {
  const head = `<section id="appendix-b"><h2><span class="n">附录 B</span> 权限确认记录（取数确认门）</h2>`;
  if (!audit) {
    return head +
      '<div class="box info"><div class="t">未获取审计记录</div><div class="note">本次导出没有查询审计通道（例如在非浏览器环境生成）。</div></div></section>';
  }
  if (!audit.available) {
    return head +
      `<div class="box info"><div class="t">未获取到审计记录</div><div class="note">${esc(audit.reason ?? '原因未知')}</div>` +
      '<div class="note">附录 B 只在导出时读取当前会话的审计 sidecar（只读）；读不到不影响其余章节，但这份交付物就缺少「谁批准了这次取数」的佐证。</div></div></section>';
  }

  // decisionId → 画布节点：附录 B 的每一行都能跳回它对应的节点
  const nodesByDecision = new Map<string, string[]>();
  for (const n of nodes) {
    const m = dataOf<{ manifest?: AnalysisManifest }>(n).manifest;
    const id = m?.permissionDecisionId;
    if (!id) continue;
    const arr = nodesByDecision.get(id) ?? [];
    arr.push(n.id);
    nodesByDecision.set(id, arr);
  }

  const entries = audit.entries ?? [];
  const source = audit.sessionFile
    ? `<code>${esc(auditSidecarLabel(audit.sessionFile))}</code>`
    : '当前会话的审计 sidecar';
  // 过滤数用服务端实际参与过滤的数（可能被 200 上限截断），不拿前端请求数充数
  const filterCount = audit.serverRequested ?? audit.requestedDecisionIds.length;
  const intro =
    `<p class="note">来源：${source}（服务端只读返回，仅限当前会话` +
    `${audit.sessionId ? ` <code>${esc(audit.sessionId)}</code>` : ''}）。` +
    `会话内共 ${esc(groupDigits(audit.totalInSession ?? entries.length))} 条记录，本附录带出与画布节点 Manifest 的 ` +
    `<code>permissionDecisionId</code> 关联的 ${entries.length} 条（按 ${filterCount} 个 decisionId 过滤）。` +
    (audit.truncated ? '<strong>⚠ 审计通道截断，仅带出前 200 个 decisionId；未带出的部分请回会话审计 sidecar 查证。</strong>' : '') +
    `记录里只有命令原文与决策，<strong>不含任何查询结果</strong>。</p>`;

  if (!entries.length) {
    return head + intro +
      `<div class="box info"><div class="t">没有与画布节点关联的确认记录</div><div class="note">` +
      (audit.requestedDecisionIds.length
        ? `画布节点引用了 ${audit.requestedDecisionIds.length} 个 decisionId，但当前会话审计里没有匹配记录（可能会话已切换、sidecar 已随会话删除，或记录早于本次导出被清理）。`
        : '画布上没有任何节点带 permissionDecisionId：这些结果都没有经过取数确认门（详见附录 A 的「权限决策 ID」列）。') +
      `</div></div></section>`;
  }

  const anchored = new Set<string>();
  const rows = entries.map((e) => {
    const anchor = !anchored.has(e.decisionId);
    anchored.add(e.decisionId);
    return auditEntryRow(e, nodesByDecision.get(e.decisionId) ?? [], ctx, anchor);
  });
  return head + intro +
    `<div class="scroll"><table class="t wide"><thead><tr>` +
    '<th>时间</th><th>类型</th><th>决策</th><th>来源</th><th>decisionId</th><th class="num">耗时</th>' +
    '<th>命令（改前）</th><th>改后命令</th><th>备注 / 闸门</th><th>关联节点</th>' +
    `</tr></thead><tbody>${rows.join('')}</tbody></table></div>` +
    `<p class="note">「来源」区分用户亲手决策与系统代答（超时 / 中止 / 会话重置 / 全局放行自动允许）；` +
    `放行模式（Accept All）期间的自动允许同样留痕，<code>elapsedMs</code> 为 0。` +
    `未与任何节点关联的确认记录与放行模式变更事件不在本附录范围内。</p></section>`;
}

// ---------------------------------------------------------------------------
// 渲染：报头 / 摘要 / 章节装配
// ---------------------------------------------------------------------------

interface ReportStats {
  nodes: number;
  edges: number;
  dataFrames: number;
  drifted: number;
  manifests: number;
  reruns: number;
  auditEntries: number;
  byType: Record<NodeType, number>;
}

function computeStats(input: DeliveryReportInput, layout: LineageLayout): ReportStats {
  const byType: Record<NodeType, number> = {
    sourceTable: 0, sqlQuery: 0, dataFrame: 0, report: 0, chart: 0,
  };
  let drifted = 0;
  let manifests = 0;
  let reruns = 0;
  for (const n of input.nodes) {
    const kind = nodeKind(n);
    byType[kind] = (byType[kind] ?? 0) + 1;
    const m = dataOf<{ manifest?: AnalysisManifest }>(n).manifest;
    if (m) manifests++;
    if (kind === 'dataFrame') {
      const d = dataOf<DataFrameNodeData>(n);
      if (hasDrift(d)) drifted++;
      reruns += d.rerunHistory?.length ?? 0;
    }
  }
  return {
    nodes: input.nodes.length,
    edges: layout.edges.length,
    dataFrames: byType.dataFrame,
    drifted,
    manifests,
    reruns,
    auditEntries: input.audit?.entries?.length ?? 0,
    byType,
  };
}

function renderHeader(input: DeliveryReportInput, stats: ReportStats, layout: LineageLayout): string {
  const title = input.title || 'Govio Map · 画布交付报告';
  const typeSummary = (Object.keys(stats.byType) as NodeType[])
    .filter((t) => stats.byType[t] > 0)
    .map((t) => `${NODE_LABELS[t]} ${stats.byType[t]}`)
    .join(' · ');
  return `<header class="report-head">
<h1>${esc(title)}</h1>
<p class="sub">画布节点静态快照 + 血缘图 + 分析留痕（Manifest）+ 权限确认记录 · 自包含单文件，可离线打开</p>
<dl class="meta">
<div><dt>导出时间</dt><dd>${esc(formatTimestamp(input.exportedAt))}</dd></div>
<div><dt>导出时间（ISO）</dt><dd>${esc(input.exportedAt)}</dd></div>
<div><dt>应用版本</dt><dd>${esc(input.appVersion ? `Govio Map v${input.appVersion}` : 'Govio Map')}</dd></div>
<div><dt>会话</dt><dd>${esc(input.audit?.sessionId || '—')}</dd></div>
<div><dt>节点 / 连线</dt><dd>${stats.nodes} / ${stats.edges}</dd></div>
<div><dt>节点构成</dt><dd>${esc(typeSummary || '—')}</dd></div>
${layout.droppedEdges ? `<div><dt>忽略的连线</dt><dd>${layout.droppedEdges}（端点不在画布上或自环）</dd></div>` : ''}
</dl>
<nav class="toc">
<a href="#summary">摘要</a><a href="#lineage">1. 血缘图</a><a href="#nodes">2. 节点卡片</a>
<a href="#appendix-a">附录 A · Manifest</a><a href="#appendix-b">附录 B · 权限确认</a>
</nav>
</header>`;
}

function renderSummary(input: DeliveryReportInput, stats: ReportStats, ctx: CardContext): string {
  const boxes: string[] = [];

  const driftedNodes = dataframeNodes(input.nodes).filter((n) => hasDrift(dataOf<DataFrameNodeData>(n)));
  if (driftedNodes.length) {
    boxes.push(
      `<div class="box warn"><div class="t">⚠ ${driftedNodes.length} 个 DataFrame 处于漂移警告态</div>` +
      `<div class="note">最近一次复跑的结果与原留痕不一致。原 Manifest 未被覆盖，节点展示的仍是已交付结果；对比细节见卡片与附录 A。</div><ul>` +
      driftedNodes
        .map((n) => {
          const d = dataOf<DataFrameNodeData>(n);
          return `<li>${nodeLink(n.id, ctx)} <code>${esc(d.dfName || '')}</code> — ${esc(latestRerun(d)?.diff?.summary ?? '结果与原留痕不一致')}</li>`;
        })
        .join('') +
      `</ul></div>`,
    );
  }

  const failedNodes = dataframeNodes(input.nodes).filter((n) => latestRerun(dataOf<DataFrameNodeData>(n))?.outcome === 'error');
  if (failedNodes.length) {
    boxes.push(
      `<div class="box err"><div class="t">✗ ${failedNodes.length} 个 DataFrame 最近一次复跑失败</div><ul>` +
      failedNodes
        .map((n) => `<li>${nodeLink(n.id, ctx)} — ${esc(latestRerun(dataOf<DataFrameNodeData>(n))?.error ?? '未知原因')}</li>`)
        .join('') +
      `</ul></div>`,
    );
  }

  const noManifest = dataframeNodes(input.nodes).filter((n) => !dataOf<DataFrameNodeData>(n).manifest);
  if (noManifest.length) {
    boxes.push(
      `<div class="box info"><div class="t">${noManifest.length} 个 DataFrame 没有分析留痕</div>` +
      `<div class="note">这些节点不可一键复跑；附录 A 的表里仍占一行，但 Manifest 各列显示「—」。</div><ul>` +
      noManifest.map((n) => `<li>${nodeLink(n.id, ctx)} <code>${esc(dataOf<DataFrameNodeData>(n).dfName || '')}</code></li>`).join('') +
      `</ul></div>`,
    );
  }

  const chartFallbacks = input.nodes.filter((n) => {
    if (nodeKind(n) !== 'chart') return false;
    const r = ctx.chartResults[n.id];
    return !r?.ok;
  });
  if (chartFallbacks.length) {
    boxes.push(
      `<div class="box info"><div class="t">${chartFallbacks.length} 个图表降级为配置摘要</div><ul>` +
      chartFallbacks
        .map((n) => `<li>${nodeLink(n.id, ctx)} — ${esc(ctx.chartResults[n.id]?.reason ?? '导出环境未渲染图像')}</li>`)
        .join('') +
      `</ul></div>`,
    );
  }

  const audit = input.audit;
  if (audit && !audit.available) {
    boxes.push(`<div class="box info"><div class="t">附录 B 未获取到审计记录</div><div class="note">${esc(audit.reason ?? '原因未知')}</div></div>`);
  }

  const statsHtml = `<dl class="stats">
<div><dt>节点</dt><dd>${stats.nodes}</dd></div>
<div><dt>血缘连线</dt><dd>${stats.edges}</dd></div>
<div><dt>DataFrame</dt><dd>${stats.dataFrames}</dd></div>
<div><dt>漂移告警</dt><dd class="${stats.drifted ? 'warn' : ''}">${stats.drifted}</dd></div>
<div><dt>带 Manifest 的节点</dt><dd>${stats.manifests}</dd></div>
<div><dt>复跑次数</dt><dd>${stats.reruns}</dd></div>
<div><dt>确认记录（附录 B）</dt><dd>${stats.auditEntries}</dd></div>
</dl>`;

  return `<section id="summary"><h2><span class="n">摘要</span> 交付概览与告警</h2>${statsHtml}${boxes.join('') ||
    '<div class="box ok"><div class="t">✓ 无漂移、无复跑失败</div><div class="note">所有带留痕的 DataFrame 最近一次复跑结论均为「复现一致」，或尚未复跑过。</div></div>'}</section>`;
}

function renderLineageSection(layout: LineageLayout): string {
  const legend = (Object.keys(NODE_LABELS) as NodeType[])
    .map((t) => `<span><i style="background:${esc(NODE_COLORS[t])}"></i>${esc(NODE_LABELS[t])}</span>`)
    .join('');
  return `<section id="lineage"><h2><span class="n">1</span> 血缘连线图</h2>` +
    `<p class="note">按血缘层次从左到右排布（同源同层按画布顺序纵向排列），箭头表示数据流向；点击任意盒子跳到对应节点卡片。` +
    `这是一张静态示意图，不复用画布的 ReactFlow 运行时，因此离线打开也能看。</p>` +
    (layout.boxes.length
      ? `<div class="lineage-wrap">${lineageSvg(layout)}</div><div class="legend">${legend}</div>`
      : '<p class="note">画布为空。</p>') +
    `</section>`;
}

function renderCardsSection(input: DeliveryReportInput, layout: LineageLayout, ctx: CardContext): string {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const ordered = layout.order.map((id) => byId.get(id)).filter(Boolean) as Node[];
  return `<section id="nodes"><h2><span class="n">2</span> 节点卡片（静态快照）</h2>` +
    `<p class="note">共 ${ordered.length} 个节点，按血缘层次排列。卡片是导出时刻的静态快照：不含交互按钮，` +
    `不含数据行内容（DataFrame 只有列名与 dtype）。</p>` +
    (ordered.length
      ? `<div class="card-grid">${ordered.map((n) => renderNodeCard(n, ctx)).join('')}</div>`
      : '<p class="note">画布为空。</p>') +
    `</section>`;
}

function renderFooter(input: DeliveryReportInput, stats: ReportStats): string {
  const checksumNote = 'schema-v1：sha256(行数|列数|列名:dtype) 与 sha256(SQL) 各取前 16 位，不含数据内容';
  return `<footer>
<p>本文件由 ${esc(input.appVersion ? `Govio Map v${input.appVersion}` : 'Govio Map')} 于 ${esc(formatTimestamp(input.exportedAt))} 从画布导出：` +
  `${stats.nodes} 个节点 / ${stats.edges} 条连线，内联 CSS 与 SVG，<strong>无外部脚本、字体、图片或网络请求</strong>，双击即可离线打开。</p>
<p>内容范围：画布节点的结构与留痕（表结构、SQL 全文、列结构、Analysis Manifest、复跑与漂移记录、权限确认记录）与血缘关系。` +
  `<strong>不含数据行内容</strong>——导出过程不读 parquet、不调 govio-cli、不调模型，只消费画布 store 已有数据与只读审计通道。</p>
<p>校验和算法 ${esc(checksumNote)}（见 <code>docs/tasks/T1.1-analysis-manifest/design.md</code>）；` +
  `复跑与漂移语义见 <code>docs/tasks/T1.2-dataframe-rerun-drift/design.md</code>；` +
  `权限审计记录模型见 <code>docs/tasks/T1.3-permission-audit-trail/design.md</code>。</p>
${input.audit?.sessionFile ? `<p>审计来源：<code>${esc(auditSidecarLabel(input.audit.sessionFile))}</code>（只读，仅当前会话）。</p>` : ''}
</footer>`;
}

/**
 * 生成整份交付报告 HTML（**纯函数**：同样的输入产出同样的字符串）。
 *
 * 不读时钟、不碰 DOM、不发请求——时间与图表图像都由入参给定，因此验证脚本可以在
 * Node 里直接跑并逐字节比对产物。
 */
export function buildDeliveryReportHtml(input: DeliveryReportInput): string {
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const edges = Array.isArray(input.edges) ? input.edges : [];
  const layout = layoutLineage(nodes, edges);

  const upByNode = new Map<string, string[]>();
  const downByNode = new Map<string, string[]>();
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  for (const e of layout.edges) {
    const up = upByNode.get(e.target) ?? [];
    up.push(e.source);
    upByNode.set(e.target, up);
    const down = downByNode.get(e.source) ?? [];
    down.push(e.target);
    downByNode.set(e.source, down);
  }
  const auditIds = new Set((input.audit?.entries ?? []).map((e) => e.decisionId));
  const autoApprovedIds = new Set(
    (input.audit?.entries ?? [])
      .filter((e) => (e.type === 'permission_decision' && e.source === 'accept-all')
        || (e.type === 'permission_request' && e.gate === 'accept-all'))
      .map((e) => e.decisionId),
  );
  const ctx: CardContext = {
    nodesById,
    upByNode,
    downByNode,
    chartResults: input.chartResults ?? {},
    auditIds,
    autoApprovedIds,
  };

  const stats = computeStats({ ...input, nodes, edges }, layout);
  const title = input.title || 'Govio Map · 画布交付报告';
  const datePart = String(input.exportedAt ?? '').slice(0, 10);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="${esc(input.appVersion ? `Govio Map ${input.appVersion}` : 'Govio Map')}">
<title>${esc(title)}${datePart ? ` · ${esc(datePart)}` : ''}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
${renderHeader({ ...input, nodes, edges }, stats, layout)}
${renderSummary({ ...input, nodes, edges }, stats, ctx)}
${renderLineageSection(layout)}
${renderCardsSection({ ...input, nodes, edges }, layout, ctx)}
${renderAppendixA(nodes, ctx)}
${renderAppendixB(input.audit, nodes, ctx)}
${renderFooter({ ...input, nodes, edges }, stats)}
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// 浏览器侧：图表静态渲染 / 审计只读通道 / 下载
// ---------------------------------------------------------------------------

/** 后端 API 基址：与 canvas-store 的 `/api/preview`、T1.2 的复跑请求同一套推导 */
export function apiBase(): string {
  return `http://localhost:${Number(window.location.port) + 1}`;
}

/**
 * 用节点已有的 Plotly 配置把 chart 节点渲染成内联图片（SVG 优先，失败退 PNG）。
 *
 * 取舍：**不把 plotly.js 塞进导出文件**（`plotly.js-dist-min` 压缩后约 3.5 MB，塞进去
 * 会让「交付报告」比整个应用还大，而且引入运行时脚本）；也不写自己的图表渲染器。
 * 这里在导出瞬间借浏览器里已有的 Plotly 把每个图表画到离屏容器上，再 `toImage` 成
 * data URL 内联——产物是静态图片，零脚本、零外部依赖。渲染失败（配置无效、WebGL
 * trace、Plotly 不可用）时该节点降级为「配置摘要」，并在摘要与报告里写明原因。
 */
export async function renderChartImages(nodes: Node[]): Promise<ChartRenderMap> {
  const results: ChartRenderMap = {};
  const charts = (nodes ?? []).filter((n) => nodeKind(n) === 'chart');
  if (!charts.length) return results;

  let Plotly: typeof import('plotly.js-dist-min').default;
  try {
    Plotly = (await import('plotly.js-dist-min')).default;
  } catch (err) {
    const reason = `Plotly 不可用（${err instanceof Error ? err.message : String(err)}）`;
    for (const n of charts) results[n.id] = { ok: false, reason };
    return results;
  }

  const host = document.createElement('div');
  host.setAttribute(
    'style',
    `position:fixed;left:-100000px;top:0;width:${CHART_RENDER.width}px;height:${CHART_RENDER.height}px;`,
  );
  document.body.appendChild(host);
  try {
    for (const node of charts) {
      const config = dataOf<ChartNodeData>(node).config;
      try {
        await Plotly.newPlot(host, (config?.data ?? []) as unknown[], (config?.layout ?? {}) as Record<string, unknown>, {
          staticPlot: true,
          displayModeBar: false,
        });
        const dataUrl = await toImageDataUrl(Plotly, host);
        if (dataUrl) {
          results[node.id] = { ok: true, dataUrl, width: CHART_RENDER.width, height: CHART_RENDER.height };
        } else {
          results[node.id] = { ok: false, reason: 'Plotly 未能导出图像（toImage 返回空）' };
        }
      } catch (err) {
        results[node.id] = {
          ok: false,
          reason: `渲染失败：${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        try {
          Plotly.purge(host);
        } catch {
          /* purge 失败不影响导出，容器随后被移除 */
        }
      }
    }
  } finally {
    host.remove();
  }
  return results;
}

/** SVG 优先（矢量、文字清晰），失败退 PNG（WebGL trace 只能栅格化） */
async function toImageDataUrl(
  Plotly: typeof import('plotly.js-dist-min').default,
  host: HTMLElement,
): Promise<string | null> {
  for (const format of ['svg', 'png'] as const) {
    try {
      const url = await Plotly.toImage(host, {
        format,
        width: CHART_RENDER.width,
        height: CHART_RENDER.height,
      });
      if (typeof url === 'string' && url.startsWith('data:image/')) return url;
    } catch {
      /* 换下一种格式 */
    }
  }
  return null;
}

/** 画布上所有节点 Manifest 引用的 permissionDecisionId（去重、保序） */
export function collectPermissionDecisionIds(nodes: Node[]): string[] {
  const ids: string[] = [];
  for (const n of nodes ?? []) {
    const id = dataOf<{ manifest?: AnalysisManifest }>(n).manifest?.permissionDecisionId;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 只读拉取当前会话的权限确认记录（附录 B）。
 *
 * 任何失败都**不阻断导出**：返回 `available: false` + 原因，报告里如实写明「这份交付物
 * 缺少确认记录佐证」，而不是静默省略附录 B。
 */
export async function fetchAuditAppendix(decisionIds: string[]): Promise<AuditAppendix> {
  const base: AuditAppendix = { available: false, requestedDecisionIds: decisionIds, entries: [] };
  if (!decisionIds.length) {
    // 没有任何节点过确认门：不需要请求审计通道，也不是「通道不可用」。
    // available: true + 空 entries 让 renderAppendixB 走「没有关联记录」的如实说明分支。
    return { ...base, available: true, totalInSession: 0 };
  }
  try {
    const url = `${apiBase()}/api/permission-audit?decisionIds=${encodeURIComponent(decisionIds.join(','))}`;
    const res = await fetch(url);
    const payload = (await res.json().catch(() => null)) as {
      sessionId?: string;
      sessionFile?: string;
      total?: number;
      requested?: number;
      truncated?: boolean;
      entries?: unknown;
      error?: string;
    } | null;
    if (!res.ok || !payload) {
      return { ...base, reason: `审计通道返回 HTTP ${res.status}${payload?.error ? `：${payload.error}` : ''}` };
    }
    return {
      available: true,
      sessionId: payload.sessionId || undefined,
      sessionFile: payload.sessionFile || undefined,
      requestedDecisionIds: decisionIds,
      serverRequested: typeof payload.requested === 'number' ? payload.requested : undefined,
      truncated: payload.truncated === true,
      totalInSession: typeof payload.total === 'number' ? payload.total : undefined,
      entries: parseAuditEntries(payload.entries),
    };
  } catch (err) {
    return {
      ...base,
      reason: `无法连接后端审计通道（${err instanceof Error ? err.message : String(err)}）；请确认 Govio Map 后端已启动。`,
    };
  }
}

/** 按白名单把 HTTP JSON 收敛成 `AuditEntryView[]`（准入规则与服务端 `parsePermissionAuditLine` 一致） */
export function parseAuditEntries(raw: unknown): AuditEntryView[] {
  if (!Array.isArray(raw)) return [];
  const textFields = ['sessionId', 'command', 'editedCommand', 'reason', 'decision', 'source', 'gate', 'followsDecisionId'] as const;
  const out: AuditEntryView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const type = typeof rec.type === 'string' ? rec.type : '';
    const decisionId = typeof rec.decisionId === 'string' ? rec.decisionId : '';
    if (!type || !decisionId) continue;
    const picked: Record<string, unknown> = {
      type,
      decisionId,
      at: typeof rec.at === 'string' ? rec.at : '',
    };
    for (const f of textFields) {
      if (typeof rec[f] === 'string') picked[f] = rec[f];
    }
    if (typeof rec.elapsedMs === 'number') picked.elapsedMs = rec.elapsedMs;
    if (typeof rec.v === 'number') picked.v = rec.v;
    if (typeof rec.acceptAll === 'boolean') picked.acceptAll = rec.acceptAll;
    if (typeof rec.pendingAffected === 'number') picked.pendingAffected = rec.pendingAffected;
    out.push(picked as unknown as AuditEntryView);
  }
  return out;
}

/** 导出文件名：`govio-delivery-report-20261031-0045.html` */
export function reportFileName(exportedAt: string): string {
  const d = new Date(exportedAt);
  const stamp = Number.isNaN(d.getTime())
    ? 'unknown-date'
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
      `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `govio-delivery-report-${stamp}.html`;
}

/** 触发浏览器下载，返回文件字节数（与 `export-session.ts` 的 Blob + a[download] 同一套机制） */
export function downloadHtml(fileName: string, html: string): number {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立即 revoke 会在部分浏览器上取消下载，留一点余量
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return blob.size;
}

/**
 * 导出当前画布为单个自包含 HTML 文件（工具栏「导出交付报告」的实现）。
 *
 * 流程：渲染图表静态图像 + 只读拉取审计记录（并行）→ 组装 HTML → Blob 下载。
 * 只读画布 store 已有的节点数据，不做任何其他数据采集。
 */
export async function exportCanvasDeliveryReport(opts: {
  nodes: Node[];
  edges: Edge[];
  appVersion?: string;
  title?: string;
}): Promise<ExportOutcome> {
  const nodes = opts.nodes ?? [];
  const edges = opts.edges ?? [];
  if (!nodes.length) throw new Error('画布为空，没有可导出的内容');

  const exportedAt = new Date().toISOString();
  const [chartResults, audit] = await Promise.all([
    renderChartImages(nodes),
    fetchAuditAppendix(collectPermissionDecisionIds(nodes)),
  ]);
  const html = buildDeliveryReportHtml({
    nodes,
    edges,
    exportedAt,
    appVersion: opts.appVersion,
    title: opts.title,
    chartResults,
    audit,
  });
  const fileName = reportFileName(exportedAt);
  const bytes = downloadHtml(fileName, html);
  return {
    fileName,
    bytes,
    nodeCount: nodes.length,
    chartImageCount: Object.values(chartResults).filter((r) => r.ok).length,
    audit,
  };
}
