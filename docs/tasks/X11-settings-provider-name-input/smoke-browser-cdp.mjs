/**
 * X11 冒烟：真实浏览器（moli CDP）验证 LLM 设置对话框 provider name 输入框
 * 连续输入不失焦、DOM 节点不重挂载、空名/重名校验生效。
 * 脚本置于 repo 外（D:/tmp），不污染工作区。
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire("D:/Work/gov-io/govio-map/package.json");
const WebSocket = require("ws");

const CDP = "http://127.0.0.1:9222";
const APP_URL = "http://localhost:5173/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((res, rej) => { const i = ++this.id; this.pending.set(i, { res, rej }); this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

async function acquireTarget() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  let t = list.find((x) => x.type === "page" && x.url.includes("localhost:5173"));
  if (!t) {
    const res = await fetch(`${CDP}/json/new?url=${encodeURIComponent(APP_URL)}`, { method: "PUT" });
    t = await res.json();
  }
  return t;
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });

async function waitFor(cdp, expr, tries = 25, gap = 800) {
  for (let i = 0; i < tries; i++) {
    const v = await cdp.eval(expr);
    if (v) return v;
    await sleep(gap);
  }
  return null;
}

const target = await acquireTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.once("open", r));
const cdp = new Cdp(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Page.navigate", { url: APP_URL });

const ready = await waitFor(cdp, `document.querySelector('button[title="设置"]') ? true : null`, 30, 1000);
check("应用加载完成（header 设置按钮可见）", ready);
if (!ready) { report(); process.exit(1); }

// 打开 LLM 设置对话框
await cdp.eval(`document.querySelector('button[title="设置"]').click(); true`);
const inputReady = await waitFor(
  cdp,
  `(() => { const el = document.querySelector('input[placeholder="provider name"]'); return el ? { value: el.value } : null; })()`,
  15, 800
);
check("LLM 设置对话框打开且 provider name 输入框已渲染", inputReady !== null, `value=${JSON.stringify(inputReady?.value)}`);
if (inputReady === null) { report(); process.exit(1); }

// 标记当前 DOM 节点、聚焦、光标置于末尾
const baseValue = await cdp.eval(`(() => {
  const el = document.querySelector('input[placeholder="provider name"]');
  el.dataset.x11Marker = 'node-1';
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  return el.value;
})()`);
check("输入前焦点落在 provider name 输入框",
  await cdp.eval(`document.activeElement === document.querySelector('input[placeholder="provider name"]')`));

// ── 核心：逐字符真实按键输入 ──
const typed = "hotfix1";
const perChar = [];
for (const ch of typed) {
  const k = { key: ch, text: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.charCodeAt(0) };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
  await sleep(200);
  perChar.push(await cdp.eval(`(() => {
    const el = document.querySelector('input[placeholder="provider name"]');
    return { value: el.value, sameNode: el.dataset.x11Marker === 'node-1', focused: document.activeElement === el, caret: el.selectionStart };
  })()`));
}
const expected = baseValue + typed;
const last = perChar[perChar.length - 1];
check(`连续输入 ${typed.length} 个字符，值累积为 "${expected}"`, last?.value === expected, JSON.stringify(perChar.map((p) => p?.value)));
check("每次按键后 DOM 节点未被重挂载（dataset 标记仍在）", perChar.every((p) => p?.sameNode), JSON.stringify(perChar.map((p) => p?.sameNode)));
check("每次按键后焦点仍在输入框（光标不跳走）", perChar.every((p) => p?.focused), JSON.stringify(perChar.map((p) => p?.focused)));
check("光标位置随输入推进至末尾", last?.caret === expected.length, JSON.stringify(perChar.map((p) => p?.caret)));

// ── 退格清空（修复前 !newName.trim() early-return 会吞掉清空动作）──
for (let i = 0; i < expected.length; i++) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await sleep(140);
}
const cleared = await cdp.eval(`(() => {
  const el = document.querySelector('input[placeholder="provider name"]');
  return { value: el.value, sameNode: el.dataset.x11Marker === 'node-1', focused: document.activeElement === el,
    err: document.body.textContent.includes('Provider 名称不能为空'),
    errSpans: [...document.querySelectorAll('span.text-error')].filter((s) => s.textContent.includes('Provider 名称不能为空')).length,
    saveDisabled: [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')?.disabled };
})()`);
check("连续退格可清空名称（空名不再被吞）", cleared?.value === "", JSON.stringify(cleared));
check("清空过程仍聚焦、节点未重挂载", cleared?.sameNode && cleared?.focused, JSON.stringify(cleared));
check("空名 → 就地提示「Provider 名称不能为空」（卡片内 + 页脚共 2 处）且保存禁用",
  cleared?.err && cleared?.errSpans >= 2 && cleared?.saveDisabled, JSON.stringify(cleared));

// ── 重名检测（provider 不足 2 个时先点「添加 Provider」）──
const added = await cdp.eval(`(() => {
  const inputs = [...document.querySelectorAll('input[placeholder="provider name"]')];
  if (inputs.length >= 2) return { added: false, count: inputs.length };
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('添加 Provider'));
  if (!btn) return { added: false, count: inputs.length, why: 'no add button' };
  btn.click();
  return { added: true, count: inputs.length };
})()`);
if (added?.added) await waitFor(cdp, `[...document.querySelectorAll('input[placeholder="provider name"]')].length >= 2 ? true : null`, 10, 400);
check("新增第二个 provider 不重挂载既有卡片（首卡 dataset 标记仍在）",
  await cdp.eval(`(() => { const el = document.querySelector('input[placeholder="provider name"]'); return el.dataset.x11Marker === 'node-1' && [...document.querySelectorAll('input[placeholder="provider name"]')].length >= 2; })()`),
  JSON.stringify(added));

const dupSetup = await cdp.eval(`(() => {
  const inputs = [...document.querySelectorAll('input[placeholder="provider name"]')];
  if (inputs.length < 2) return { skipped: true, count: inputs.length };
  const name = inputs[1].value;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inputs[0], name);
  inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
  return { name, count: inputs.length };
})()`);
if (dupSetup?.skipped) {
  check("重名提示（provider 数 < 2，跳过）", true, JSON.stringify(dupSetup));
} else {
  await sleep(400);
  const dupState = await cdp.eval(`(() => ({ dup: document.body.textContent.includes('Provider 名称重复'),
    dupSpans: [...document.querySelectorAll('span.text-error')].filter((s) => s.textContent.includes('Provider 名称重复')).length,
    saveDisabled: [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')?.disabled }))()`);
  check(`改名为已有 provider "${dupSetup.name}" → 提示名称重复且保存禁用`,
    dupState?.dup && dupState?.dupSpans >= 2 && dupState?.saveDisabled, JSON.stringify(dupState));
}

try {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync("D:/tmp/x11-smoke.png", Buffer.from(shot.data, "base64"));
} catch (e) { console.log("screenshot skipped:", e.message); }

// 关闭对话框（Esc），不留副作用
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(400);
check("Esc 关闭对话框（未保存，无配置副作用）",
  await cdp.eval(`!document.querySelector('input[placeholder="provider name"]')`));

function report() {
  console.log("\n=== X11 浏览器冒烟结果 ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  | " + r.detail : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
  process.exitCode = failed > 0 ? 1 : 0;
}
report();
ws.close();
process.exit(process.exitCode ?? 0);
