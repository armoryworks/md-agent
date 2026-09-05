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
// Per-step usage is per call; the envelope is cumulative for the conversation.
const AGY_STEPS = [
  '{"event":"init","conversation_id":"c-3","init":{"model":"gemini-3.8-flash-low"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c-3","step_index":1,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":100,"output_tokens":10,"thinking_tokens":5,"cache_read_tokens":1000,"total_tokens":1115}}}',
  '{"event":"step_update","step_update":{"conversation_id":"c-3","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"list_dir"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c-3","step_index":2,"state":"DONE","step_type":"tool","tool_name":"list_dir"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c-3","step_index":3,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":200,"output_tokens":20,"thinking_tokens":0,"cache_read_tokens":3000,"total_tokens":3220}}}',
  '{"event":"result","result":{"conversation_id":"c-3","status":"SUCCESS","response":"done","num_turns":7,"usage":{"input_tokens":566632,"output_tokens":144176,"thinking_tokens":0,"cache_read_tokens":5510762,"total_tokens":6221570}}}',
].join("\n");
const AGY_MANY_STEPS = [
  '{"event":"init","conversation_id":"c-4","init":{"model":"gemini-3.8-flash-low"}}',
  ...Array.from({ length: 6 }, (_, i) => `{"event":"step_update","step_update":{"conversation_id":"c-4","step_index":${i + 1},"state":"DONE","step_type":"tool","tool_name":"view_file"}}`),
  '{"event":"result","result":{"conversation_id":"c-4","status":"SUCCESS","response":"kept going","usage":{"input_tokens":1,"output_tokens":1}}}',
].join("\n");

const CLAUDE_OK = [
  '{"type":"system","subtype":"init","session_id":"s-1","model":"claude-haiku-4-5"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788555000,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.33,"resetsAt":1788555000},"seven_day":{"utilization":0.09,"resetsAt":1788728400}}}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]},"session_id":"s-1"}',
  '{"type":"result","session_id":"s-1","result":"hello","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":2,"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}',
].join("\n");
// Narration before a tool call, then the report; `result` is the last message's text.
const CLAUDE_NARRATED = [
  '{"type":"system","subtype":"init","session_id":"s-3","model":"claude-haiku-4-5"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Now I will look at the file."},{"type":"tool_use","name":"Read","input":{"file_path":"x"}}],"usage":{"input_tokens":2,"cache_read_input_tokens":20000,"cache_creation_input_tokens":5000,"output_tokens":30}},"session_id":"s-3"}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"stuff"}]},"session_id":"s-3"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"REPORT: all good."}],"usage":{"input_tokens":2,"cache_read_input_tokens":25000,"cache_creation_input_tokens":400,"output_tokens":12}},"session_id":"s-3"}',
  '{"type":"result","session_id":"s-3","result":"REPORT: all good.","total_cost_usd":0.02,"usage":{"input_tokens":4,"output_tokens":42,"cache_read_input_tokens":45000,"cache_creation_input_tokens":5400}}',
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

  fake("agy", `cat <<'EOF'\n${AGY_STEPS}\nEOF`);
  {
    const s = new AgySession({ model: "x" });
    await s.send("ping");
    check("turn usage is the sum of its steps, not the cumulative envelope", s.lastUsage?.inputTokens === 300 && s.lastUsage?.cacheReadTokens === 4000 && s.lastUsage?.outputTokens === 35, JSON.stringify(s.lastUsage));
    check("resident context is the last step's input + cache read", s.lastContextTokens === 3200, String(s.lastContextTokens));
  }
  fake("agy", `cat <<'EOF'\n${AGY_MANY_STEPS}\nEOF`);
  {
    const s = new AgySession({ model: "x", turnMaxSteps: 4 });
    let err: unknown;
    try {
      await s.send("ping");
    } catch (e) {
      err = e;
    }
    check("step cap stops the turn with a re-scope error", /step cap/.test(String(err)), String(err));
    check("conversation id still captured on a capped turn", s.id === "c-4");
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
  fake("claude", `echo "$@" > "${bin}/claude.args"; cat <<'EOF'\n${CLAUDE_NARRATED}\nEOF`);
  {
    const s = new ClaudeSession({ model: "x", sessionId: "11111111-2222-5333-8444-555555555555", tools: ["Read", "Bash"], noMcp: true, maxBudgetUsd: 1.5 });
    const reply = await s.send("go");
    check("reply is the report, not the narration", reply === "REPORT: all good.", reply);
    check("resident context is the last call's input + cache", s.lastContextTokens === 25402, String(s.lastContextTokens));
    const args = (await import("node:fs")).readFileSync(path.join(bin, "claude.args"), "utf8");
    check("minted id passed as --session-id", /--session-id 11111111-2222-5333-8444-555555555555/.test(args), args);
    check("tools, mcp and budget flags passed", /--tools Read,Bash/.test(args) && /--strict-mcp-config/.test(args) && /--max-budget-usd 1.5/.test(args), args);
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
