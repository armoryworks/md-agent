import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { logPath, readState } from "./persist.js";
import { Theme, theme as defaultTheme } from "./theme.js";

/**
 * Look inside a seat. Renders log/<who>.jsonl — the verbatim stream of every
 * turn the seat took — as a readable trace: what it was asked, what tools it
 * ran, what it said, what it cost. The outbox is the seat's status report to
 * the orchestrator; this is its working.
 */

export const ORCH = "orchestrator";

/** Participants that can be inspected in a run: the orchestrator plus each role. */
export async function listSeats(runDir: string): Promise<{ name: string; hasLog: boolean }[]> {
  const state = await readState(runDir);
  const names = [ORCH, ...state.roles.map((r) => r.name)];
  return names.map((name) => ({ name, hasLog: existsSync(logPath(runDir, name)) }));
}

/** Resolve a user-typed seat reference: a name, a 1-based number, or "orch". */
export function resolveSeat(ref: string, seats: { name: string }[]): string | null {
  const r = ref.trim().toLowerCase();
  if (!r) return null;
  if (r === "orch" || r === "o") return ORCH;
  const n = Number(r);
  if (Number.isInteger(n) && n >= 1 && n <= seats.length) return seats[n - 1].name;
  const exact = seats.find((s) => s.name.toLowerCase() === r);
  if (exact) return exact.name;
  const prefix = seats.filter((s) => s.name.toLowerCase().startsWith(r));
  return prefix.length === 1 ? prefix[0].name : null;
}

function oneLine(s: unknown, max = 100): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** A compact, human description of a tool call's input. */
function describeToolInput(
  input: Record<string, unknown> | undefined,
  fx: (s: string) => string = (s) => s
): string {
  if (!input) return "";
  const pick = (...keys: string[]) => {
    for (const k of keys) if (input[k] != null) return oneLine(fx(String(input[k])), 160);
    return "";
  };
  const known = pick("command", "file_path", "path", "pattern", "query", "url", "description", "prompt");
  if (known) return known;
  return oneLine(fx(JSON.stringify(input)), 160);
}

function firstLines(text: string, n: number): string[] {
  const lines = text.split(/\r?\n/);
  const out = lines.slice(0, n);
  if (lines.length > n) out.push(`… (${lines.length - n} more lines)`);
  return out;
}

/**
 * Render a seat's log to text. `tailTurns` keeps only the last N turns (0 = all).
 * Works for both providers: claude's stream-json and agy's event stream.
 */
