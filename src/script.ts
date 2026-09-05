import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { AgentSession } from "./claude.js";
import type { Usage, WindowSnapshot } from "./persist.js";
import { workspaceBranch } from "./workspace.js";

/** What a script drives the run with. */
export interface ScriptHarness {
  /** Seat names, as configured. */
  readonly roles: readonly string[];
  /**
   * Send one ask to a seat and resolve with its reply — the full event the
   * orchestrator would have seen: any `[verify PASS|FAIL …]` line first, then
   * the seat's text (which may open with `[SEAT HEALED]`, `[TURN CAPPED]` or
   * `[ROLE ERROR]`). Asks queued in the same tick go out in one turn.
   */
  dispatch(seat: string, ask: string): Promise<string>;
  /** Read a file from a seat's worktree, falling back to its branch. */
  read(seat: string, relPath: string): Promise<string>;
  /** A line for the transcript's ledger. */
  note(line: string): void;
  log(msg: string): void;
}

/** The script: an async function; its resolved value is the completion reason. */
export type RunScript = (h: ScriptHarness) => Promise<string | void>;

const EVENT_SPLIT = /^----- EVENT \d+ of \d+ -----\r?\n/m;

/** Split a coalesced event text into `{seat, text}` per `[from <seat>]` reply; unattributed events get seat null. */
export function parseEvents(eventText: string): { seat: string | null; text: string }[] {
  const chunks = eventText.split(EVENT_SPLIT).map((c) => c.trim()).filter(Boolean);
  return chunks.map((c) => {
    const m = /^(?:\[verify [^\n]*\]\r?\n)?\[from ([A-Za-z][\w-]*)\]/.exec(c);
    return { seat: m ? m[1] : null, text: c };
  });
}

/**
 * Script mode: a deterministic driver in the orchestrator's chair. The run
 * loop is unchanged — it still composes an event prompt per batch of replies
 * and parses `TO:` blocks and `[[PHASE-COMPLETE]]` out of the answer — but the
 * answer comes from a JS function the user wrote, not a model. Dispatch order,
 * phases and what counts as done are code; the model work happens only in the
 * seats. This removes the class of failure where a model orchestrator sends a
 * consumer before its producer has replied or requests completion in the same
 * turn it dispatched a verdict to apply.
 */
export class ScriptSession implements AgentSession {
  readonly lastUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
  readonly lastContextTokens = 0;
  readonly id: string | null = null;
  readonly lastWindows: WindowSnapshot | null = null;

  private script: RunScript | null = null;
  private started = false;
  private done: string | null = null;
  private failed: Error | null = null;
  private readonly queue: { seat: string; body: string }[] = [];
  private readonly pending = new Map<string, (reply: string) => void>();
  private readonly notes: string[] = [];
  private readonly status = new Map<string, string>();
  private kicked = 0;

  constructor(
    private readonly scriptPath: string,
    private readonly ctx: { roles: string[]; runDir: string; runName: string; repoDir: string; isolation: string }
  ) {}

  setHeartbeatPath(): void {
    // no model turn to keep alive
  }

  private harness(): ScriptHarness {
    const ctx = this.ctx;
    const self = this;
    return {
      roles: ctx.roles,
      dispatch(seat, ask) {
        if (!ctx.roles.includes(seat)) return Promise.reject(new Error(`script: unknown seat "${seat}"`));
        if (self.pending.has(seat)) return Promise.reject(new Error(`script: seat "${seat}" already has a dispatch outstanding`));
        self.status.set(seat, "working");
        self.queue.push({ seat, body: ask });
        return new Promise<string>((resolve) => self.pending.set(seat, resolve));
      },
      async read(seat, relPath) {
        const file = path.join(ctx.runDir, "workspaces", seat, relPath);
        try {
          return await readFile(file, "utf8");
        } catch {
          const { stdout } = await promisify(execFile)("git", ["show", `${workspaceBranch(ctx.runName, seat)}:${relPath}`], { cwd: ctx.repoDir, maxBuffer: 16 * 1024 * 1024 });
          return stdout;
        }
      },
      note(line) {
        self.notes.push(line);
      },
      log(msg) {
        console.log(`[script] ${msg}`);
      },
    };
  }

  private async load(): Promise<RunScript> {
    if (this.script) return this.script;
    const mod = (await import(pathToFileURL(this.scriptPath).href)) as { default?: RunScript; run?: RunScript };
    const fn = mod.default ?? mod.run;
    if (typeof fn !== "function") throw new Error(`script ${this.scriptPath} must export a default async function (harness) => reason`);
    this.script = fn;
    return fn;
  }

  /** Give the script a chance to react: wait until it has queued asks, finished, failed, or gone quiet. */
  private async settle(): Promise<void> {
    let quiet = 0;
    let lastLen = -1;
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (this.done !== null || this.failed) return;
      if (this.queue.length !== lastLen) {
        lastLen = this.queue.length;
        quiet = 0;
        continue;
      }
      if (++quiet >= 10) return; // 100 ms with no change: the script is awaiting a seat (or a slow read)
    }
  }

  async send(prompt: string): Promise<string> {
    const early = this.failed as Error | null;
    if (early) throw early;
    const events = parseEvents(extractEvents(prompt));
    for (const ev of events) {
      if (!ev.seat) continue;
      const resolve = this.pending.get(ev.seat);
      if (!resolve) continue;
      this.pending.delete(ev.seat);
      this.status.set(ev.seat, "replied");
      resolve(ev.text);
    }
    if (!this.started) {
      this.started = true;
      const fn = await this.load();
      void fn(this.harness())
        .then((reason) => {
          this.done = typeof reason === "string" && reason.trim() ? reason.trim() : "script finished";
        })
        .catch((e: unknown) => {
          this.failed = e instanceof Error ? e : new Error(String(e));
        });
    }
    await this.settle();
    const failed = this.failed as Error | null;
    if (failed) throw new Error(`script failed: ${failed.message}`);

    const out: string[] = [];
    out.push("<<<LEDGER");
    out.push("## Plan", `- script: ${path.basename(this.scriptPath)} (deterministic driver; the model works only in the seats)`);
    out.push("## Role status", ...this.ctx.roles.map((r) => `- ${r}: ${this.status.get(r) ?? "idle"}`));
    out.push("## Decisions", "- order and completion are decided by the script");
    out.push("## Artifacts produced", ...(this.notes.length ? this.notes.map((n) => `- ${n}`) : ["- (none noted yet)"]));
    out.push("## Open questions", "- none", "LEDGER>>>", "");
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length) {
      out.push(batch.map((d) => `TO: ${d.seat}\n${d.body}`).join("\n---\n"));
      return out.join("\n");
    }
    if (this.done !== null && this.pending.size === 0) {
      out.push(`[[PHASE-COMPLETE]] ${this.done}`);
      return out.join("\n");
    }
    // Nothing to send: the script is waiting on a seat that has not replied.
    // A stray nudge (idle re-invoke) lands here harmlessly.
    this.kicked++;
    return out.join("\n");
  }
}

/** The NEW EVENT(S) block of the orchestrator prompt, or the whole prompt when absent (tests). */
export function extractEvents(prompt: string): string {
  const m = /===== NEW EVENT\(S\) =====\r?\n([\s\S]*?)\r?\n===== END EVENT\(S\) =====/.exec(prompt);
  return m ? m[1] : prompt;
}
