/**
 * T3.1 sidecar 路径单一来源：画布工件与存储绑定文件的命名规则。
 * session-history.ts 以 re-export 保持既有公共 API（canvasPathFor）兼容。
 */

/** 画布 sidecar 路径；同目录下还有权限审计/注入留痕 sidecar 与本绑定文件。 */
export function canvasPathFor(sessionFile: string): string {
  return sessionFile + ".canvas.json";
}

/**
 * 逐画布存储绑定 sidecar（T3.1 配置模型的落盘形态）。
 * 只存 profile 引用与同步元数据；凭据、endpoint 明文一律不在此文件（design.md 凭据安全节）。
 */
export function storageBindingPathFor(sessionFile: string): string {
  return sessionFile + ".storage.json";
}

/**
 * 只读分享开关 sidecar（T3.5）：`<session>.jsonl.share.json`。
 *
 * 文件存在且 `enabled:true` 即「该会话已开启活视图分享」——它同时是 token 的
 * **访问控制**（未开启的会话其派生 token 解析不到）与**撤销机制**（删除文件即失效）。
 * 仅本地，不随 T3.1 同步到 S3（活视图只读本地当前会话，见 T3.5 design.md）。
 */
export function shareStatePathFor(sessionFile: string): string {
  return sessionFile + ".share.json";
}
