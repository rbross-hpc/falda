/**
 * Unit tests for integrations/claude-code/hooks/lib/*.mjs.
 *
 * Guarantees under test:
 *   1. parseEnvelope unwraps both bare-JSON and SSE-framed responses.
 *   2. parseEnvelope returns null on malformed input rather than throwing.
 *   3. callTool returns null (never throws) on connection failure.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as mcp from "../integrations/claude-code/hooks/lib/mcp.mjs";
import * as creds from "../integrations/claude-code/hooks/lib/creds.mjs";
import * as state from "../integrations/claude-code/hooks/lib/state.mjs";

describe("cc plugin: mcp envelope parsing", () => {
  test("unwraps an SSE-framed JSON-RPC response", () => {
    const raw = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"{\\"tenant\\":\\"t1\\"}"}]},"jsonrpc":"2.0","id":1}\n\n';
    const env = mcp.parseEnvelope(raw, "text/event-stream");
    assert.equal(env?.result?.content?.[0]?.text, '{"tenant":"t1"}');
  });

  test("unwraps a bare JSON response", () => {
    const env = mcp.parseEnvelope('{"result":{"ok":true}}', "application/json");
    assert.deepEqual(env?.result, { ok: true });
  });

  test("returns null on malformed body instead of throwing", () => {
    assert.equal(mcp.parseEnvelope("not json", "application/json"), null);
    assert.equal(mcp.parseEnvelope("", "text/event-stream"), null);
  });
});

describe("cc plugin: mcp callTool failure policy", () => {
  test("returns null when the server is unreachable, never throws", async () => {
    const creds = { mcpUrl: "http://127.0.0.1:1/mcp", token: "x", tenant: "t" };
    const res = await mcp.callTool(creds, "falda_whoami", {}, 500);
    assert.equal(res, null);
  });
});

describe("cc plugin: mcp callTool against a stub server", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastHeaders: http.IncomingHttpHeaders = {};

  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        lastHeaders = req.headers;
        const parsed = JSON.parse(body);
        const toolName = parsed.params.name;

        if (toolName === "sse_ok") {
          const inner = JSON.stringify({ tenant: "t1" });
          const envelope = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: inner }] },
          });
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`event: message\ndata: ${envelope}\n\n`);
        } else if (toolName === "json_ok") {
          const inner = JSON.stringify({ tenant: "t1" });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "text", text: inner }] },
            }),
          );
        } else if (toolName === "http_500") {
          // A VALID success envelope, served with an HTTP 500 status. This is
          // deliberate: if `if (!res.ok) return null` were deleted, callTool
          // would happily parse this and return { tenant: "t1" }, so this
          // test can only pass because of the status check, not because the
          // body happens to be unparseable.
          const inner = JSON.stringify({ tenant: "t1" });
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "text", text: inner }] },
            }),
          );
        } else if (toolName === "rpc_error") {
          // BOTH an `error` field AND a well-formed `result.content[0].text`.
          // This is deliberate: if the `envelope.error` check were deleted,
          // callTool would fall through to a valid result and return
          // { tenant: "t1" }, so this test can only pass because of the
          // error check, not because `result` happens to be absent.
          const inner = JSON.stringify({ tenant: "t1" });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32603, message: "boom" },
              result: { content: [{ type: "text", text: inner }] },
            }),
          );
        } else if (toolName === "tool_isError") {
          // A well-formed JSON-RPC *success* envelope whose result carries
          // isError:true — the shape MCP tools use to report a tool-level
          // failure. `envelope.error` is absent, so only an explicit
          // `envelope.result?.isError` check can catch this.
          const inner = JSON.stringify({ tenant: "t1" });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { isError: true, content: [{ type: "text", text: inner }] },
            }),
          );
        } else if (toolName === "bad_inner_json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "text", text: "not json" }] },
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("successful SSE-framed response returns the parsed inner object", async () => {
    const creds = { mcpUrl: baseUrl, token: "secret-token", tenant: "acme" };
    const res = await mcp.callTool(creds, "sse_ok", {}, 2000);
    assert.deepEqual(res, { tenant: "t1" });
    assert.equal(lastHeaders["authorization"], "Bearer secret-token");
    assert.equal(lastHeaders["x-falda-tenant"], "acme");
  });

  test("successful bare-JSON response returns the parsed inner object", async () => {
    const creds = { mcpUrl: baseUrl, token: "x", tenant: "t" };
    const res = await mcp.callTool(creds, "json_ok", {}, 2000);
    assert.deepEqual(res, { tenant: "t1" });
  });

  test("non-2xx status returns null", async () => {
    const creds = { mcpUrl: baseUrl, token: "x", tenant: "t" };
    const res = await mcp.callTool(creds, "http_500", {}, 2000);
    assert.equal(res, null);
  });

  test("JSON-RPC error envelope returns null", async () => {
    const creds = { mcpUrl: baseUrl, token: "x", tenant: "t" };
    const res = await mcp.callTool(creds, "rpc_error", {}, 2000);
    assert.equal(res, null);
  });

  test("a tool-level isError:true result returns null", async () => {
    const creds = { mcpUrl: baseUrl, token: "x", tenant: "t" };
    const res = await mcp.callTool(creds, "tool_isError", {}, 2000);
    assert.equal(res, null);
  });

  test("result.content[0].text present but not valid JSON returns null", async () => {
    const creds = { mcpUrl: baseUrl, token: "x", tenant: "t" };
    const res = await mcp.callTool(creds, "bad_inner_json", {}, 2000);
    assert.equal(res, null);
  });
});

describe("cc plugin: credential resolution", () => {
  test("returns null when token or tenant is missing", () => {
    assert.equal(creds.resolveCreds({}), null);
    assert.equal(creds.resolveCreds({ FALDA_TOKEN: "t" }), null);
    assert.equal(creds.resolveCreds({ FALDA_TENANT: "x" }), null);
  });

  test("defaults the MCP url and returns all three values", () => {
    const c = creds.resolveCreds({ FALDA_TOKEN: "t", FALDA_TENANT: "x" });
    assert.deepEqual(c, { mcpUrl: "http://localhost:8079/mcp", token: "t", tenant: "x" });
  });
});

describe("cc plugin: feature flags", () => {
  test("all features default on", () => {
    const f = creds.features({});
    assert.deepEqual(f, { capture: true, autoRecall: true, distillOnCompact: true, recallOnCompact: true });
  });

  test("only the exact string '0' disables a feature", () => {
    assert.equal(creds.features({ FALDA_CAPTURE: "0" }).capture, false);
    assert.equal(creds.features({ FALDA_CAPTURE: "false" }).capture, true);
    assert.equal(creds.features({ FALDA_CAPTURE: "" }).capture, true);
  });

  test("recallOnCompact is forced off when capture is off", () => {
    const f = creds.features({ FALDA_CAPTURE: "0", FALDA_RECALL_ON_COMPACT: "1" });
    assert.equal(f.recallOnCompact, false, "post-compaction recall needs capture writing to T0");
  });
});

describe("cc plugin: session state", () => {
  test("missing file reads as both-flags-false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-cc-state-"));
    const env = { FALDA_CC_STATE_DIR: dir };
    assert.deepEqual(state.readState("nope", env), { recalled: false, postCompactPending: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips a written state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-cc-state-"));
    const env = { FALDA_CC_STATE_DIR: dir };
    state.writeState("s1", { recalled: true, postCompactPending: false }, env);
    assert.deepEqual(state.readState("s1", env), { recalled: true, postCompactPending: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("atomic write survives a concurrent writer: no torn or empty file", async () => {
    // writeState writes to a pid-scoped temp file, then renameSync onto the
    // shared target. renameSync is an atomic replace on POSIX, so even with
    // two real OS processes racing to write the SAME session file, every
    // observer must see either the old content or the new content in full
    // — never a partial write, never an empty file, never a parse failure.
    // A single Node process can't produce that race (writeState is
    // synchronous), so this spawns two real child processes hammering the
    // same session file concurrently, while this process polls the file in
    // a tight loop throughout and asserts it's always valid.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-cc-state-race-"));
    const stateModuleUrl = new URL("../integrations/claude-code/hooks/lib/state.mjs", import.meta.url).href;
    const target = path.join(dir, "race.json");

    const writerScript = (tag: string) => `
      const { writeState } = await import(${JSON.stringify(stateModuleUrl)});
      const env = { FALDA_CC_STATE_DIR: ${JSON.stringify(dir)} };
      for (let i = 0; i < 200; i++) {
        writeState("race", { recalled: i % 2 === 0, postCompactPending: "${tag}" + i }, env);
      }
    `;

    const spawnWriter = (tag: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", writerScript(tag)], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}: ${stderr}`))));
      });

    let polling = true;
    let observations = 0;
    const poller = (async () => {
      while (polling) {
        if (fs.existsSync(target)) {
          const raw = fs.readFileSync(target, "utf8");
          assert.ok(raw.length > 0, "state file observed empty mid-race");
          const parsed = JSON.parse(raw); // throws (fails the test) on a torn write
          assert.equal(typeof parsed.recalled, "boolean");
          observations++;
        }
        // Yield to the event loop so the spawned writers' stdio/close events
        // (which the assertions in this test depend on) actually get to run
        // — a bare `while` here with no await would starve libuv and hang.
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await Promise.all([spawnWriter("A"), spawnWriter("B")]);
    polling = false;
    await poller;

    assert.ok(observations > 0, "poller should have observed at least one valid write during the race");
    const final = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(typeof final.recalled, "boolean");
    assert.equal(typeof final.postCompactPending, "string");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("prunes files older than 7 days and keeps fresh ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falda-cc-state-"));
    const env = { FALDA_CC_STATE_DIR: dir };
    const stale = path.join(dir, "old.json");
    fs.writeFileSync(stale, "{}");
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);

    state.writeState("fresh", { recalled: true, postCompactPending: false }, env);

    assert.equal(fs.existsSync(stale), false, "8-day-old state file pruned");
    assert.equal(fs.existsSync(path.join(dir, "fresh.json")), true, "fresh state file kept");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("cc plugin: packaging", () => {
  const pluginRoot = new URL("../integrations/claude-code/", import.meta.url);

  test("manifest declares the plugin name", () => {
    const m = JSON.parse(fs.readFileSync(new URL(".claude-plugin/plugin.json", pluginRoot), "utf8"));
    assert.equal(m.name, "falda-memory");
    assert.ok(m.description.length > 0);
  });

  test(".mcp.json interpolates exactly the vars resolveCreds reads", () => {
    const raw = fs.readFileSync(new URL(".mcp.json", pluginRoot), "utf8");
    // The URL carries a `:-default` matching creds.mjs's own default, so a
    // user who sets only FALDA_TOKEN/FALDA_TENANT still gets a working MCP
    // server instead of a literal unexpanded "${FALDA_MCP_URL}" that
    // silently disables it.
    assert.match(raw, /\$\{FALDA_MCP_URL:-http:\/\/localhost:8079\/mcp\}/);
    assert.match(raw, /\$\{FALDA_TOKEN\}/);
    assert.match(raw, /\$\{FALDA_TENANT\}/);
    const cfg = JSON.parse(raw);
    assert.equal(cfg.mcpServers.falda.type, "http");
  });

  test(".mcp.json's default MCP URL matches creds.mjs's default exactly", () => {
    const raw = fs.readFileSync(new URL(".mcp.json", pluginRoot), "utf8");
    const match = raw.match(/\$\{FALDA_MCP_URL:-([^}]+)\}/);
    assert.ok(match, ".mcp.json must give FALDA_MCP_URL a shell default via ${VAR:-default}");
    const resolved = creds.resolveCreds({ FALDA_TOKEN: "t", FALDA_TENANT: "x" });
    assert.ok(resolved);
    assert.equal(match[1], resolved.mcpUrl,
      "an unset FALDA_MCP_URL must resolve to the same default for both the hooks and the model's MCP tools");
  });

  test("plugin ships no dependencies", () => {
    assert.equal(fs.existsSync(new URL("package.json", pluginRoot)), false,
      "the plugin must stay dependency-free — see docs/future/claude-code-plugin.md");
  });

  test("marketplace lists the plugin", () => {
    const mk = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
    assert.ok(mk.plugins.some((p: any) => p.name === "falda-memory"));
  });
});

describe("cc plugin: skill and commands", () => {
  const pluginRoot = new URL("../integrations/claude-code/", import.meta.url);

  test("SKILL.md has name and description frontmatter", () => {
    const raw = fs.readFileSync(new URL("skills/falda-memory/SKILL.md", pluginRoot), "utf8");
    assert.match(raw, /^---\n/);
    assert.match(raw, /\nname: falda-memory\n/);
    assert.match(raw, /\ndescription: .+\n/);
  });

  test("SKILL.md carries the load-bearing policy points", () => {
    const raw = fs.readFileSync(new URL("skills/falda-memory/SKILL.md", pluginRoot), "utf8");
    for (const needle of ["falda_recall", "falda_remember", "falda_forget", "falda_whoami", "<falda-auto-recall>", "immutable"]) {
      assert.ok(raw.includes(needle), `SKILL.md must mention ${needle}`);
    }
  });

  test("every command file has frontmatter with a description", () => {
    for (const cmd of ["recall", "remember", "status", "distill"]) {
      const raw = fs.readFileSync(new URL(`commands/${cmd}.md`, pluginRoot), "utf8");
      assert.match(raw, /^---\n/, `${cmd}.md needs frontmatter`);
      assert.match(raw, /\ndescription: .+\n/, `${cmd}.md needs a description`);
    }
  });
});

describe("cc plugin: documentation", () => {
  const repo = new URL("../", import.meta.url);

  test("the plugin has a README covering setup and every feature flag", () => {
    const raw = fs.readFileSync(new URL("integrations/claude-code/README.md", repo), "utf8");
    for (const needle of [
      "FALDA_MCP_URL", "FALDA_TOKEN", "FALDA_TENANT",
      "FALDA_CAPTURE", "FALDA_AUTO_RECALL", "FALDA_DISTILL_ON_COMPACT", "FALDA_RECALL_ON_COMPACT",
    ]) {
      assert.ok(raw.includes(needle), `plugin README must document ${needle}`);
    }
  });

  test("the three cross-references to the plugin exist", () => {
    for (const doc of ["docs/HARNESS_INTEGRATION.md", "README.md", "docs/MCP.md"]) {
      const raw = fs.readFileSync(new URL(doc, repo), "utf8");
      assert.ok(raw.includes("integrations/claude-code"),
        `${doc} must point at the Claude Code integration`);
    }
  });
});
