// node-sql-parser 只发 CJS（index.js 是打包产物，cjs-module-lexer 认不出命名导出），
// Node 原生 ESM 里 `import { Parser }` 会直接 SyntaxError，因此统一走 default（=module.exports）
// 取 Parser。包自带的 types.d.ts 没有 default 导出，这里声明我们用到的最小面。
// 取舍与风险见 docs/tasks/X21-sql-output-columns/design.md。
declare module "node-sql-parser" {
  export interface NodeSqlParserAstifyOptions {
    database?: string;
  }

  export interface NodeSqlParserInstance {
    /** 解析失败会抛错；返回值是各方言 AST，形状按方言不同，本仓只读取需要的字段 */
    astify(sql: string, options?: NodeSqlParserAstifyOptions): unknown;
  }

  const nodeSqlParser: {
    Parser: new (syntax?: unknown) => NodeSqlParserInstance;
  };

  export default nodeSqlParser;
}
