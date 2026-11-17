/**
 * `/import <bundle 路径>`：把 T3.6 `/export` 产出的包导入成一个**历史会话**（T3.7）。
 *
 * 分工：浏览器读不到任意本地路径，所以**路径交给服务端读**（`POST /api/session-import`）；
 * 校验（格式版本 / 文件清单 / 逐文件 sha256 / 清单外条目）与落盘全部在服务端完成，
 * 且**校验全绿前零写入**（`server/session-import.ts`，用户裁决 ④⑤）。本模块只做三件事：
 * 发请求、把错误码翻成人话、把成功结果整理成一句可展示的反馈。
 *
 * 基址纪律（X25）：一律 `apiBaseFrom(window.location.origin) ?? ''`，绝不硬编码端口 +1。
 */
import { apiBaseFrom } from "../utils/share-link";
import type { ImportErrorCode, SessionImportResult } from "../types/bundle";

/** 导入失败（后端拒绝或网络不通）——消息已经是给用户看的中文。 */
export class SessionImportError extends Error {
  /** 后端错误码（网络层失败时缺省），供测试与日志分类用。 */
  readonly code?: ImportErrorCode | "network" | "http";
  constructor(message: string, code?: ImportErrorCode | "network" | "http") {
    super(message);
    this.name = "SessionImportError";
    this.code = code;
  }
}

export interface ImportBundleDeps {
  /** 页面 origin（`window.location.origin`）；API 基址由它推导。 */
  pageOrigin: string;
  /** 要导入的包路径（用户在 `/import` 后给的那一段）。 */
  bundlePath: string;
  /** 测试注入点。 */
  fetchImpl?: typeof fetch;
}

/** 错误码 → 人话（与 `docs/specs/06-backend.md` 的错误码表一一对应）。 */
const IMPORT_ERROR_TEXT: Record<ImportErrorCode, string> = {
  "invalid-path": "路径不合法（空路径、UNC/设备路径，或不是 .zip 文件），已拒绝导入。",
  "bundle-not-found": "找不到这个打包文件，请确认路径与文件名（区分大小写与扩展名 .zip）。",
  "not-a-file": "导入目标必须是常规文件（不能是目录或符号链接）。",
  "bundle-too-large": "打包文件过大，已拒绝导入。",
  "bundle-unreadable": "不是合法的 zip 打包文件，或使用了不支持的压缩方式。",
  "too-many-files": "包内条目数超过上限，已拒绝导入（疑似非本工具产物）。",
  "uncompressed-too-large": "解压后体积超过上限，已拒绝导入（疑似 zip 炸弹）。",
  "unsafe-entry": "包内含非法路径条目（绝对路径 / .. / 子目录），已整包拒绝，防目录穿越。",
  "duplicate-entry": "包内条目重名，清单无法唯一对应，已整包拒绝。",
  "manifest-missing": "包内缺少 bundle.json，不是可导入的 Govio 会话包。",
  "manifest-invalid": "包内 bundle.json 形状不符（缺字段或不是合法 JSON）。",
  "format-mismatch": "不是 Govio 会话包（bundle.json 的 format 不符）。",
  "version-unsupported": "包格式版本本端不支持，请升级 Govio Map 后重试。",
  "entry-missing": "清单登记的文件在包里不存在（包不完整），已拒绝导入。",
  "entry-unexpected": "包内出现清单未登记的条目，已整包拒绝（防夹带）。",
  "checksum-mismatch": "文件校验和不符，包可能已损坏或被改动，已拒绝导入。",
  "payload-invalid": "包内 canvas.json / manifests.json 不是合法内容，已拒绝导入。",
  "transcript-invalid": "包内 session.jsonl 不是合法的 pi 会话记录，无法作为历史会话落地。",
  "target-conflict": "目标会话文件已存在，拒绝覆盖（导入一律生成新会话 id）。",
  "write-failed": "写入会话文件失败（磁盘或权限问题），已回滚，未留下半成品。",
};

/** 把后端响应翻成异常（不静默失败、不抛裸状态码）。 */
async function describeImportResponse(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as
    | { error?: string; message?: string; detail?: string }
    | null;
  const code = body?.error as ImportErrorCode | undefined;
  const text = body?.message || (code && IMPORT_ERROR_TEXT[code]) || `后端导入通道返回 HTTP ${res.status}`;
  throw new SessionImportError(text, code ?? "http");
}

/**
 * 执行导入。
 *
 * @throws {SessionImportError} 路径/包内容/网络任一环节失败（消息可直接展示给用户）
 */
export async function importSessionBundle(deps: ImportBundleDeps): Promise<SessionImportResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = apiBaseFrom(deps.pageOrigin) ?? "";
  const bundlePath = typeof deps.bundlePath === "string" ? deps.bundlePath.trim() : "";
  if (bundlePath === "") {
    throw new SessionImportError("用法：/import <bundle 路径>（T3.6 /export 产出的 .govio-bundle.zip）");
  }

  let res: Response;
  try {
    res = await fetchImpl(`${apiBase}/api/session-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: bundlePath }),
    });
  } catch (err) {
    throw new SessionImportError(
      `无法连接后端导入通道（${err instanceof Error ? err.message : String(err)}）；请确认 Govio Map 后端已启动。`,
      "network",
    );
  }
  if (!res.ok) await describeImportResponse(res);

  const payload = (await res.json().catch(() => null)) as (SessionImportResult & { ok?: boolean }) | null;
  if (!payload || payload.ok !== true || typeof payload.sessionFile !== "string") {
    throw new SessionImportError("后端导入回执形状不符（缺 sessionFile），未确认导入成功。", "http");
  }
  return payload;
}

/** 成功反馈文案：会话名 + 节点数（scope 1 要求），并如实说明缺什么、需要注意什么。 */
export function describeImportResult(result: SessionImportResult): string {
  // 会话名可能为空（源会话就没被命名过，真机冒烟里就是这种）；此时不能拿新 uuid 充数，
  // 而是告知用户会话列表会按首条消息显示（ChatPanel 的 `s.name || s.preview` 同款口径）。
  const name = result.sessionName?.trim();
  const label = name ? `「${name}」` : "（未命名，会话列表里按首条消息显示）";
  const parts = [`${result.nodeCount} 节点`, `${result.edgeCount} 边`, `${result.messageCount} 条对话`];
  if (result.manifestCount > 0) parts.push(`${result.manifestCount} 份分析留痕`);
  const missingData = result.excludedParquet?.count ?? 0;
  const absent = result.excludedParquet?.absent?.length ?? 0;
  if (missingData > 0 || absent > 0) {
    parts.push(`数据文件未随包（${missingData + absent} 个 DataFrame 需重新加载才能预览/复跑）`);
  }
  if (result.storageProfile) {
    parts.push(`源实例曾绑定存储 profile「${result.storageProfile}」，本机未绑定`);
  }
  return `已导入为历史会话${label}（${parts.join(" · ")}）`;
}
