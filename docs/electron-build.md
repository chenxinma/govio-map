# Electron 打包指南

将 Govio Map 打包为 Windows 桌面应用（exe）。

## 构建

```bash
npm install              # 通过 .npmrc 镜像下载 electron 二进制
npm run build:electron   # tsc -b && vite build && esbuild 编译主进程 && electron-builder
```

产物在 `release/` 目录下（NSIS 安装包 + 免安装版）。

## 脚本说明

| 脚本 | 作用 |
|------|------|
| `npm run compile:electron` | 用 esbuild 把 `electron/main.ts` + `server/**` bundle 成 `dist-electron/main.js`（依赖保持 external） |
| `npm run build:electron` | 完整构建：类型检查 + 前端打包 + 主进程编译 + electron-builder 打包 |

## 镜像加速

`.npmrc` 已配置：

```
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

npm 会把这些以 `npm_config_*` 形式传给 electron 的 postinstall 与 electron-builder，加速二进制下载。npm 可能对这两个 key 报 "Unknown project config" 警告，可忽略——功能正常。

## 架构

```
Electron 主进程 (dist-electron/main.js)
  ├─ process.chdir(userData)           # 工作目录
  ├─ dotenv 加载 userData/.env          # API key
  ├─ 静态 HTTP server :5173            # 提供 dist/ 前端
  ├─ startBackend(:5174)               # /api/preview + /ws + /canvas
  └─ BrowserWindow → http://localhost:5173
```

前端通过 `window.location.port + 1` 推导后端端口（5173 + 1 = 5174），与 dev 模式完全一致，**前端零改动**。

后端逻辑从 Vite 插件解耦到 `server/backend.ts` 的 `startBackend()`，dev（`wsPlugin`）与生产（Electron 主进程）共用。

## 运行时依赖

打包后的 exe 运行时仍需以下条件（这些不随 exe 打包）：

1. **govio-cli 在系统 PATH** — `server/agent.ts` 通过 `execSync("govio-cli ...")` 调用。
2. **`userData/.env`** — 含至少一个 AI provider key：
   ```bash
   ANTHROPIC_API_KEY=sk-ant-xxxxx
   # 或 OPENAI_API_KEY / GEMINI_API_KEY / MISTRAL_API_KEY
   ```
   `userData` 路径：`%APPDATA%/Govio Map`（Windows）。
3. **`userData/.govio/`** — govio-cli 的数据目录（observe dataframes 等）。
4. **skills** — pi agent 的 skills 目录（dev 下位于项目根，生产需放到 agent 目录）。
5. **网络** — `index.html` 引用 Google Fonts（DM Sans / JetBrains Mono）；离线时降级为系统字体。

## 打包注意事项

- `asarUnpack` 解包了 `@silvia-odwyer/photon-node`（WASM）与 `@mariozechner/clipboard`（原生模块），避免 asar 内加载失败。
- 主进程与后端同进程运行（agent 多为异步 IO，不阻塞 UI）；如遇卡顿可后续拆分为子进程。
- 端口 5173/5174 固定（与 dev 一致），被占用会启动失败。
