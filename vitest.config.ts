import { defineConfig } from "vitest/config";

/**
 * X4 核心链路集成测试配置。
 *
 * - 环境 node：ws-handler / govio-canvas / canvas-store 均为纯逻辑或可用 stub 驱动，
 *   不需要 DOM（canvas-store 的 persist 存储在测试中以 stub storage 注入）。
 * - globals: false：显式从 vitest 导入 describe/it/expect，便于 tsc 类型检查。
 * - 测试文件放 tests/integration/*.test.ts，与既有 scripts/verify-*.ts（验证脚本）互不干扰。
 * - X12 UI 测试放 tests/ui/*.test.tsx，仅在文件头显式声明 jsdom，其余文件继续使用 node。
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/integration/**/*.test.ts", "tests/ui/**/*.test.tsx"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // 集成测试各自持有一次性状态（govio-node-queue / permission 单例 / store），
    // 按文件隔离进程（默认 fork 池下每个文件独立），避免互相污染。
    isolate: true,
  },
});
