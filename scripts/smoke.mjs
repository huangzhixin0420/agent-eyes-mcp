#!/usr/bin/env node
// MCP stdio smoke test: spawns the built dist/index.js and drives
// initialize -> notifications/initialized -> tools/list -> tools/call over stdio,
// asserting that describe_image is registered and that a sandbox violation
// returns structured error text (no crash).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "dist", "index.js");

const child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => {
  stderr += d.toString();
});

const pending = new Map();
let failures = 0;
function check(ok, msg) {
  if (!ok) {
    console.error("FAIL:", msg);
    failures++;
  }
}
function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}
function waitFor(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for response id=${id}`)), 10000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("FAIL: non-JSON line on stdout:", line);
      failures++;
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const watchdog = setTimeout(() => {
  console.error("FAIL: smoke test timed out");
  console.error("child stderr (last 2000):", stderr.slice(-2000));
  child.kill("SIGKILL");
  process.exit(1);
}, 20000);

try {
  const initP = waitFor(1);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.1" } },
  });
  const init = await initP;
  check(init.error === undefined && init.result?.serverInfo?.name === "agent-eyes-mcp", `initialize: ${JSON.stringify(init)}`);
  console.log("PASS initialize ->", JSON.stringify(init.result?.serverInfo ?? init.result));

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const toolsP = waitFor(2);
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = await toolsP;
  const list = tools.result?.tools ?? [];
  const tool = list.find((t) => t.name === "describe_image");
  check(!!tool, `tools/list missing describe_image: ${JSON.stringify(tools).slice(0, 400)}`);
  if (tool) {
    check(typeof tool.description === "string" && tool.description.length > 100, "describe_image description too short");
    const props = tool.inputSchema?.properties ?? {};
    const anyOf = props.image?.anyOf ?? [];
    check(
      Array.isArray(anyOf) &&
        anyOf.some((s) => s.type === "string") &&
        anyOf.some((s) => s.type === "array" && s.items?.type === "string"),
      "describe_image image schema should be a union of string and string[]",
    );
    check(typeof props.task === "object" && props.task.enum?.includes("ocr"), "describe_image task enum incomplete");
    console.log("PASS tools/list -> describe_image, schema params:", Object.keys(props).join(", "));
  }

  const callP = waitFor(3);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "describe_image", arguments: { image: "/etc/hosts" } } });
  const call = await callP;
  const text = call.result?.content?.[0]?.text ?? "";
  check(call.error === undefined && typeof text === "string" && text.includes("sandbox_denied"), `tools/call should return sandbox error text: ${JSON.stringify(call).slice(0, 400)}`);
  console.log("PASS tools/call (sandbox error path) ->", text.split("\n")[0]);

  const call2P = waitFor(4);
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "describe_image", arguments: { image: ["/etc/hosts", "/etc/passwd"] } } });
  const call2 = await call2P;
  const text2 = call2.result?.content?.[0]?.text ?? "";
  check(
    call2.error === undefined && typeof text2 === "string" && text2.includes("sandbox_denied"),
    `tools/call with image array should return sandbox error text: ${JSON.stringify(call2).slice(0, 400)}`,
  );
  console.log("PASS tools/call (image array path) ->", text2.split("\n")[0]);

  console.log(failures === 0 ? "SMOKE TEST PASSED" : `SMOKE TEST FAILED (${failures} failure(s))`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error("FAIL:", err.message);
  console.error("child stderr (last 2000):", stderr.slice(-2000));
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  child.kill("SIGTERM");
}
