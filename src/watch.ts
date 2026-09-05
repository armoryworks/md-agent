import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { Dashboard, type SeatState } from "./dashboard.js";
import {
  normalizeProvider,
  readCost,
  readLatestWindow,
  readRunCost,
  readState,
  resolveModelFor,
  type RunState,
  usageTokens,
} from "./persist.js";
import { Theme, theme as t } from "./theme.js";

/**
 * A read-only live view of a run, built from its files alone — state.json,
 * the transcript, mailboxes, heartbeats, cost and window files. The same
 * umbrella the run's own console shows, but paintable from anywhere: a second
 * terminal, a Claude Code session that launched the run detached, or a
 * snapshot in a message. `--once` prints one frame; `--json` prints the facts.
 */

const ESC = "\x1b";

interface Event {
  time: string;
  tag: string;
}

/** Transcript headers with their times: `## <tag>` then `_HH:MM:SS_`. */
async function recentEvents(runDir: string, max = 8): Promise<Event[]> {
  const file = path.join(runDir, "transcript.md");
  if (!existsSync(file)) return [];
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  const out: Event[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const h = /^## (.+?)\s*$/.exec(lines[i]);
    const tm = /^_(\d{2}:\d{2}:\d{2})_\s*$/.exec(lines[i + 1] ?? "");
    if (h && tm) out.push({ tag: h[1].trim(), time: tm[1] });
  }
  return out.slice(-max);
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

async function fileText(file: string): Promise<string> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

export type RunLiveness = "running" | "complete" | "halted" | "unfinished";

export interface WatchFrame {
  run: string;
  status: RunLiveness;
  goal: string;
  endReason?: string;
  spend: { usd: number; tokens: number; turns: number };
  windows: { fiveHour?: number; sevenDay?: number };
  orchestrator: { turns: number; last: string; sinceMs: number };
  seats: { name: string; provider: string; model: string; state: SeatState; sinceMs: number; turns: number; usd: number; tokens: number; handoffTo?: string; stoppedReason?: string; healedFrom?: string }[];
  events: Event[];
}

/** Everything the watcher shows, as data. */
export async function readFrame(runDir: string): Promise<WatchFrame> {
  const state: RunState = await readState(runDir);
  const now = Date.now();
  const beats = (who: string) => mtime(path.join(runDir, "sessions", `${who}.heartbeat`));
  const pidAlive = (() => {
    try {
      const pid = Number(readFileSync(path.join(runDir, "orchestrator.pid"), "utf8").trim());
      if (!pid) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  const anyBeat = Math.max(beats("orchestrator"), ...state.roles.map((r) => beats(r.name)));
  const status: RunLiveness = existsSync(path.join(runDir, "HALT.txt"))
    ? "halted"
    : state.endedAt
      ? "complete"
      : pidAlive || now - anyBeat < 90_000
        ? "running"
        : "unfinished";

  const events = await recentEvents(runDir, 12);
  const lastEvent = events[events.length - 1];
  const orchCost = await readCost(runDir, "orchestrator");
  const orchBeat = beats("orchestrator");
  let orchText = lastEvent ? lastEvent.tag : "waiting…";
  if (status === "running" && now - orchBeat < 8_000) orchText = "thinking";
  const orchSince = status === "running" && now - orchBeat < 8_000 ? orchBeat : mtime(path.join(runDir, "transcript.md")) || now;

  const seats: WatchFrame["seats"] = [];
  for (const r of state.roles) {
    const provider = normalizeProvider(r.provider);
    const cost = await readCost(runDir, r.name);
    const inbox = await fileText(path.join(runDir, "inbox", `${r.name}.txt`));
    const outbox = await fileText(path.join(runDir, "outbox", `${r.name}.txt`));
    const beat = beats(r.name);
    let seatState: SeatState = "idle";
    let since = mtime(path.join(runDir, "transcript.md")) || now;
    if (r.stopped) {
      seatState = "stopped";
      since = Date.parse(r.stopped.at) || now;
    } else if (status !== "running") {
      seatState = "idle";
    } else if (inbox && inbox !== "exit") {
      seatState = "working";
      since = mtime(path.join(runDir, "inbox", `${r.name}.txt`));
    } else if (now - beat < 8_000) {
      seatState = "working";
      since = beat;
    } else if (outbox && outbox !== "exit") {
      seatState = "replied";
      since = mtime(path.join(runDir, "outbox", `${r.name}.txt`));
    } else {
      const last = [...events].reverse().find((e) => e.tag === `← ${r.name}` || e.tag === `→ ${r.name}`);
      if (last?.tag.startsWith("→")) {
        seatState = "working";
      } else if (last?.tag.startsWith("←")) {
        seatState = "replied";
      }
    }
    seats.push({
      name: r.name,
      provider,
      model: resolveModelFor(provider, r.model),
      state: seatState,
      sinceMs: since,
      turns: cost.turns,
      usd: cost.costUsd,
      tokens: usageTokens(cost),
      handoffTo: r.stopped?.handoffTo,
      stoppedReason: r.stopped?.reason,
      healedFrom: r.healed?.length ? `${r.healed[0].from.provider}·${r.healed[0].from.model}` : undefined,
    });
  }

  const total = await readRunCost(runDir);
  const w = await readLatestWindow(runDir);
  return {
    run: path.basename(runDir),
    status,
    goal: state.goal,
    endReason: state.endReason,
    spend: { usd: total.costUsd, tokens: usageTokens(total), turns: total.turns },
    windows: { fiveHour: w?.fiveHour?.utilization, sevenDay: w?.sevenDay?.utilization },
    orchestrator: { turns: orchCost.turns, last: orchText, sinceMs: orchSince },
    seats,
    events,
  };
}

/** One frame of the umbrella + recent events + status, as lines. */
export async function renderFrame(runDir: string, theme: Theme = t): Promise<string[]> {
  const f = await readFrame(runDir);
  const state = await readState(runDir);
  const dash = new Dashboard({
    runName: f.run,
    goal: f.goal,
    roles: f.seats.map((s) => ({ name: s.name, model: s.model, provider: s.provider })),
    intervalMin: state.maxMinutes ?? 10,
    theme,
    startedAt: mtime(path.join(runDir, "state.json")) || Date.now(),
  });
  dash.setRunSpend({ usd: f.spend.usd, tokens: f.spend.tokens });
  dash.setWindows(
    f.windows.fiveHour != null || f.windows.sevenDay != null
      ? {
          fiveHour: f.windows.fiveHour != null ? { utilization: f.windows.fiveHour, resetsAt: 0 } : undefined,
          sevenDay: f.windows.sevenDay != null ? { utilization: f.windows.sevenDay, resetsAt: 0 } : undefined,
          at: Date.now(),
        }
      : null
  );
  dash.setOrch(f.orchestrator.turns, f.orchestrator.last, f.orchestrator.sinceMs);
  const orchCost = await readCost(runDir, "orchestrator");
  if (orchCost.turns) dash.setOrchSpend(null, { usd: orchCost.costUsd, tokens: usageTokens(orchCost) });
  for (const s of f.seats) {
    dash.setSeat(s.name, s.state, s.sinceMs, s.turns, { handoffTo: s.handoffTo });
    if (s.turns) dash.setRoleSpend(s.name, null, { usd: s.usd, tokens: s.tokens }, 0);
  }
  const lines = dash.snapshot();
  // The watcher's footer replaces the console hint: this view has no keys.
  lines[lines.length - 1] = theme.paint(`── ${f.run} · ${statusWord(f.status, theme)}${f.endReason ? theme.paint(` · ${f.endReason}`, "dim") : ""} `, "dim");

  const dim = (x: string) => theme.paint(x, "dim");
  lines.push("");
  lines.push(theme.bold(" recent"));
  for (const e of f.events.slice(-8)) {
    const color = /VERIFY PASS/.test(e.tag) ? "green" : /FAIL|HALT|ERROR|STOPPED|LOOP/.test(e.tag) ? "red" : /^→/.test(e.tag) ? "amber" : /^←/.test(e.tag) ? "teal" : "muted";
    lines.push(`  ${dim(e.time)}  ${theme.paint(e.tag, color as any)}`);
  }
  return lines;
}

function statusWord(s: RunLiveness, theme: Theme): string {
  switch (s) {
    case "running":
      return theme.paint("● running", "amber", true);
    case "complete":
      return theme.paint("✔ complete", "green", true);
    case "halted":
      return theme.paint("▲ HALTED", "red", true);
    default:
      return theme.paint("◐ unfinished", "teal");
  }
}

/**
 * `md-agent --watch <run-dir>`: on a terminal, the umbrella repainted every 2s
 * until the run ends (or ctrl-c); piped, the digest printed on each change
 * every `--every N` seconds until the run ends; `--once` one frame; `--json`
 * the frame as data. `--status` is the digest, once.
 */
export async function watchRun(runDir: string, opts: { once?: boolean; json?: boolean; intervalMs?: number; everySec?: number } = {}): Promise<void> {
  if (!existsSync(path.join(runDir, "state.json"))) {
    console.error(`no run at ${runDir} (missing state.json)`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify(await readFrame(runDir), null, 2));
    return;
  }
  // No terminal and not asked for one frame: the digest stream — what a
  // background monitor wants (each change once, until the run ends).
  if (!process.stdout.isTTY && !opts.once) {
    await watchDigest(runDir, opts.everySec ?? 120);
    return;
  }
  const live = !opts.once && process.stdout.isTTY;
  const theme = process.stdout.isTTY ? t : new Theme("none");
  const paint = async () => {
    const lines = await renderFrame(runDir, theme);
    if (live) process.stdout.write(`${ESC}[2J${ESC}[H`);
    process.stdout.write(lines.join("\n") + "\n");
    return lines;
  };
  await paint();
  if (!live) return;
  const interval = opts.intervalMs ?? 2000;
  for (;;) {
    await new Promise((r) => setTimeout(r, interval));
    await paint();
    const f = await readFrame(runDir);
    if (f.status === "complete" || f.status === "halted") {
      process.stdout.write(`\n${t.paint(f.status === "complete" ? "run complete" : "run halted", f.status === "complete" ? "green" : "red")} — ${runDir}\n`);
      return;
    }
  }
}

// ---------- the digest ----------
// A few lines a program (or a Claude session) can relay verbatim: what each
// seat is doing right now, what it has done, what it cost, what the run has
// produced. --status prints one; a non-TTY --watch prints one whenever it
// changes until the run ends — the shape a background monitor wants.

interface SeatDigest {
  name: string;
  state: SeatState;
  sinceMs: number;
  turns: number;
  usd: number;
  tokens: number;
  toolCalls: Record<string, number>;
  current: string;
  lastSaid: string;
}

// A seat's trace only grows, so each digest parses the bytes appended since
// the last one and carries the tallies forward (a long agy seat's trace runs
// to tens of MB; re-reading it every tick was the watcher's whole cost).
interface DigestCursor {
  offset: number;
  toolCalls: Record<string, number>;
  current: string;
  lastSaid: string;
  inTurn: boolean;
  partial: string;
}
const digestCursors = new Map<string, DigestCursor>();

async function seatDigest(runDir: string, seat: WatchFrame["seats"][number]): Promise<SeatDigest> {
  const file = path.join(runDir, "log", `${seat.name}.jsonl`);
  let cur = digestCursors.get(file);
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (!cur || size < cur.offset) {
    cur = { offset: 0, toolCalls: {}, current: "", lastSaid: "", inTurn: false, partial: "" };
    digestCursors.set(file, cur);
  }
  const { toolCalls } = cur;
  let { current, lastSaid, inTurn } = cur;
  try {
    let lines: string[] = [];
    if (size > cur.offset) {
      const fh = await open(file, "r");
      try {
        const buf = Buffer.alloc(size - cur.offset);
        const { bytesRead } = await fh.read(buf, 0, buf.length, cur.offset);
        cur.offset += bytesRead;
        const text = cur.partial + buf.subarray(0, bytesRead).toString("utf8");
        lines = text.split("\n");
        cur.partial = lines.pop() ?? "";
      } finally {
        await fh.close();
      }
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.md === "turn") inTurn = true;
      if (ev.md === "end") {
        inTurn = false;
        current = "";
      }
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b.type === "tool_use") {
            toolCalls[b.name] = (toolCalls[b.name] ?? 0) + 1;
            const arg = b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? b.input?.description ?? "";
            current = `${b.name} ${String(arg).replace(/\s+/g, " ").slice(0, 80)}`.trim();
          } else if (b.type === "text" && String(b.text).trim()) {
            lastSaid = String(b.text).trim().split("\n")[0].slice(0, 120);
          }
        }
      }
      if (ev.event === "step_update" && ev.step_update) {
        const su = ev.step_update;
        if (su.text_delta) lastSaid = String(su.text_delta).trim().split("\n")[0].slice(0, 120) || lastSaid;
        else if (su.step_type && su.step_type !== "user_input" && su.step_type !== "agent_response") {
          toolCalls[su.step_type] = (toolCalls[su.step_type] ?? 0) + 1;
          current = String(su.step_type);
        }
      }
    }
  } catch {
    // no trace yet
  }
  Object.assign(cur, { current, lastSaid, inTurn });
  return {
    name: seat.name,
    state: seat.state,
    sinceMs: seat.sinceMs,
    turns: seat.turns,
    usd: seat.usd,
    tokens: seat.tokens,
    toolCalls: { ...toolCalls },
    current: inTurn ? current : "",
    lastSaid,
  };
}

