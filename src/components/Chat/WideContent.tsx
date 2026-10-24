import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";
import { Maximize2 } from "lucide-react";
import WideContentModal, { type WideContentKind } from "./WideContentModal";

/**
 * 宽内容（表格 / 代码块）包裹组件：
 * - hover 时右上角浮出「全屏查看」按钮
 * - 点击后在全屏 overlay 中舒展渲染（表格不折行，超宽横向滚动）
 * Chat 侧栏宽度有限，宽 markdown 表格在此折叠查看体验差，全屏是主要阅读场景。
 */
function WideContentWrapper({
  kind,
  content,
  language,
  children,
}: {
  kind: WideContentKind;
  content: string;
  language?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative group/wide my-2">
      {children}
      <button
        onClick={() => setExpanded(true)}
        className="absolute top-1 right-1 z-10 opacity-0 group-hover/wide:opacity-100 transition-opacity flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-bg-surface/95 border border-border-default text-text-secondary hover:text-brand hover:border-brand/50 shadow-sm"
        title="全屏查看"
      >
        <Maximize2 size={10} />
        <span>全屏查看</span>
      </button>
      {expanded && (
        <WideContentModal
          kind={kind}
          content={content}
          language={language}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  );
}

function toText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toText).join("");
  return "";
}

type MdTableProps = ComponentProps<"table"> & ExtraProps;

/** 表格 markdown 组件：保留原渲染 + 全屏查看入口 */
export function MarkdownTable(props: MdTableProps) {
  const { node, children, ...rest } = props;
  const markdown = useMemo(() => serializeTable(node), [node]);

  // hast node 不能作为 DOM 属性透传
  const tableProps = rest as ComponentProps<"table">;

  return (
    <WideContentWrapper kind="table" content={markdown}>
      <div className="overflow-x-auto">
        <table {...tableProps} style={{ width: "max-content", minWidth: "100%" }}>
          {children}
        </table>
      </div>
    </WideContentWrapper>
  );
}

/**
 * 代码块 markdown 组件（带 language-* class 的 code）。
 * 块级代码包一层带全屏入口的 pre；行内 code 原样渲染。
 */
export function MarkdownCode(props: ComponentProps<"code"> & ExtraProps) {
  const { children, className } = props;
  // hast node 不能作为 DOM 属性透传，显式排除
  const codeProps: ComponentProps<"code"> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k !== "node" && k !== "children" && k !== "className") {
      (codeProps as Record<string, unknown>)[k] = v;
    }
  }
  const isBlock = Boolean(className?.includes("language-")) || toText(children).includes("\n");
  const language = /language-(\S+)/.exec(className || "")?.[1];
  const text = toText(children).replace(/\n$/, "");

  if (!isBlock) {
    return (
      <code className={className} {...codeProps}>
        {children}
      </code>
    );
  }

  return (
    <WideContentWrapper kind="code" content={text} language={language}>
      <pre>
        <code className={className} {...codeProps}>
          {children}
        </code>
      </pre>
    </WideContentWrapper>
  );
}

/**
 * react-markdown 的 table 节点是 hast 树（element/text），
 * 逆向序列化回 GFM markdown 供全屏查看器重新渲染。
 */
function serializeTable(node: unknown): string {
  type HastNode = {
    type?: string;
    tagName?: string;
    value?: string;
    children?: HastNode[];
  };
  const n = node as HastNode | undefined;
  if (!n) return "";

  const cellText = (cell: HastNode): string =>
    (cell.children ?? [])
      .map((c) => (c.type === "text" ? (c.value ?? "") : c.type === "element" ? cellText(c) : ""))
      .join("")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ")
      .trim();

  const rows: HastNode[] = [];
  const walk = (el: HastNode) => {
    for (const child of el.children ?? []) {
      if (child.type === "element" && child.tagName === "tr") rows.push(child);
      else if (child.type === "element") walk(child);
    }
  };
  walk(n);
  if (rows.length === 0) return "";

  const grid = rows.map((tr) =>
    (tr.children ?? [])
      .filter((c) => c.type === "element" && (c.tagName === "th" || c.tagName === "td"))
      .map(cellText)
  );
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;

  const head = pad(grid[0]);
  const divider = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
  const body = grid.slice(1).map(pad);
  return [head, divider, ...body].join("\n");
}
