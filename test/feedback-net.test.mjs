import { test } from "node:test";
import assert from "node:assert/strict";
// 网络层要调 buildFeedbackPayload / describe* 与 quotaCount：宿主里它们是
// 同一作用域的兄弟函数，单测里得先把纯函数层铺进全局再 import 网络层。
import * as pure from "../src/lib/feedback.mjs";

for (const [name, fn] of Object.entries(pure)) globalThis[name] = fn;

const { createFeedbackNet } = await import("../src/lib/feedback-net.mjs");

/** 记录每次 bridge 调用的假宿主；responder 决定返回什么，抛异常就模拟调用失败。 */
function makeCtx(responder) {
  const calls = [];
  return {
    calls,
    version: "1.2.3",
    host: { appVersion: "0.9.0" },
    bridge: {
      async invoke(cmd, payload) {
        calls.push({ cmd, payload });
        return responder(payload);
      },
    },
  };
}

const OPTS = { endpoint: "https://relay.example", pluginId: "demo", timeoutMs: 50 };

test("send 只发白名单五字段，且带 JSON 头与插件身份", async () => {
  const ctx = makeCtx(() => ({ status: 200, body: JSON.stringify({ ok: true, remaining: 12 }) }));
  const net = createFeedbackNet(ctx, OPTS);
  const r = await net.send("  有  bug  ");

  assert.equal(r.ok, true);
  assert.equal(r.remaining, 12);
  assert.equal(ctx.calls.length, 1);
  const { cmd, payload } = ctx.calls[0];
  assert.equal(cmd, "plugin_http_request");
  assert.equal(payload.method, "POST");
  assert.equal(payload.url, "https://relay.example/feedback");
  assert.equal(payload.headers["Content-Type"], "application/json");
  assert.equal(payload.headers["User-Agent"], "ccgui-demo/1.2.3");

  const body = JSON.parse(payload.body);
  assert.deepEqual(Object.keys(body).sort(), [
    "hostVersion",
    "pluginId",
    "pluginVersion",
    "text",
    "ts",
  ]);
  assert.equal(body.text, "有  bug");
  assert.equal(body.pluginId, "demo");
  assert.equal(body.pluginVersion, "1.2.3");
  assert.equal(body.hostVersion, "0.9.0");
});

test("send 超时返回超时文案，而不是笼统的失败", async () => {
  const ctx = makeCtx(() => new Promise(() => {}));
  const net = createFeedbackNet(ctx, OPTS);
  const r = await net.send("hi");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "timeout");
  assert.match(r.message, /超时/);
});

test("send 把权限未生效的错误说成「重新安装插件」", async () => {
  const ctx = makeCtx(() => {
    throw new Error("network: host not granted");
  });
  const net = createFeedbackNet(ctx, OPTS);
  const r = await net.send("hi");
  assert.equal(r.kind, "denied");
  assert.match(r.message, /重新安装/);
});

test("quota 用 GET 查额度，不带请求体", async () => {
  const ctx = makeCtx(() => ({ status: 200, body: JSON.stringify({ remaining: 25, dailyLimit: 30 }) }));
  const net = createFeedbackNet(ctx, OPTS);
  const q = await net.quota();

  assert.deepEqual(q, { remaining: 25, dailyLimit: 30 });
  const { payload } = ctx.calls[0];
  assert.equal(payload.method, "GET");
  assert.equal(payload.url, "https://relay.example/quota");
  assert.equal(payload.body, null);
});

test("quota 回传空字符串时不读成 0 条", async () => {
  // Number("") === 0：读成 0 会让界面说「今天的额度已用完」。
  const ctx = makeCtx(() => ({ status: 200, body: JSON.stringify({ remaining: "" }) }));
  const net = createFeedbackNet(ctx, { ...OPTS });
  assert.equal(await net.quota(), null);

  const ctx2 = makeCtx(() => ({ status: 200, body: JSON.stringify({ remaining: null }) }));
  assert.equal(await createFeedbackNet(ctx2, OPTS).quota(), null);
});

test("quota 非 2xx 与调用失败都说成「连不上」而不是「额度紧张」", async () => {
  const c1 = makeCtx(() => ({ status: 500, body: "" }));
  assert.deepEqual(await createFeedbackNet(c1, OPTS).quota(), { offline: true });

  const c2 = makeCtx(() => {
    throw new Error("boom");
  });
  assert.deepEqual(await createFeedbackNet(c2, OPTS).quota(), { offline: true });
});

test("quota 响应体不是 JSON 时不抛，按连不上处理", async () => {
  const ctx = makeCtx(() => ({ status: 200, body: "<html>登录门户</html>" }));
  assert.deepEqual(await createFeedbackNet(ctx, OPTS).quota(), { offline: true });
});

test("pluginId 决定 User-Agent，不写死插件名", async () => {
  const ctx = makeCtx(() => ({ status: 200, body: "{}" }));
  await createFeedbackNet(ctx, { ...OPTS, pluginId: "another" }).quota();
  assert.equal(ctx.calls[0].payload.headers["User-Agent"], "ccgui-another/1.2.3");
});