export interface Digest {
  text: string;
  /** Changes when anything worth reporting changed — compare to skip a repeat. */
  key: string;
  status: RunLiveness;
}

/** Elapsed time, last headings, artifacts, and per seat: tool calls by kind, what it is on, its last line, cost. */
export async function runDigest(runDir: string): Promise<Digest> {
  const f = await readFrame(runDir);
  const state = await readState(runDir);
  const startMs = mtime(path.join(runDir, "state.json")) || Date.now();
  const elapsedMin = Math.max(0, Math.round((Date.now() - startMs) / 60000));
  const ledger = await fileText(path.join(runDir, "ledger.md"));
  const artifacts = /## Artifacts produced\s*\n([\s\S]*?)(?:\n## |$)/.exec(ledger)?.[1]?.trim() ?? "";
  const ago = (ms: number) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  };
  const lines: string[] = [];
  lines.push(`${f.run} — ${f.status}${f.endReason ? ` (${f.endReason})` : ""} · ${elapsedMin} min · $${f.spend.usd.toFixed(2)} · ${Math.round(f.spend.tokens / 1000)}k tok · ${f.spend.turns} turns` +
    (f.windows.fiveHour != null ? ` · 5h ${Math.round(f.windows.fiveHour * 100)}%` : ""));
  lines.push(`orchestrator: turn ${f.orchestrator.turns} · ${f.orchestrator.last} (${ago(f.orchestrator.sinceMs)})`);
  for (const s of f.seats) {
    const d = await seatDigest(runDir, s);
    const calls = Object.entries(d.toolCalls).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join(" ");
    const stateText =
      s.state === "stopped" ? `stopped${s.handoffTo ? ` → ${s.handoffTo}` : ""}${s.stoppedReason ? ` (${s.stoppedReason.slice(0, 60)})` : ""}` :
      s.state === "working" ? `working ${ago(s.sinceMs)}` :
      s.state === "replied" ? `replied ${ago(s.sinceMs)} ago` : s.state;
    lines.push(`  ${s.name} [${s.provider}·${s.model.replace(/^claude-|^gemini-/, "")}${s.healedFrom ? ` ← healed from ${s.healedFrom.replace(/claude-|gemini-/, "")}` : ""}]: ${stateText} · ${s.turns}t · $${s.usd.toFixed(2)} · ${Math.round(s.tokens / 1000)}k tok${calls ? ` · ${calls}` : ""}`);
    if (d.current && s.state === "working") lines.push(`      on: ${d.current}`);
    if (d.lastSaid) lines.push(`      last: ${d.lastSaid}`);
  }
  if (f.events.length) lines.push(`recent: ${f.events.slice(-5).map((e) => `${e.time} ${e.tag}`).join(" · ")}`);
  if (artifacts) {
    lines.push("artifacts:");
    for (const l of artifacts.split("\n").slice(0, 8)) lines.push(`  ${l}`);
  }
  const key = JSON.stringify({
    status: f.status,
    turns: f.spend.turns,
    ev: f.events[f.events.length - 1],
    seats: f.seats.map((s) => [s.name, s.state, s.turns]),
    usd: Math.round(f.spend.usd * 100),
  });
  return { text: lines.join("\n"), key, status: f.status };
}

/**
 * Print the digest now and then whenever it changes, every `everySec`, until
 * the run ends or HALTs. What a background monitor (a Claude session that
 * launched the run detached) wants: progress as it lands, nothing repeated.
 */
export async function watchDigest(runDir: string, everySec = 120): Promise<void> {
  let last = "";
  for (;;) {
    const d = await runDigest(runDir);
    if (d.key !== last) {
      last = d.key;
      process.stdout.write(`${new Date().toISOString().slice(11, 19)}\n${d.text}\n\n`);
    }
    if (d.status === "complete" || d.status === "halted") return;
    await new Promise((r) => setTimeout(r, Math.max(5, everySec) * 1000));
  }
}
