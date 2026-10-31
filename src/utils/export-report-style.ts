/**
 * 交付报告（自包含 HTML）的内联样式表 —— T1.4 画布交付导出。
 *
 * 单独成文件的原因：`export-report.ts` 负责结构与内容，样式是纯字符串常量，
 * 分开后两边都好读；两者都只被「导出」这条路径用到，由 CanvasToolbar 动态 import，
 * 不进主 bundle。
 *
 * 硬约束（离线可打开）：
 * - **不引用任何外部资源**：没有 `@import`、没有 Google Fonts、没有 CDN 图片/脚本。
 *   应用本身用 DM Sans / JetBrains Mono（index.html 里的 `<link>`），导出文件一律
 *   退到本机字体栈，双击打开时不联网也是同一份排版。
 * - 颜色沿用 docs/green-deck-DESIGN.md 的 light「Green Deck」令牌（与 `src/index.css`
 *   的 `@theme` 同值），交付物与应用内观感一致。
 */

/** 报告全文样式（写进 `<style>`，无外部依赖） */
export const REPORT_CSS = `
:root{
  --bg:#f5f5f5;--card:#ffffff;--surface:#f0f0f0;
  --text:#121212;--text-2:#535353;--text-3:#727272;--text-4:#a7a7a7;
  --border-1:#ececec;--border-2:#d4d4d4;--border-3:#b3b3b3;
  --brand:#1db954;--warning:#f59b23;--error:#e22134;
  --source:hsl(270,60%,60%);--sql:hsl(152,58%,52%);--df:hsl(25,75%,55%);
  --report:hsl(270,60%,70%);--chart:hsl(200,70%,55%);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",Roboto,"Helvetica Neue",sans-serif;
  --mono:"JetBrains Mono","Cascadia Mono","SFMono-Regular",Consolas,"Liberation Mono",monospace;
}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--text);
  font-family:var(--sans);font-size:13px;line-height:1.55;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:11px;background:var(--surface);
  border:1px solid var(--border-1);border-radius:3px;padding:0 3px;word-break:break-all}

/* ---- 报头 ---- */
.report-head{background:var(--card);border:1px solid var(--border-2);border-radius:10px;padding:18px 20px}
.report-head h1{margin:0;font-size:19px;letter-spacing:-.2px}
.report-head .sub{margin:4px 0 0;font-size:12px;color:var(--text-3)}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 18px;margin:16px 0 0;padding:0}
.meta dt{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-4)}
.meta dd{margin:2px 0 0;font-family:var(--mono);font-size:11.5px;color:var(--text-2);word-break:break-all}

/* ---- 章节与目录 ---- */
section{margin-top:24px}
h2{display:flex;align-items:baseline;gap:8px;margin:0 0 10px;padding-bottom:6px;
  font-size:15px;border-bottom:2px solid var(--brand)}
h2 .n{font-family:var(--mono);font-size:12px;color:var(--brand)}
h3{margin:18px 0 8px;font-size:13px;color:var(--text)}
.lbl{margin:12px 0 4px;font-family:var(--mono);font-size:10px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--text-3)}
.note{margin:6px 0;font-size:11.5px;color:var(--text-3)}
.toc{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border-1)}
.toc a{font-family:var(--mono);font-size:11px;padding:2px 8px;border:1px solid var(--border-2);
  border-radius:999px;background:var(--surface);color:var(--text-2)}
.toc a:hover{border-color:var(--brand);color:var(--brand);text-decoration:none}

/* ---- 摘要统计 ---- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0;padding:0}
.stats>div{background:var(--card);border:1px solid var(--border-2);border-radius:8px;padding:10px 12px}
.stats dt{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-4)}
.stats dd{margin:2px 0 0;font-size:19px;font-family:var(--mono);color:var(--text)}
.stats dd.warn{color:var(--warning)}
.stats dd.err{color:var(--error)}
.box{border-radius:8px;padding:10px 12px;margin-top:10px;font-size:12px}
.box .t{font-weight:600;margin-bottom:4px}
.box ul{margin:4px 0 0;padding-left:18px}
.box li{margin-bottom:2px}
.box.warn{border:1px solid rgba(245,155,35,.55);background:rgba(245,155,35,.09);color:#7a4d00}
.box.err{border:1px solid rgba(226,33,52,.45);background:rgba(226,33,52,.07);color:#8d1220}
.box.info{border:1px solid var(--border-2);background:var(--card);color:var(--text-2)}
.box.ok{border:1px solid rgba(29,185,84,.45);background:rgba(29,185,84,.08);color:#0d6b32}

/* ---- 血缘图 ---- */
.lineage-wrap{background:var(--card);border:1px solid var(--border-2);border-radius:8px;padding:12px;overflow:auto}
svg.lineage{display:block;max-width:100%;height:auto}
svg.lineage .lt{font-family:var(--sans);font-size:12px;font-weight:600;fill:var(--text)}
svg.lineage .ls{font-family:var(--mono);font-size:10px;fill:var(--text-3)}
svg.lineage a:hover rect.box{stroke:var(--brand);stroke-width:1.6}
.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px;font-size:11px;color:var(--text-3)}
.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px}

/* ---- 节点卡片 ---- */
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(370px,1fr));gap:14px;align-items:start}
.card{background:var(--card);border:1px solid var(--border-2);border-left:3px solid var(--border-3);
  border-radius:8px;overflow:hidden;break-inside:avoid}
.card.drift{border-color:rgba(245,155,35,.6);border-left-color:var(--warning)}
.card-hd{padding:10px 12px;border-bottom:1px solid var(--border-1)}
.card-hd .row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.card-hd .t{font-size:13px;font-weight:600;word-break:break-all}
.card-hd .id{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--text-4)}
.card-hd .at{font-family:var(--mono);font-size:10px;color:var(--text-4)}
.card-bd{padding:10px 12px}
.card-ft{padding:8px 12px;border-top:1px solid var(--border-1);font-family:var(--mono);
  font-size:10.5px;color:var(--text-3)}
.badge{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.06em;
  text-transform:uppercase;padding:1px 7px;border-radius:999px;border:1px solid var(--border-2);
  background:var(--surface);color:var(--text-3)}
.badge.drift{border-color:rgba(245,155,35,.6);background:rgba(245,155,35,.12);color:#8a5a00}
.badge.ok{border-color:rgba(29,185,84,.5);background:rgba(29,185,84,.1);color:#0d6b32}
.badge.err{border-color:rgba(226,33,52,.45);background:rgba(226,33,52,.08);color:#8d1220}

.kv{display:grid;grid-template-columns:92px 1fr;gap:3px 10px;margin:0;padding:0;
  font-family:var(--mono);font-size:11px}
.kv dt{color:var(--text-4)}
.kv dd{margin:0;color:var(--text-2);word-break:break-all}
table.t{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11px}
table.t th{text-align:left;font-weight:500;color:var(--text-3);white-space:nowrap;
  padding:4px 6px;border-bottom:1px solid var(--border-2)}
table.t td{padding:4px 6px;border-bottom:1px solid var(--border-1);color:var(--text-2);
  vertical-align:top;word-break:break-word}
table.t tr:last-child td{border-bottom:0}
table.t td.num,table.t th.num{text-align:right}
table.t.wide{display:block;overflow-x:auto}
.scroll{max-height:260px;overflow:auto;border:1px solid var(--border-1);border-radius:6px}
pre.sql{margin:0;padding:8px 10px;background:var(--surface);border-radius:6px;
  font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--text);
  white-space:pre-wrap;word-break:break-word}
pre.sql.sm{font-size:10.5px;padding:6px 8px}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{font-family:var(--mono);font-size:10px;padding:1px 6px;border-radius:4px;
  background:var(--surface);border:1px solid var(--border-1);color:var(--text-3)}
ul.plain{margin:4px 0 0;padding-left:16px;font-family:var(--mono);font-size:11px;color:var(--text-2)}
ul.plain li{margin-bottom:3px}
img.chart{display:block;max-width:100%;height:auto;border:1px solid var(--border-1);
  border-radius:6px;background:#fff}
details{margin-top:8px}
summary{cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--text-3)}
summary:hover{color:var(--brand)}

/* ---- 报告正文（report 节点的极简 markdown） ---- */
.md{font-size:12px;color:var(--text-2)}
.md .h2{margin:10px 0 4px;font-size:12.5px;font-weight:600;color:var(--brand)}
.md .h3{margin:8px 0 3px;font-size:12px;font-weight:600;color:var(--text)}
.md .p{margin:3px 0}
.md .li{margin:2px 0 2px 12px}
.md table{margin:6px 0}
.md strong{color:var(--text);font-weight:600}

/* ---- 页脚 ---- */
footer{margin-top:28px;padding-top:12px;border-top:1px solid var(--border-2);
  font-size:11px;color:var(--text-4)}
footer p{margin:3px 0}

@media print{
  body{background:#fff;padding:0;font-size:11px}
  .card-grid{grid-template-columns:1fr}
  .lineage-wrap{overflow:visible;border:0;padding:0}
  .scroll{max-height:none;overflow:visible}
  a{color:var(--text-2)}
  section{break-inside:avoid-page}
}
`;
