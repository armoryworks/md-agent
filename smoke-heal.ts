/**
 * Smoke test for auto-heal (src/heal.ts + the seat/preflight paths that use it)
 * against fake CLIs on PATH — deterministic, no network, no quota.
 * Run: npx tsx smoke-heal.ts
 *
 * Exercises: the ladder rules (own over run default, used rungs skipped, the dry
 * provider skipped); preflightHeal moving seats and naming the providers to probe;
 * and a live seat whose agy runs dry mid-turn healing onto a fake claude, re-running
 * the same dispatch, prefixing its reply with [SEAT HEALED] and recording the move
 * in state.json.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyFallback, fallbackLadder, nextRung, preflightHeal } from "./src/heal.js";
import { safeWrite } from "./src/ipc.js";
import type { RoleSpec, RunState } from "./src/persist.js";
import { runRole } from "./src/role.js";

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

const AGY_QUOTA =
  '{"event":"result","result":{"conversation_id":"c-2","status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 143h0m19s.","usage":{"input_tokens":0,"output_tokens":0}}}';
const CLAUDE_OK = [
  '{"type":"system","subtype":"init","session_id":"s-1","model":"claude-haiku-4-5"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"healed reply: table written"}],"usage":{"input_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":0,"output_tokens":8}},"session_id":"s-1"}',
  '{"type":"result","session_id":"s-1","result":"healed reply: table written","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":8,"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}',
].join("\n");

async function main(): Promise<void> {
  console.log("ladder rules:");
  {
    const role: RoleSpec = { name: "w", description: "", provider: "agy", model: "sonnet" };
    check("no ladder → no rung", nextRung(role, "agy") === null);
    check("run default applies when the seat has none", fallbackLadder(role, { provider: "claude" }).length === 1);
    const own: RoleSpec = { ...role, fallback: [{ provider: "agy", model: "haiku" }, { provider: "claude", model: "haiku" }] };
    const r1 = nextRung(own, "agy", { provider: "claude", model: "opus" });
    check("own ladder wins over the run default", r1?.model === "haiku" && r1?.provider === "claude", JSON.stringify(r1));
    check("a rung on the dry provider is skipped", r1?.provider !== "agy");
    const rec = applyFallback(own, r1!, "quota", 1_800_000_000);
    check("applyFallback records from/to and moves the seat", rec.from.provider === "agy" && own.provider === "claude" && own.model === "haiku" && own.healed?.length === 1, JSON.stringify(own));
    check("turn caps of the old provider dropped", own.turnMaxSteps === undefined && own.turnTimeoutSec === undefined);
    check("a used rung is not offered again", nextRung(own, "claude") === null);
    const two: RoleSpec = { ...role, fallback: [{ provider: "claude", model: "haiku" }, { model: "sonnet" }] };
    applyFallback(two, nextRung(two, "agy")!, "q");
    const r2 = nextRung(two, "claude");
    check("after claude runs dry too, only a non-claude rung would do (none here)", r2 === null, JSON.stringify(r2));
  }

  console.log("preflightHeal:");
  {
    const roles: RoleSpec[] = [
      { name: "sweeper", description: "", provider: "agy", model: "sonnet", fallback: [{ provider: "claude", model: "haiku" }] },
      { name: "reviewer", description: "", provider: "claude", model: "opus" },
    ];
    const r = preflightHeal(roles, "agy", "quota reached");
    check("the agy seat moved", roles[0].provider === "claude" && roles[0].model === "haiku" && r.healed.length === 1);
    check("the claude seat untouched", roles[1].provider === "claude" && !roles[1].healed);
    check("names the provider to probe next", r.needProviders.has("claude") && r.needProviders.size === 1);
    const stuck: RoleSpec[] = [{ name: "x", description: "", provider: "agy", model: "haiku" }];
    let err: unknown;
    try { preflightHeal(stuck, "agy", "quota"); } catch (e) { err = e; }
    check("a dry seat with no ladder still fails the launch, naming the seat", /Seat\(s\) x have no fallback/.test(String(err)), String(err));
  }

  console.log("live seat heals mid-turn:");
  fake("agy", `cat <<'EOF'\n${AGY_QUOTA}\nEOF`);
  fake("claude", `echo "$@" > "${bin}/claude.args"; cat > "${bin}/claude.stdin"; cat <<'EOF'\n${CLAUDE_OK}\nEOF`);
  const runDir = mkdtempSync(path.join(tmpdir(), "md-agent-heal-run-"));
  for (const d of ["inbox", "outbox", "sessions", "log"]) mkdirSync(path.join(runDir, d), { recursive: true });
  const state: RunState = {
    goal: "smoke",
    roles: [{ name: "w", description: "enumerate things", provider: "agy", model: "haiku", turnMaxSteps: 20 }],
    isolation: "none",
    fallback: [{ provider: "claude", model: "haiku" }],
  } as RunState;
  writeFileSync(path.join(runDir, "state.json"), JSON.stringify(state, null, 2));
  writeFileSync(path.join(runDir, "transcript.md"), "# Run\n\n## → w  \n_00:00:00_\n\nearlier dispatch\n\n## ← w  \n_00:00:01_\n\nearlier reply\n");
  writeFileSync(path.join(runDir, "outbox", "w.txt"), "");
  writeFileSync(path.join(runDir, "inbox", "w.txt"), "");
  const cwd = process.cwd();
  process.chdir(runDir);
  void runRole("w", runDir);
  process.chdir(cwd);
  await new Promise((r) => setTimeout(r, 400));
  await safeWrite(path.join(runDir, "inbox", "w.txt"), "Produce table A.");
  let out = "";
  for (let i = 0; i < 100 && !out.trim(); i++) {
    await new Promise((r) => setTimeout(r, 200));
    out = readFileSync(path.join(runDir, "outbox", "w.txt"), "utf8");
  }
  check("the reply arrived from the fallback seat", /healed reply: table written/.test(out), out.slice(0, 200));
  check("it is prefixed with [SEAT HEALED] naming both identities", /^\[SEAT HEALED\] "w" moved from agy·gemini-3\.8-flash-low to claude·claude-haiku-4-5/.test(out), out.slice(0, 200));
  const after = JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8")) as RunState;
  const w = after.roles[0];
  check("state.json carries the new identity", w.provider === "claude" && w.model === "haiku", JSON.stringify(w));
  check("and the heal record with the reset time", w.healed?.[0]?.from.provider === "agy" && typeof w.healed?.[0]?.resetsAt === "number", JSON.stringify(w.healed));
  check("agy-only turn caps dropped", w.turnMaxSteps === undefined);
  const args = readFileSync(path.join(bin, "claude.args"), "utf8");
  check("the new seat ran on the rung's model", /--model claude-haiku-4-5/.test(args), args);
  const stdin = readFileSync(path.join(bin, "claude.stdin"), "utf8");
  const seeded = `${args}\n${stdin}`;
  check("the new seat was told it was moved", /YOU WERE MOVED HERE MID-RUN/.test(stdin), `stdin ${stdin.length} chars: ${stdin.slice(0, 200)}`);
  check("and reseeded with its transcript history", /PRIOR CONVERSATION/.test(stdin) && /earlier reply/.test(stdin), `stdin ${stdin.length} chars: ${stdin.slice(-300)}`);

  rmSync(bin, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED ✗` : "\nALL PASS ✓");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
