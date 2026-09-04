import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { readState } from "./persist.js";
import { theme as t } from "./theme.js";

/**
 * `md-agent --stop <run-dir>`: end a running run from outside its console.
 * Places a STOP file the run's watchdog picks up within a few seconds and
 * tears down cleanly (roles told to exit, workspaces audited, endedAt
 * stamped). If the process is still there after a grace period, SIGTERM it.
 */
export async function stopRun(runDir: string, opts: { graceMs?: number } = {}): Promise<void> {
  if (!existsSync(path.join(runDir, "state.json"))) {
    console.error(`no run at ${runDir} (missing state.json)`);
    process.exit(1);
  }
  const pidFile = path.join(runDir, "orchestrator.pid");
  let pid: number | null = null;
  try {
    pid = Number((await readFile(pidFile, "utf8")).trim()) || null;
  } catch {
    // older run, or never started
  }
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (pid && !alive(pid)) {
    const state = await readState(runDir);
    console.log(` ${t.paint("·", "dim")} not running${state.endedAt ? ` (ended ${state.endedAt}${state.endReason ? ` — ${state.endReason}` : ""})` : ""}`);
    return;
  }
  await writeFile(path.join(runDir, "STOP"), `md-agent --stop at ${new Date().toISOString()}\n`, "utf8");
  console.log(` ${t.paint("▸", "amber", true)} STOP placed in ${runDir}${pid ? ` (pid ${pid})` : ""} — waiting for a clean teardown…`);
  const grace = opts.graceMs ?? 30_000;
  const started = Date.now();
  while (pid && alive(pid) && Date.now() - started < grace) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (pid && alive(pid)) {
    console.log(` ${t.paint("!", "amber", true)} still running after ${Math.round(grace / 1000)}s — sending SIGTERM`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone between checks
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const state = await readState(runDir);
  if (state.endedAt) {
    console.log(` ${t.paint("✔", "green", true)} stopped — ${state.endReason ?? "ended"}`);
  } else if (!pid) {
    console.log(` ${t.paint("·", "dim")} STOP placed; no pid recorded (older run) — the run ends on its next watchdog tick if it is live`);
  } else {
    console.log(` ${t.paint("✖", "red", true)} process ${pid} is ${alive(pid) ? "still alive" : "gone"} but the run never stamped its end — check ${path.join(runDir, "transcript.md")}`);
  }
}
