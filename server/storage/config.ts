/**
 * T3.1 S3 profile 配置（服务端侧，凭据只走 env 引用）。
 *
 * 安全边界（design.md 凭据安全节）：
 *  - 配置文件只存环境变量名（accessKeyIdEnv/secretAccessKeyEnv/sessionTokenEnv），
 *    真实密钥永远不落配置文件、画布 JSON、分享记录或日志；
 *  - 配置文件位置：env `GOVIO_S3_PROFILES_FILE` 覆写，缺省 `<cwd>/.govio/storage-profiles.json`；
 *  - profile id / bucket / prefix 全部白名单校验后才参与 S3 key 拼接。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export interface S3ProfileConfig {
  /** 端点（S3 兼容网关如 MinIO/R2 亦可）；缺省 https://s3.<region>.amazonaws.com */
  endpoint?: string;
  region: string;
  bucket: string;
  /** key 前缀（可空 = bucket 根） */
  prefix?: string;
  accessKeyIdEnv: string;
  secretAccessKeyEnv: string;
  sessionTokenEnv?: string;
  /** path-style 访问（自建网关通常需要）；缺省 true，兼容性最好 */
  forcePathStyle?: boolean;
}

export interface StorageProfilesFile {
  version: 1;
  profiles: Record<string, S3ProfileConfig>;
}

export const S3_PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function badProfile(msg: string): Error {
  return new Error(`storage profile invalid: ${msg}`);
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

function assertEnvName(value: unknown, label: string): string {
  if (typeof value !== "string" || !ENV_NAME_RE.test(value)) throw badProfile(label);
  return value;
}

function assertBucket(bucket: unknown): string {
  if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw badProfile(`bucket name: ${String(bucket)}`);
  }
  return bucket;
}

function assertPrefix(prefix: unknown): string {
  if (prefix === undefined || prefix === null || prefix === "") return "";
  if (typeof prefix !== "string" || prefix.startsWith("/") || prefix.includes("..") || !/^[A-Za-z0-9._/-]{1,256}$/.test(prefix)) {
    throw badProfile(`prefix: ${String(prefix).slice(0, 32)}`);
  }
  return prefix.replace(/\/+$/, "");
}

/** 校验并归一化一份 profiles 对象（文件/env 载入与测试共用）。 */
export function parseStorageProfiles(raw: unknown): StorageProfilesFile {
  const obj = raw as { version?: unknown; profiles?: Record<string, unknown> } | null;
  if (!obj || typeof obj !== "object" || obj.version !== 1 || !obj.profiles || typeof obj.profiles !== "object") {
    throw badProfile("expected {version:1, profiles:{...}}");
  }
  const out: StorageProfilesFile = { version: 1, profiles: {} };
  for (const [id, pRaw] of Object.entries(obj.profiles)) {
    if (!S3_PROFILE_ID_RE.test(id)) throw badProfile(`profile id: ${id}`);
    const p = pRaw as Record<string, unknown> | null;
    if (!p || typeof p !== "object") throw badProfile(`profile ${id}`);
    if (typeof p.region !== "string" || !/^[a-z0-9-]{1,40}$/.test(p.region)) throw badProfile(`profile ${id} region`);
    const accessKeyIdEnv = assertEnvName(p.accessKeyIdEnv, `profile ${id} accessKeyIdEnv`);
    const secretAccessKeyEnv = assertEnvName(p.secretAccessKeyEnv, `profile ${id} secretAccessKeyEnv`);
    const sessionTokenEnv = p.sessionTokenEnv === undefined ? undefined : assertEnvName(p.sessionTokenEnv, `profile ${id} sessionTokenEnv`);
    if (p.endpoint !== undefined) {
      let url: URL;
      try {
        url = new URL(String(p.endpoint));
      } catch {
        throw badProfile(`profile ${id} endpoint`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw badProfile(`profile ${id} endpoint protocol`);
    }
    out.profiles[id] = {
      endpoint: p.endpoint === undefined ? undefined : String(p.endpoint),
      region: p.region,
      bucket: assertBucket(p.bucket),
      prefix: assertPrefix(p.prefix),
      accessKeyIdEnv,
      secretAccessKeyEnv,
      sessionTokenEnv,
      forcePathStyle: p.forcePathStyle !== false,
    };
  }
  return out;
}

export function storageProfilesPath(): string {
  const fromEnv = process.env.GOVIO_S3_PROFILES_FILE;
  if (fromEnv) return resolvePath(fromEnv);
  return resolvePath(process.cwd(), ".govio", "storage-profiles.json");
}

let cache: { path: string; mtimeMs: number; profiles: StorageProfilesFile } | null = null;

/** 读取 profiles（mtime 变化即失效）；文件不存在 → 空表（无配置 = 全本地，完全向后兼容）。 */
export function loadStorageProfiles(): StorageProfilesFile {
  const path = storageProfilesPath();
  if (!existsSync(path)) {
    cache = null;
    return { version: 1, profiles: {} };
  }
  const mtimeMs = statSync(path).mtimeMs;
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.profiles;
  const profiles = parseStorageProfiles(JSON.parse(readFileSync(path, "utf-8")));
  cache = { path, mtimeMs, profiles };
  return profiles;
}

/** 测试辅助：清空 mtime 缓存（不改生产行为）。 */
export function resetStorageProfilesCacheForTests(): void {
  cache = null;
}

/** 解析 profile → 带凭据的内部视图；env 缺失时抛错（错误信息只含 env 名，不含值）。 */
export interface ResolvedS3Target {
  profileId: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle: boolean;
}

export function resolveS3Target(profileId: string): ResolvedS3Target {
  const profiles = loadStorageProfiles();
  const p = profiles.profiles[profileId];
  if (!p) throw new Error(`storage profile not found: ${profileId}`);
  const accessKeyId = process.env[p.accessKeyIdEnv];
  const secretAccessKey = process.env[p.secretAccessKeyEnv];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`storage profile ${profileId}: credentials env not set (${p.accessKeyIdEnv}/${p.secretAccessKeyEnv})`);
  }
  const endpoint = p.endpoint ?? `https://s3.${p.region}.amazonaws.com`;
  return {
    profileId,
    endpoint: endpoint.replace(/\/+$/, ""),
    region: p.region,
    bucket: p.bucket,
    prefix: p.prefix ?? "",
    accessKeyId,
    secretAccessKey,
    sessionToken: p.sessionTokenEnv ? process.env[p.sessionTokenEnv] : undefined,
    forcePathStyle: p.forcePathStyle !== false,
  };
}
