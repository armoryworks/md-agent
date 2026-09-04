/**
 * Smoke test for the provider adapters (src/claude.ts, src/agy.ts) against
 * fake CLIs on PATH — deterministic, no network, no quota.
 * Run: npx tsx smoke-providers.ts
 *
 * Exercises: agy stream-json result parsing; agy quota exhaustion → ProviderExhaustedError
 * with the reset time parsed; claude rate-limit status → ProviderExhaustedError; a normal
 * claude turn's text + usage + windows.
 */
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgySession } from "./src/agy.js";
import { ClaudeSession, ProviderExhaustedError } from "./src/claude.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

const bin = mkdtempSync(path.join(tmpdir(), "md-agent-fake-"));
function fake(name: string, body: string): void {
  const f = path.join(bin, name);
  writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  chmodSync(f, 0o755);
}
process.env.PATH = `${bin}:${process.env.PATH}`;

const AGY_OK = [
  '{"event":"init","conversation_id":"c-1","init":{"model":"gemini-3.8-flash-low"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"pong\\n"}}',
  '{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"pong\\n","duration_seconds":1,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":11}}}',
].join("\n");
const AGY_QUOTA =
  '{"event":"result","result":{"conversation_id":"c-2","status":"SUCCESS","response":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 164h48m.","usage":{"input_tokens":0,"output_tokens":0}}}';

const CLAUDE_OK = [
  '{"type":"system","subtype":"init","session_id":"s-1","model":"claude-haiku-4-5"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788555000,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.33,"resetsAt":1788555000},"seven_day":{"utilization":0.09,"resetsAt":1788728400}}}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]},"session_id":"s-1"}',
  '{"type":"result","session_id":"s-1","result":"hello","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":2,"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}',
].join("\n");
const CLAUDE_LIMITED = [
  '{"type":"system","subtype":"init","session_id":"s-2","model":"claude-haiku-4-5"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788555000,"rateLimitType":"five_hour","isUsingOverage":false}}',
  '{"type":"result","session_id":"s-2","result":"","is_error":true,"usage":{}}',
].join("\n");

async function main(): Promise<void> {
  console.log("agy:");
  fake("agy", `cat <<'EOF'\n${AGY_OK}\nEOF`);
  {
    const s = new AgySession({ model: "x" });
    const reply = await s.send("ping");
    check("parses the result envelope from the stream", reply === "pong");
    check("captures the conversation id", s.id === "c-1");
    check("captures usage", s.lastUsage?.inputTokens === 10);
  }
  fake("agy", `cat <<'EOF'\n${AGY_QUOTA}\nEOF`);
  {
    const s = new AgySession({ model: "x" });
    let err: unknown;
    try {
      await s.send("ping");
    } catch (e) {
      err = e;
    }
    check("quota text → ProviderExhaustedError", err instanceof ProviderExhaustedError, String(err));
    const e = err as ProviderExhaustedError;
    check("provider is agy", e?.provider === "agy");
    const expect = Math.floor(Date.now() / 1000) + 164 * 3600 + 48 * 60;
    check("reset time parsed from 'Resets in 164h48m'", !!e?.resetsAt && Math.abs(e.resetsAt - expect) < 5, String(e?.resetsAt));
  }

  console.log("claude:");
  fake("claude", `cat <<'EOF'\n${CLAUDE_OK}\nEOF`);
  {
    const s = new ClaudeSession({ model: "x" });
    const reply = await s.send("hi");
    check("assistant text", reply === "hello");
    check("session id captured", s.id === "s-1");
    check("usage + cost", s.lastUsage?.costUsd === 0.01 && s.lastUsage?.cacheReadTokens === 100);
    check("plan windows captured", s.lastWindows?.fiveHour?.utilization === 0.33 && s.lastWindows?.sevenDay?.utilization === 0.09);
  }
  fake("claude", `cat <<'EOF'\n${CLAUDE_LIMITED}\nEOF`);
  {
    const s = new ClaudeSession({ model: "x" });
    let err: unknown;
    try {
      await s.send("hi");
    } catch (e) {
      err = e;
    }
    check("rate-limit status → ProviderExhaustedError", err instanceof ProviderExhaustedError, String(err));
    check("reset time carried", (err as ProviderExhaustedError)?.resetsAt === 1788555000);
  }

  rmSync(bin, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED ✗` : "\nALL PASS ✓");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
