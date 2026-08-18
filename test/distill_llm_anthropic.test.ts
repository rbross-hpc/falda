/**
 * Anthropic provider for the distillation LLM client (src/distill/llm.ts).
 *
 * FALDA's default LLM path speaks the OpenAI chat-completions wire format
 * (`POST {baseUrl}/chat/completions` -> `choices[0].message.content`).
 * Anthropic has no such endpoint — its API is the Messages API
 * (`POST {baseUrl}/v1/messages` -> `content[0].text`), so the provider is a
 * distinct code path rather than a different base URL.
 *
 * Every test drives a local node:http stub through the SDK's baseURL
 * override, so the suite needs no API key and makes no network calls.
 *
 * Guarantees under test:
 *   1. FALDA_LLM_PROVIDER=anthropic sends a Messages API request, with the
 *      x-api-key and anthropic-version headers the API requires.
 *   2. The reply is read from content[0].text.
 *   3. `temperature` is NOT sent — Opus 5 / Sonnet 5 / Opus 4.7+ reject it
 *      with a 400, so omitting it keeps every Claude model selectable.
 *   4. max_tokens is sent and is generous — the Messages API requires it,
 *      and a low cap would silently truncate a distillation pass mid-JSON.
 *   5. A non-text content block throws rather than yielding "" — a silent
 *      empty string would be recorded as a successful pass over no output.
 *   6. The default model is claude-haiku-4-5, and `.model` reports it.
 *   7. Regression guard: with the provider unset, the OpenAI path is
 *      completely unchanged.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { makeLLM, resolveLLMModel } from "../src/distill/llm.js";

interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

let server: http.Server;
let baseUrl: string;
let captured: Captured[] = [];
/** Set per-test to control what the stub returns. */
let respond: (req: Captured) => { status: number; json: unknown } = () => ({
  status: 200,
  json: {},
});

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const entry: Captured = {
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      captured.push(entry);
      const { status, json } = respond(entry);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A well-formed Messages API reply. */
function messagesReply(text: string) {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe("distill LLM: anthropic provider", () => {
  test("sends a Messages API request with the required headers", async () => {
    captured = [];
    respond = () => ({ status: 200, json: messagesReply("distilled") });

    const llm = makeLLM({ provider: "anthropic", apiKey: "sk-ant-test", baseUrl });
    await llm("extract atoms from these turns");

    assert.equal(captured.length, 1, "exactly one request");
    const req = captured[0];
    assert.match(req.url, /\/v1\/messages$/, "hits the Messages API, not /chat/completions");
    assert.equal(req.headers["x-api-key"], "sk-ant-test");
    assert.ok(req.headers["anthropic-version"], "anthropic-version header is required by the API");
    assert.deepEqual(req.body.messages, [
      { role: "user", content: "extract atoms from these turns" },
    ]);
  });

  test("returns the text from content[0].text", async () => {
    captured = [];
    respond = () => ({ status: 200, json: messagesReply("the distilled output") });

    const llm = makeLLM({ provider: "anthropic", apiKey: "sk-ant-test", baseUrl });
    assert.equal(await llm("go"), "the distilled output");
  });

  test("does NOT send temperature", async () => {
    captured = [];
    respond = () => ({ status: 200, json: messagesReply("ok") });

    const llm = makeLLM({ provider: "anthropic", apiKey: "sk-ant-test", baseUrl });
    await llm("go");

    assert.ok(
      !("temperature" in captured[0].body),
      "temperature is rejected with a 400 by Opus 5 / Sonnet 5 / Opus 4.7+",
    );
  });

  test("sends a generous max_tokens so a pass cannot truncate mid-JSON", async () => {
    captured = [];
    respond = () => ({ status: 200, json: messagesReply("ok") });

    const llm = makeLLM({ provider: "anthropic", apiKey: "sk-ant-test", baseUrl });
    await llm("go");

    assert.equal(typeof captured[0].body.max_tokens, "number", "max_tokens is required");
    assert.ok(captured[0].body.max_tokens >= 8192, "must not lowball the output cap");
  });

  test("throws when the reply carries no text block, rather than returning ''", async () => {
    captured = [];
    respond = () => ({
      status: 200,
      json: { ...messagesReply("x"), content: [{ type: "thinking", thinking: "..." }] },
    });

    const llm = makeLLM({ provider: "anthropic", apiKey: "sk-ant-test", baseUrl });

    await assert.rejects(
      () => llm("go"),
      /text/i,
      "an empty string would be recorded as a successful pass over no output",
    );
  });

  test("defaults to claude-haiku-4-5 and reports it on .model", async () => {
    captured = [];
    respond = () => ({ status: 200, json: messagesReply("ok") });

    const llm = makeLLM({ provider: "anthropic", apiKey: "sk-ant-test", baseUrl });

    assert.equal(llm.model, "claude-haiku-4-5");
    assert.equal(resolveLLMModel({ provider: "anthropic" }), "claude-haiku-4-5");

    await llm("go");
    assert.equal(captured[0].body.model, "claude-haiku-4-5");
  });
});

describe("distill LLM: openai path unchanged", () => {
  test("provider unset still posts chat-completions with temperature 0", async () => {
    captured = [];
    respond = () => ({
      status: 200,
      json: { choices: [{ message: { content: "openai says hi" } }] },
    });

    const llm = makeLLM({ baseUrl, apiKey: "sk-openai", model: "gpt-4o-mini" });
    assert.equal(await llm("go"), "openai says hi");

    const req = captured[0];
    assert.match(req.url, /\/chat\/completions$/);
    assert.equal(req.headers["authorization"], "Bearer sk-openai");
    assert.equal(req.body.temperature, 0, "the OpenAI path keeps its existing behaviour");
    assert.equal(resolveLLMModel({}), "gpt-4o-mini");
  });
});
