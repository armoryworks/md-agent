/**
 * Smoke test for the sub-team engine (src/team.ts).
 * Run: npx tsx smoke-team.ts
 *
 * Deterministic — drives runHuddle through a mock TeamIO, no claude calls.
 * Exercises: TEAM: parsing, alternation (reporter starts), DONE/BLOCKED
 * termination, the round-cap → reporter-summary path, and channel accumulation.
 */
import { parseTeamBlocks, runHuddle, type TeamIO, type TeamSpec } from "./src/team.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

/** Mock IO that replays scripted replies per role and records the interaction. */
function mockIO(scripts: Record<string, string[]>) {
  const calls: { role: string }[] = [];
  const idx: Record<string, number> = {};
  const channel: { who: string; msg: string }[] = [];
  const io: TeamIO = {
    async ask(role) {
      calls.push({ role });
      const i = idx[role] ?? 0;
      idx[role] = i + 1;
      return scripts[role]?.[i] ?? "(no scripted reply)";
    },
    async appendChannel(_team, who, msg) {
      channel.push({ who, msg });
    },
    isStopping: () => false,
  };
  return { io, calls, channel };
}

const spec = (over: Partial<TeamSpec>): TeamSpec => ({
  name: "t",
  members: ["alice", "bob"],
  reporter: "alice",
  maxRounds: 5,
  brief: "do the thing",
  ...over,
});

async function main(): Promise<void> {
  // ---- parseTeamBlocks ----
  console.log("parseTeamBlocks:");
  {
    const text = [
      "TEAM: api-shape members=backend,frontend reporter=backend maxRounds=8",
      "Agree the request/response contract for /orders. Write it to docs/contract.md.",
      "---",
      "TO: qa",
      "Stand by for the contract.",
    ].join("\n");
    const { specs, errors } = parseTeamBlocks(text);
    check("extracts one team", specs.length === 1, `got ${specs.length}`);
    check("name parsed", specs[0]?.name === "api-shape");
    check(
      "members parsed",
      JSON.stringify(specs[0]?.members) === JSON.stringify(["backend", "frontend"])
    );
    check("reporter parsed", specs[0]?.reporter === "backend");
    check("maxRounds parsed", specs[0]?.maxRounds === 8);
    check("brief captured", !!specs[0]?.brief.includes("Agree the request"));
    check("no errors", errors.length === 0);
  }
  {
    const { specs, errors } = parseTeamBlocks("TEAM: solo members=backend\ndo a thing");
    check("rejects 1-member team", specs.length === 0 && errors.length === 1);
  }
  {
    const { specs } = parseTeamBlocks("TEAM: pair members=a,b\nbrief here");
    check("reporter defaults to first member", specs[0]?.reporter === "a");
    check("maxRounds defaults to 12", specs[0]?.maxRounds === 12);
  }

  // ---- runHuddle: DONE ----
  console.log("runHuddle (DONE):");
  {
    const { io, calls, channel } = mockIO({
      alice: ["Plan: I take X, you take Y", "TEAM-DONE: X+Y complete; see x.md, y.md"],
      bob: ["Y done, results in y.md; alice please close"],
    });
    const res = await runHuddle(spec({}), io);
    check("status done", res.status === "done", res.status);
    check("report is the summary", res.report.includes("X+Y complete"));
    check(
      "alternates starting with reporter",
      JSON.stringify(calls.map((c) => c.role)) === JSON.stringify(["alice", "bob", "alice"])
    );
    check("channel got every turn", channel.length === 3, `got ${channel.length}`);
  }

  // ---- runHuddle: BLOCKED ----
  console.log("runHuddle (BLOCKED):");
  {
    const { io, calls } = mockIO({ alice: ["TEAM-BLOCKED: need budget sign-off"], bob: [] });
    const res = await runHuddle(spec({}), io);
    check("status blocked", res.status === "blocked", res.status);
    check("report is the question", res.report === "need budget sign-off");
    check("stops immediately", calls.length === 1, `got ${calls.length} calls`);
  }

  // ---- runHuddle: cap → reporter summary ----
  console.log("runHuddle (round cap):");
  {
    const { io, calls } = mockIO({
      alice: ["working on plan A", "TEAM-DONE: landed at Z (see notes.md)"],
      bob: ["my piece is B"],
    });
    const res = await runHuddle(spec({ maxRounds: 2 }), io);
    check("status capped", res.status === "capped", res.status);
    check("report from forced summary", res.report === "landed at Z (see notes.md)");
    check(
      "2 rounds + 1 summary, summary asked of reporter",
      calls.length === 3 && calls[2]?.role === "alice",
      `calls=${JSON.stringify(calls.map((c) => c.role))}`
    );
  }

  console.log(`\n${failures === 0 ? "ALL PASS ✓" : `${failures} CHECK(S) FAILED ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