export async function renderSeatLog(
  runDir: string,
  who: string,
  opts: { tailTurns?: number; theme?: Theme } = {}
): Promise<string> {
  const t = opts.theme ?? defaultTheme;
  const file = logPath(runDir, who);
  if (!existsSync(file)) {
    return t.paint(`no log for "${who}" yet — ${file}`, "dim");
  }
  const raw = await readFile(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  // Split into turns on md-agent "turn" markers so a tail can be taken by turn.
  const turns: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('{"md":"turn"')) {
      cur = [line];
      turns.push(cur);
    } else if (cur) {
      cur.push(line);
    } else {
      cur = [line];
      turns.push(cur);
    }
  }
  const shown = opts.tailTurns && turns.length > opts.tailTurns ? turns.slice(-opts.tailTurns) : turns;
  const skipped = turns.length - shown.length;

  // Long absolute paths under the run dir read better as ./ — the seat's own
  // workspace — or <run>/ for the rest of the run's files.
  const runAbs = path.resolve(runDir);
  const wsPrefix = path.join(runAbs, "workspaces", who) + path.sep;
  const shorten = (s: string) =>
    s.split(wsPrefix).join("./").split(runAbs + path.sep).join("<run>/").split(process.cwd() + path.sep).join("");

  const out: string[] = [];
  out.push(`${t.paint("◆", "amber", true)} ${t.bold(who)}  ${t.paint(file, "dim")}`);
  if (skipped > 0) out.push(t.paint(`… ${skipped} earlier turn(s) not shown`, "dim"));

  let turnNo = skipped;
  for (const turn of shown) {
    for (const line of turn) {
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(line);
      } catch {
        out.push(t.paint(`  ${oneLine(line, 160)}`, "dim"));
        continue;
      }

      if (ev.md === "turn") {
        turnNo++;
        const when = String(ev.ts ?? "").replace("T", " ").slice(0, 19);
        out.push("");
        out.push(
          t.paint("━━ ", "amberDark") +
            t.paint(`turn ${turnNo}`, "amber", true) +
            t.paint(` · ${ev.provider ?? "?"} ${ev.model ?? ""} · ${when}${ev.resume ? " · resumed" : ""}`, "muted")
        );
        const prompt = String(ev.prompt ?? "");
        out.push(t.paint(`  ▶ prompt (${ev.promptChars ?? prompt.length} chars):`, "teal"));
        for (const l of firstLines(prompt, 14)) out.push(t.paint(`    ${l}`, "dim"));
        continue;
      }
      if (ev.md === "end") {
        const secs = ((ev.ms ?? 0) / 1000).toFixed(1);
        const cost = ev.usage?.costUsd ? ` · $${Number(ev.usage.costUsd).toFixed(4)}` : "";
        const toks = ev.usage
          ? ` · in ${ev.usage.inputTokens ?? 0} / cache ${ev.usage.cacheReadTokens ?? 0} / out ${ev.usage.outputTokens ?? 0}`
          : "";
        const bad = ev.code !== 0 || (ev.status && ev.status !== "SUCCESS");
        out.push(
          t.paint(`  ── end · ${secs}s${cost}${toks} · exit ${ev.code}${ev.status ? ` · ${ev.status}` : ""}`, bad ? "red" : "muted")
        );
        if (ev.stderr) for (const l of firstLines(String(ev.stderr), 8)) out.push(t.paint(`    ${l}`, "red"));
        continue;
      }

      // ---- claude stream-json ----
      if (ev.type === "system") {
        if (ev.subtype === "init") {
          out.push(t.paint(`  · session ${ev.session_id ?? ""} · ${ev.model ?? ""}`, "dim"));
        } else if (ev.subtype === "permission_denied") {
          out.push(`  ${t.paint("⛔", "red")} ${t.paint(`denied ${ev.tool_name ?? "tool"}`, "red", true)} ${t.paint(oneLine(shorten(String(ev.message ?? ev.decision_reason_type ?? "")), 140), "muted")}`);
        }
        // hooks, thinking_tokens estimates and the rest are CLI bookkeeping
        continue;
      }
      if (ev.type === "rate_limit_event") continue;
      if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "text" && block.text?.trim()) {
            for (const l of String(block.text).trim().split("\n")) out.push(`  ${l}`);
          } else if (block.type === "thinking" && block.thinking?.trim()) {
            for (const l of firstLines(String(block.thinking).trim(), 6)) out.push(t.paint(`  ∴ ${l}`, "dim"));
          } else if (block.type === "tool_use") {
            out.push(`  ${t.paint("⚙", "amber")} ${t.paint(String(block.name), "amber", true)} ${t.paint(describeToolInput(block.input, shorten), "muted")}`);
          }
        }
        continue;
      }
      if (ev.type === "user" && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type !== "tool_result") continue;
          const body = Array.isArray(block.content)
            ? block.content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
            : String(block.content ?? "");
          const head = firstLines(shorten(body.trim()), 4);
          out.push(t.paint(`    ↳ ${block.is_error ? "ERROR " : ""}${head[0] ?? "(empty)"}`, block.is_error ? "red" : "dim"));
          for (const l of head.slice(1)) out.push(t.paint(`      ${l}`, "dim"));
        }
        continue;
      }
      if (ev.type === "result") {
        continue; // the end marker carries the usage
      }

      // ---- agy event stream ----
      if (ev.event === "init") {
        out.push(t.paint(`  · conversation ${ev.conversation_id ?? ""} · ${ev.init?.model ?? ""}`, "dim"));
        continue;
      }
      if (ev.event === "step_update" && ev.step_update) {
        const su = ev.step_update;
        if (su.text_delta) {
          for (const l of String(su.text_delta).trimEnd().split("\n")) out.push(`  ${l}`);
        } else if (su.step_type && su.step_type !== "user_input") {
          const detail = su.tool_name ?? su.name ?? "";
          const arg = su.tool_input ?? su.input ?? su.args;
          out.push(
            `  ${t.paint("⚙", "amber")} ${t.paint(String(su.step_type), "amber", true)} ${t.paint(oneLine(detail || (arg ? JSON.stringify(arg) : ""), 100), "muted")}${su.state && su.state !== "DONE" ? t.paint(` (${su.state})`, "dim") : ""}`
          );
        }
        continue;
      }
      if (ev.event === "result") {
        continue;
      }

      out.push(t.paint(`  ${oneLine(line, 160)}`, "dim"));
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Show text in a pager when there is a terminal for it, else print it. `less`
 * is asked to quit if the text fits (-F), keep colors (-R), and not clear (-X).
 */
export function showInPager(text: string): void {
  if (process.stdout.isTTY && process.stdin.isTTY) {
    try {
      const r = spawnSync("less", ["-R", "-F", "-X"], { input: text, stdio: ["pipe", "inherit", "inherit"] });
      if (!r.error) return;
    } catch {
      // fall through to plain print
    }
  }
  process.stdout.write(text);
}

/** Interactive entry: pick a seat in a run and open its trace. */
export async function inspectSeat(runDir: string, who: string, opts: { tailTurns?: number } = {}): Promise<void> {
  const text = await renderSeatLog(path.resolve(runDir), who, opts);
  showInPager(text);
}
