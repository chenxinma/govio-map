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
