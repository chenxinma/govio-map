/**
 * SQL 输出列名抽取（X21）。
 *
 * 双通道：`node-sql-parser` 做主解析（正确处理行内 `--` / `/* *\/` 注释、CASE、嵌套子查询、
 * DISTINCT、多行格式），解析失败或方言不支持（DuckDB 的 `QUALIFY`、`GROUP BY ALL`、
 * `* EXCLUDE`、struct 字面量等）时**回落原正则管道**——回落管道同样先剥注释，
 * 因此任何输入都不会比 X21 之前更差。
 *
 * 纪律（对齐 `server/extensions/govio-canvas.ts` 的历史坏例，见
 * `docs/tasks/BUGFIX-sql-columns-and-graph-cache.md`）：
 * - 括号 / 引号内的逗号不是列分隔符（旧实现按 `,` 硬切，产出 `amount)`、`0)` 垃圾列名）
 * - 无别名的表达式、`*`、`t.*` 不产列名（返回空，由调用方回退 `tableName.*`）
 * - 解析器失败时禁止猜测列名：要么走兜底管道，要么不产名字
 *
 * `outputColumns` 契约形状不变（`string[]`）；服务端建节点与前端「保存 SQL 后跟手刷新」共用本模块。
 */
import nodeSqlParser from "node-sql-parser";

/** 依次尝试的方言：项目实际数据源是 DuckDB / Postgres，MySQL 仅用于反引号标识符 */
const PARSER_DIALECTS = ["postgresql", "mysql"];

type ParserInstance = InstanceType<typeof nodeSqlParser.Parser>;

/** undefined=未初始化，null=不可用（require 失败），其余为单例 */
let parserInstance: ParserInstance | undefined | null;

function getParser(): ParserInstance | null {
  if (parserInstance === undefined) {
    try {
      parserInstance = new nodeSqlParser.Parser();
    } catch {
      parserInstance = null;
    }
  }
  return parserInstance;
}

