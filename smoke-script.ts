/**
 * Smoke test for script mode (src/script.ts): a JS driver in the orchestrator's
 * chair. Feeds ScriptSession the prompts the run loop would compose and checks
 * it answers with TO: blocks, resolves the script's dispatches from `[from seat]`
 * events, batches parallel asks into one turn, reads a sibling file, and ends
 * with [[PHASE-COMPLETE]] carrying the script's reason. No model calls.
 * Run: npx tsx smoke-script.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEvents, ScriptSession } from "./src/script.js";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
const prompt = (events: string) => `⏱ 0s\n\n===== CURRENT LEDGER (your memory — all you know about this run) =====\n(empty)\n===== END LEDGER =====\n\n===== NEW EVENT(S) =====\n${events}\n===== END EVENT(S) =====\n\nRoles you may dispatch to: a, b.`;

async function main(): Promise<void> {
  console.log("parseEvents:");
  {
    const ev = parseEvents("----- EVENT 1 of 2 -----\n[verify PASS in a's workspace: `x`]\n[from a]\nhello\n\n----- EVENT 2 of 2 -----\n[SYSTEM] nudge");
    check("splits coalesced events and attributes replies", ev.length === 2 && ev[0].seat === "a" && /hello/.test(ev[0].text) && ev[1].seat === null, JSON.stringify(ev));
    check("a verify line before [from] still attributes", /verify PASS/.test(ev[0].text));
  }

  console.log("scripted run:");
  const dir = mkdtempSync(path.join(tmpdir(), "md-agent-script-"));
  mkdirSync(path.join(dir, "workspaces", "a"), { recursive: true });
  writeFileSync(path.join(dir, "workspaces", "a", "out.txt"), "from a's tree\n");
  const scriptFile = path.join(dir, "driver.mjs");
  writeFileSync(scriptFile, `export default async function run(h) {
  h.log("start");
  const [ra, rb] = await Promise.all([h.dispatch("a", "do A"), h.dispatch("b", "do B")]);
  const file = await h.read("a", "out.txt");
  h.note("out.txt: " + file.trim());
  const rc = await h.dispatch("a", "second ask, b said: " + rb.split("\\n").pop());
  return "all three replies in: " + [ra, rb, rc].length;
}
`);
  const s = new ScriptSession(scriptFile, { roles: ["a", "b"], runDir: dir, runName: "r", repoDir: dir, isolation: "none" });
  const t1 = await s.send(prompt("Begin the run."));
  check("first turn batches both parallel asks into one turn", /TO: a\ndo A\n---\nTO: b\ndo B/.test(t1), t1);
  check("carries a ledger the loop can store", /<<<LEDGER[\s\S]*LEDGER>>>/.test(t1));
  check("no completion yet", !/PHASE-COMPLETE/.test(t1));

  const t2 = await s.send(prompt("[from a]\nA is done"));
  check("one reply in, script still waiting on b → nothing dispatched", !/TO:/.test(t2) && !/PHASE-COMPLETE/.test(t2), t2);

  const t3 = await s.send(prompt("[verify PASS in b's workspace: `x`]\n[from b]\nB is done"));
  check("both in → script read a's file and dispatched the follow-up with b's text", /TO: a\nsecond ask, b said: B is done/.test(t3), t3);
  check("note landed in the ledger's artifacts", /out\.txt: from a's tree/.test(t3), t3);

  const t4 = await s.send(prompt("[from a]\nsecond done"));
  check("script returned → [[PHASE-COMPLETE]] with its reason and no TO:", /\[\[PHASE-COMPLETE\]\] all three replies in: 3/.test(t4) && !/TO:/.test(t4), t4);
  check("orchestrator cost is zero", s.lastUsage.costUsd === 0);

  console.log("script errors:");
  const bad = path.join(dir, "bad.mjs");
  writeFileSync(bad, `export default async function run(h) { await h.dispatch("zzz", "nope"); }`);
  const s2 = new ScriptSession(bad, { roles: ["a"], runDir: dir, runName: "r", repoDir: dir, isolation: "none" });
  let err: unknown;
  try { await s2.send(prompt("Begin.")); } catch (e) { err = e; }
  check("an unknown seat fails the script loudly", /script failed: script: unknown seat "zzz"/.test(String(err)), String(err));

  rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED ✗` : "\nALL PASS ✓");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
