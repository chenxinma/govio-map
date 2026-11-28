/**
 * 数据源 connect-args 文本解析（每行 key=value；X34 数据源表单共用）。
 * 独立于组件文件，保证 DatasourceForm 只导出组件（react-refresh/only-export-components）。
 *
 * 返回 null 表示存在不含 = 的非空行（表单即时校验用）。
 */
export function parseConnectArgs(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}