/** 去标识符引号："x" / `x` / [x] / 'x' */
function stripIdentQuotes(ident: string): string {
  return ident.replace(/^["'`\x5b]|["'`\x5d]$/g, "");
}

/**
 * 兜底管道的标识符字符类（X22 BUGFIX）。
 *
 * 旧实现把别名/裸列收紧成 ASCII `[A-Za-z_][A-Za-z0-9_$]*`（为修「函数内逗号切碎表达式」
 * 那次改动引入），中文别名（`AS 国家`）一律解析不出列名 → `extractSelectColumns` 返回空
 * → 上层回退成 `tableName.*`，画布「输出列」从 `国家 / 销售额 / 订单数` 退化成
 * `chocolate.*`。X21 的 parser 主路径能解析中文别名，但 DuckDB 特有语法（QUALIFY /
 * `* EXCLUDE` / `GROUP BY ALL` 等）会回落到本管道，故这里必须同样支持 Unicode 标识符。
 *
 * **反垃圾约束保留**：别名 token 内不允许 ASCII 括号/引号/方括号/逗号/星号与空白，
 * 所以 `amount)`、`0)` 这类碎片不会因放宽字符类而复现（见 tests/integration/select-columns.test.ts）。
 */
const IDENT_SRC = String.raw`[\p{L}\p{N}_$][\p{L}\p{N}_$]*`;
/** 别名 token：引号形式（"x" / `x` / [x] / 'x'）优先，否则裸标识符（可带全角标点尾缀，如 `销售额（万元）`） */
const ALIAS_TOKEN_SRC =
  String.raw`"[^"]+"` +
  "|\\x60[^\\x60]+\\x60|\\[[^\\]]+\\]|'[^']+'" +
  `|${IDENT_SRC}` +
  String.raw`[^\s\x22\x27\x60\x5b\x5d(),*]*`;
const AS_ALIAS_RE = new RegExp(`(?:^|\\s)AS\\s+(${ALIAS_TOKEN_SRC})\\s*$`, "iu");
const IMPLICIT_ALIAS_RE = new RegExp(`[)\\w"\\]]\\s+(${ALIAS_TOKEN_SRC})\\s*$`, "u");
const BARE_COLUMN_RE = new RegExp(`^(?:${IDENT_SRC}\\s*\\.\\s*)*(${IDENT_SRC})$`, "u");

/** 候选列名清洗：去引号、去空白，`*` 与空串视为「无列名」 */
function normalizeColumnName(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = stripIdentQuotes(text.trim());
  return trimmed && trimmed !== "*" ? trimmed : null;
}

/**
 * 剥离 `--` / `#` 行注释与 `/* *\/` 块注释（字符串字面量与引号标识符内部不动）。
 *
 * 注释文本保留换行，行数与原文一致；块注释换成一个空格，避免相邻 token 粘连。
 * 返回值保证与输入的顶层逗号 / 括号结构等价，故可安全喂给正则管道。
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    // 字符串 / 引号标识符：原样拷贝到结束引号（ doubling '' "" `` 视为转义）
    if (ch === "'" || ch === '"' || ch === "`") {
      const close = ch;
      out += ch;
      i += 1;
      while (i < sql.length) {
        const cur = sql[i];
        out += cur;
        i += 1;
        if (cur === close) {
          if (sql[i] === close) {
            out += close;
            i += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        if (sql[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 按顶层逗号切分 SELECT 项（括号与字符串内的逗号不切，如 `ROUND(x, 2)`） */
function splitTopLevelCommas(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let buf = "";
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      items.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  items.push(buf);
  return items;
}

/**
 * 单个 SELECT 项 → 输出列名（兜底管道）。
 *
 * 旧实现 `trim().split(",")` 再取尾部：遇到函数内逗号就把表达式切碎，
 * 产生 `amount)`、`0)` 这类垃圾列名（实测 gov-104/gov-105/gov-110）。
 */
function columnNameOf(item: string): string | null {
  const expr = item.trim();
  if (!expr) return null;
  // 显式别名：`AS alias`（别名可带引号/反引号/方括号，也可以是中文）
  const asMatch = expr.match(AS_ALIAS_RE);
  if (asMatch) return stripIdentQuotes(asMatch[1]);
  // 隐式别名：`SUM(x) total`（别名前的表达式以 `)` 结尾）；`price * qty` 不算
  const implicit = expr.match(IMPLICIT_ALIAS_RE);
  if (implicit) {
    const aliasAt = expr.lastIndexOf(implicit[1]);
    if (expr.slice(0, aliasAt).trim().endsWith(")")) return stripIdentQuotes(implicit[1]);
  }
  // 裸列（可带表限定，标识符可含中文）
  const bare = expr.match(BARE_COLUMN_RE);
  if (bare) return bare[1];
  // 其余（无别名的表达式、`*`、`t.*`）不产列名，交由调用方回退
  return null;
}

/** 兜底管道：正则抽取（X21 的既有行为 + 先剥注释） */
export function extractSelectColumnsByRegex(sql: string): string[] {
  const match = stripSqlComments(sql).match(/SELECT\s+([\s\S]+?)\s+FROM/i);
  if (!match) return [];
  return splitTopLevelCommas(match[1])
    .map((col) => columnNameOf(col))
    .filter((col): col is string => !!col);
}

/** AST 里的别名（`as` 可能是字符串，也可能是带 value 的节点） */
function aliasFromColumnItem(item: Record<string, unknown>): string | null {
  const raw = item.as;
  if (typeof raw === "string") return normalizeColumnName(raw);
  if (raw && typeof raw === "object") {
    const value = (raw as Record<string, unknown>).value;
    if (typeof value === "string") return normalizeColumnName(value);
  }
  return null;
}

/** 无别名时，只有裸列引用（column_ref）产列名；函数/CASE/二元表达式/字面量一律跳过 */
function columnNameFromExpr(expr: unknown): string | null {
  if (!expr || typeof expr !== "object") return null;
  const node = expr as Record<string, unknown>;
  if (node.type !== "column_ref") return null;
  const column = node.column;
  if (typeof column === "string") return normalizeColumnName(column);
  if (column && typeof column === "object") {
    const inner = column as Record<string, unknown>;
    const value = (typeof inner.expr === "object" && inner.expr !== null
      ? (inner.expr as Record<string, unknown>).value
      : inner.value);
    if (typeof value === "string") return normalizeColumnName(value);
  }
  return null;
}

function namesFromSelectColumns(columns: unknown): string[] {
  if (!Array.isArray(columns)) return [];
  const names: string[] = [];
  for (const item of columns) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = aliasFromColumnItem(record) ?? columnNameFromExpr(record.expr);
    if (name) names.push(name);
  }
  return names;
}

/**
 * 从一条语句 AST 里定位 SELECT 列表。
 * 返回 null = 「这条语句没有输出列概念」，空数组 = 「有 SELECT 列表但取不出可命名列」。
 */
function columnsOfStatement(node: unknown): string[] | null {
  if (!node || typeof node !== "object") return null;
  const ast = node as Record<string, unknown>;
  if (ast.type === "select") {
    return ast.columns === undefined || ast.columns === null ? null : namesFromSelectColumns(ast.columns);
  }
  // INSERT ... SELECT：输出列来自子查询（VALUES 形态没有列名概念）
  if (ast.type === "insert") return columnsOfStatement(ast.values);
  // CREATE TABLE / VIEW ... AS SELECT
  if (ast.type === "create") return columnsOfStatement(ast.query_expr);
  // 部分方言把 UNION/INTERSECT 放在 selects 数组里
  if (Array.isArray(ast.selects)) {
    for (const branch of ast.selects) {
      const cols = columnsOfStatement(branch);
      if (cols && cols.length > 0) return cols;
    }
    return [];
  }
  return null;
}

/**
 * 主解析通道。
 * @returns `string[]`＝解析成功（可能为空，空即「无命名输出列」，权威结果）；`null`＝解析不可用，需要兜底
 */
export function extractSelectColumnsByParser(sql: string): string[] | null {
  const parser = getParser();
  if (!parser) return null;
  for (const database of PARSER_DIALECTS) {
    try {
      const ast = parser.astify(sql, { database });
      const statements = Array.isArray(ast) ? ast : [ast];
      for (const statement of statements) {
        const cols = columnsOfStatement(statement);
        if (cols && cols.length > 0) return cols;
      }
      return [];
    } catch {
      // 方言不支持 / 语法错误：换下一个方言，全失败则由调用方回落正则
    }
  }
  return null;
}

/** SQL → 输出列名（解析器优先，失败回落正则；契约形状 string[] 不变） */
export function extractSelectColumns(sql: string): string[] {
  const parsed = extractSelectColumnsByParser(sql);
  if (parsed !== null) return parsed;
  return extractSelectColumnsByRegex(sql);
}
