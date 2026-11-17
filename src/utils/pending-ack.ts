/** set_model / set_thinking_level 的回执类型。 */
export type AckKind = "model" | "thinking";

export interface PendingAck {
  /** 发出请求后登记等待；同类型旧请求先行放行（只等最新一次）。 */
  track(kind: AckKind): Promise<void>;
  /** 回执到达时调用。 */
  resolve(kind: AckKind): void;
  /** 当前所有未决回执（无则立即返回）。 */
  pending(): Promise<void>;
}

/**
 * 回执闸门：防止「前端刚选完模型/思考档就发 prompt」的竞态——
 * set_model / set_thinking_level 是异步 WS 往返，未确认前发送的 prompt
 * 会用上旧模型/旧档位。回执缺失时 timeoutMs 兜底放行，永不卡死输入。
 */
export function createPendingAck(timeoutMs = 3000): PendingAck {
  const resolvers = new Map<AckKind, () => void>();
  const pendings = new Map<AckKind, Promise<void>>();

  const resolve = (kind: AckKind) => {
    const r = resolvers.get(kind);
    if (!r) return;
    resolvers.delete(kind);
    pendings.delete(kind);
    r();
  };

  return {
    track(kind) {
      resolve(kind);
      let done!: () => void;
      const promise = new Promise<void>((r) => {
        done = r;
      });
      resolvers.set(kind, done);
      pendings.set(kind, promise);
      setTimeout(() => resolve(kind), timeoutMs);
      return promise;
    },
    resolve,
    pending: () => Promise.all([...pendings.values()]).then(() => undefined),
  };
}
