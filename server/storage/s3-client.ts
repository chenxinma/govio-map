/**
 * T3.1 零依赖 S3 REST 客户端（SigV4 + 全局 fetch）。
 *
 * 取舍（design.md 依赖对比）：`@aws-sdk/client-s3` 带来约 30+ 传递依赖；画布协作
 * 只需要 PUT/GET/DELETE/ListObjectsV2 四个操作，SigV4 用 node:crypto 自实现约
 * 百来行且可用本地 mock server 做契约测试。凭据只在请求时从 env 解析注入，
 * 不出现在任何持久化工件里（见 config.ts 安全边界）。
 */
import { createHmac, createHash } from "node:crypto";

export interface S3RequestConfig {
  endpoint: string; // https://host（含 scheme，不含尾部 /）
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
}

export interface S3Object {
  status: number;
  body: string;
  etag: string | null;
}

export class S3HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "S3HttpError";
    this.status = status;
  }
}

export const UNSIGNED_TIMEOUT_MS = 10_000;

function uriEncode(s: string, encodeSlash = true): string {
  const enc = encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return encodeSlash ? enc : enc.replace(/%2F/g, "/");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf-8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

export function objectPath(cfg: S3RequestConfig, key: string): string {
  return cfg.forcePathStyle ? `/${cfg.bucket}/${key}` : `/${key}`;
}

/**
 * SigV4 签名并发送请求。返回 {status, body, etag}；网络/超时抛错。
 * query 传 Map<string,string>（ListObjectsV2 用），key 已含 bucket 前缀逻辑外的对象键。
 */
export async function signedS3Request(
  cfg: S3RequestConfig,
  method: "GET" | "PUT" | "DELETE",
  key: string,
  opts: {
    body?: string;
    query?: Record<string, string>;
    ifMatch?: string;
    ifNoneMatch?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    now?: Date;
  } = {},
): Promise<S3Object> {
  const doFetch = opts.fetchImpl ?? fetch;
  const host = new URL(cfg.endpoint).host;
  const path = objectPath(cfg, key);
  const query = Object.entries(opts.query ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalQuery = query.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");

  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(opts.body ?? "");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (cfg.sessionToken) headers["x-amz-security-token"] = cfg.sessionToken;
  if (opts.ifMatch) headers["if-match"] = opts.ifMatch;
  if (opts.ifNoneMatch) headers["if-none-match"] = opts.ifNoneMatch;

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k].trim()}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf-8").digest("hex");

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${cfg.endpoint}${path.split("/").map((seg, i) => (i === 0 ? "" : uriEncode(seg, false))).join("/")}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? UNSIGNED_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method,
      headers: { ...headers, authorization: authHeader },
      body: opts.body,
      signal: controller.signal,
    });
    const text = method === "DELETE" ? "" : await res.text();
    return { status: res.status, body: text, etag: res.headers.get("etag") };
  } finally {
    clearTimeout(timer);
  }
}

/** ListObjectsV2 的极简 XML 解析：CommonPrefixes/Contents 的 Key 列表。 */
export function parseListKeys(xml: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) keys.push(decodeURIComponent(m[1]));
  return keys;
}
