import util from "node:util";
import type { WindowSnapshot } from "./persist.js";
import { Theme, theme as defaultTheme } from "./theme.js";

/**
 * The umbrella: a sticky, top-of-console panel showing the run's goal, the
 * orchestrator, and every seat beneath it — who is working, on what provider
 * and model, for how long, at what cost. It is the run's status surface; the
 * seats' actual reasoning lives in log/<seat>.jsonl (see inspect.ts).
 *
 * Implemented with a VT100 scroll region (DECSTBM): the top `headerRows` lines
 * are frozen and repainted in place, while all normal log output scrolls in the
 * region below. console.log/warn/error are routed through here while active so
 * existing logging "just works" beneath the panel.
 *
 * Degrades to a no-op (plain logging) when stdout is not a TTY, or when
 * MD_AGENT_NO_DASHBOARD is set.
 */

/** What a seat is doing right now, as far as the orchestrator can tell. */
export type SeatState = "idle" | "working" | "replied" | "dead" | "huddle" | "stopped";

/** One turn's, or a running total's, spend — shown side by side everywhere. */
export interface Spend {
  usd: number;
  tokens: number;
}

interface DashRole {
  name: string;
  model: string;
  provider?: string;
}

interface Seat extends DashRole {
  state: SeatState;
  /** When the current state began (ms). */
  since: number;
  turns: number;
  turn: Spend | null;
  net: Spend | null;
  lastCacheRead: number;
  /** Who took over, when the seat was stopped with a handoff. */
  handoffTo?: string;
}

const ESC = "\x1b";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Wrap prose to `width`, at most `maxLines`; the last line is ellipsized if cut. */
function wrapText(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (cur.length + 1 + w.length <= width) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1];
    kept[maxLines - 1] = last.length >= width - 1 ? last.slice(0, width - 1) + "…" : last + " …";
    return kept;
  }
  return lines;
}

export class Dashboard {
  private readonly enabled: boolean;
  private readonly t: Theme;
  private readonly runName: string;
  private readonly goal: string;
  private readonly seats: Seat[];
  private readonly startedAt: number;

  private intervalMin: number;
  private orchText = "waiting…";
  private orchSince = Date.now();
  private orchTurns = 0;
  private orchTurn_: Spend | null = null;
  private orchNet: Spend | null = null;
  private headerRows = 0;
  private runNet: Spend | null = null;
  private windows: WindowSnapshot | null = null;
  private budgetNote = "";
  private journalsOff = false;
  private ticker: ReturnType<typeof setInterval> | undefined;

  private readonly origLog = console.log;
  private readonly origWarn = console.warn;
  private readonly origError = console.error;

  constructor(opts: { runName: string; goal?: string; roles: DashRole[]; intervalMin: number; theme?: Theme; startedAt?: number }) {
    this.runName = opts.runName;
    this.startedAt = opts.startedAt ?? Date.now();
    this.goal = opts.goal ?? "";
    this.intervalMin = opts.intervalMin;
    this.t = opts.theme ?? defaultTheme;
    this.seats = opts.roles.map((r) => ({
      ...r,
      state: "idle",
      since: Date.now(),
      turns: 0,
      turn: null,
      net: null,
      lastCacheRead: 0,
    }));
    this.enabled = !!process.stdout.isTTY && process.env.MD_AGENT_NO_DASHBOARD !== "1";
  }

  /** Begin: clear screen, route console output, install the scroll region. */
  start(opts: { clear?: boolean } = {}): void {
    if (!this.enabled) return;
    console.log = (...a: unknown[]) => this.log(...a);
    console.warn = (...a: unknown[]) => this.log(...a);
    console.error = (...a: unknown[]) => this.log(...a);
    process.stdout.on("resize", this.onResize);
    if (opts.clear !== false) process.stdout.write(`${ESC}[2J${ESC}[H`);
    this.headerRows = 0;
    this.redraw();
    // Elapsed counters tick even when nothing is flowing.
    this.ticker = setInterval(() => this.redraw(), 1000);
    this.ticker.unref();
  }

  /** Restore the terminal and console to their normal state. */
  stop(): void {
    if (!this.enabled) return;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    process.stdout.off("resize", this.onResize);
    console.log = this.origLog;
    console.warn = this.origWarn;
    console.error = this.origError;
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`${ESC}[r${ESC}[${rows};1H\n`);
  }

  /** Print a line into the scrolling region below the panel. */
  log(...args: unknown[]): void {
    const line = util.format(...args);
    if (!this.enabled) {
      this.origLog(line);
      return;
    }
    process.stdout.write(line + "\n");
  }

  private seat(name: string): Seat | undefined {
    return this.seats.find((s) => s.name === name);
  }

  /**
   * Record a message flow. `from`/`to` are role names or the literal "orch".
   * Exactly one side is "orch".
   */
  flow(from: string, to: string): void {
    const now = Date.now();
    if (to === "orch") {
      const s = this.seat(from);
      if (s) {
        s.state = "replied";
        s.since = now;
        s.turns++;
      }
      this.orchText = `reply from ${from}`;
      this.orchSince = now;
    } else {
      const s = this.seat(to);
      if (s) {
        s.state = "working";
        s.since = now;
      }
      this.orchText = `dispatched → ${to}`;
      this.orchSince = now;
    }
    this.redraw();
  }

  /** Set a free-form orchestrator status (checkpoint, verifying, stopping…). */
  setStatus(text: string): void {
    this.orchText = text;
    this.orchSince = Date.now();
    this.redraw();
  }

  /** Count a completed orchestrator turn. */
  orchTurn(): void {
    this.orchTurns++;
    this.orchText = "thinking done";
    this.orchSince = Date.now();
    this.redraw();
  }

  /** Mark the orchestrator as mid-turn. */
  orchThinking(): void {
    this.orchText = "thinking";
    this.orchSince = Date.now();
    this.redraw();
  }

  /** The panel as lines, for a watcher that paints it itself (no scroll region, no console capture). */
  snapshot(): string[] {
    return this.render();
  }

  /** Set the orchestrator's turn count and status directly (a watcher reading files). */
  setOrch(turns: number, text: string, since: number): void {
    this.orchTurns = turns;
    this.orchText = text;
    this.orchSince = since;
  }

  /** Set a seat's state with an explicit start time (a watcher reading files). */
  setSeat(name: string, state: SeatState, since: number, turns: number, detail?: { handoffTo?: string }): void {
    const s = this.seat(name);
    if (!s) return;
    s.state = state;
    s.since = since;
    s.turns = turns;
    if (detail?.handoffTo) s.handoffTo = detail.handoffTo;
  }

  /** A seat healed onto another provider/model mid-run. */
  setSeatModel(name: string, provider: string, model: string): void {
    const s = this.seat(name);
    if (!s) return;
    s.provider = provider;
    s.model = model;
    this.redraw();
  }

  /** Override a seat's state outside the send/reply flow (watchdog, huddles, stops). */
  setSeatState(name: string, state: SeatState, detail?: { handoffTo?: string }): void {
    const s = this.seat(name);
    if (!s) return;
    s.state = state;
    s.since = Date.now();
    if (detail?.handoffTo) s.handoffTo = detail.handoffTo;
    this.redraw();
  }

  /** The orchestrator's own last-turn and net spend. */
  setOrchSpend(turn: Spend | null, net: Spend): void {
    this.orchTurn_ = turn;
    this.orchNet = net;
    this.redraw();
  }

  /** Run-wide net spend, every seat and the orchestrator. */
  setRunSpend(net: Spend): void {
    this.runNet = net;
    this.redraw();
  }

  /** Latest plan-window utilization any claude seat reported. */
  setWindows(w: WindowSnapshot | null): void {
    this.windows = w;
    this.redraw();
  }

  /** Show in the footer that journals were opted out, with the keyword that turns them back on. */
  setJournalsOff(off: boolean): void {
    this.journalsOff = off;
    this.redraw();
  }

  /** A short budget state for the header, e.g. "soft $ line passed — winding down". */
  setBudgetNote(note: string): void {
    this.budgetNote = note;
    this.redraw();
  }

  setIntervalMinutes(min: number): void {
    this.intervalMin = min;
    this.redraw();
  }

  /**
   * A seat's most recent turn next to its running total, so an expensive seat
   * (e.g. runaway cache-read from a stale session) is visible live instead of
   * only in sessions/*.cost.json after the run.
   */
  setRoleSpend(name: string, turn: Spend | null, net: Spend, cacheReadTokens: number): void {
    const s = this.seat(name);
    if (!s) return;
    s.turn = turn;
    s.net = net;
    s.lastCacheRead = cacheReadTokens;
    this.redraw();
  }

  // ---------- internals ----------

  private readonly onResize = (): void => {
    if (!this.enabled) return;
    const lines = this.render();
    this.headerRows = lines.length;
    this.applyScrollRegion();
    this.paint(lines);
  };

  private redraw(): void {
    if (!this.enabled) return;
    const lines = this.render();
    if (lines.length !== this.headerRows) {
      this.headerRows = lines.length;
      this.applyScrollRegion();
    }
    this.paint(lines);
  }

  private applyScrollRegion(): void {
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`${ESC}[${this.headerRows + 1};${rows}r${ESC}[${rows};1H`);
  }

  /** Repaint the frozen header rows, preserving the log cursor (DECSC/DECRC). */
  private paint(lines: string[]): void {
    let out = `${ESC}7`;
    for (let i = 0; i < lines.length; i++) {
      out += `${ESC}[${i + 1};1H${ESC}[2K${lines[i]}`;
    }
    out += `${ESC}8`;
    process.stdout.write(out);
  }

  /** Truncate to `width` visible columns without cutting an ANSI sequence. */
  private fit(s: string, width: number): string {
    if (Theme.width(s) <= width) return s;
    let out = "";
    let seen = 0;
    for (let i = 0; i < s.length; ) {
      if (s[i] === "\x1b") {
        const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
        if (m) {
          out += m[0];
          i += m[0].length;
          continue;
        }
      }
      if (seen >= width) break;
      out += s[i];
      seen++;
      i++;
    }
    return out + "\x1b[0m";
  }

  private glyph(state: SeatState): string {
    switch (state) {
      case "working":
        return this.t.paint("●", "amber", true);
      case "replied":
        return this.t.paint("◐", "teal", true);
      case "dead":
        return this.t.paint("✖", "red", true);
      case "huddle":
        return this.t.paint("◆", "tealHi", true);
      case "stopped":
        return this.t.paint("⏹", "dim");
      default:
        return this.t.paint("○", "dim");
    }
  }

  private spendText(turn: Spend | null, net: Spend | null): string {
    if (!turn && !net) return this.t.paint("—", "dim");
    const one = (s: Spend) => `$${s.usd.toFixed(2)}·${formatTokens(s.tokens)}`;
    return (
      (turn ? `${this.t.paint("▸", "muted")} ${one(turn)}` : "") +
      (turn && net ? "  " : "") +
      (net ? this.t.paint(`Σ ${one(net)}`, "dim") : "")
    );
  }

  private stateText(s: Seat): string {
    const ago = formatAgo(Date.now() - s.since);
    switch (s.state) {
      case "working":
        return this.t.paint(`working ${ago}`, "amber");
      case "replied":
        return this.t.paint(`replied ${ago} ago`, "teal");
      case "dead":
        return this.t.paint(`recovering ${ago}`, "red");
      case "huddle":
        return this.t.paint(`in huddle ${ago}`, "tealHi");
      case "stopped":
        return this.t.paint(s.handoffTo ? `stopped → ${s.handoffTo}` : "stopped · abandoned", "red");
      default:
        return this.t.paint("idle", "dim");
    }
  }

  /** The lines describing one seat, plain-width aligned to `colW`. */
  private seatLines(s: Seat, colW: number): string[] {
    const pad = (line: string) => line + " ".repeat(Math.max(0, colW - Theme.width(line)));
    const provider = s.provider ?? "claude";
    const model = s.model.replace(/^claude-|^gemini-/, "");
    return [
      pad(`${this.glyph(s.state)} ${this.t.bold(s.name)}`),
      pad(`  ${this.t.paint(provider, provider === "agy" ? "amberDark" : "tealDark")} ${this.t.paint("·", "dim")} ${this.t.paint(model, "muted")}`),
      pad(`  ${this.stateText(s)}${s.turns ? this.t.paint(` · ${s.turns}t`, "dim") : ""}`),
      pad(`  ${this.spendText(s.turn, s.net)}`),
    ];
  }

  /**
   * The line joining the orchestrator (at `center`) to each seat column
   * (at `centers`): ┌──┬──┴──┬──┐ and its degenerate forms.
   */
  private connector(width: number, center: number, centers: number[]): string {
    const row = new Array<string>(width).fill(" ");
    const lo = Math.min(...centers, center);
    const hi = Math.max(...centers, center);
    if (lo === hi) {
      row[center] = "│";
      return row.join("").replace(/\s+$/, "");
    }
    for (let x = lo; x <= hi; x++) row[x] = "─";
    for (const c of centers) row[c] = "┬";
    const atSeat = centers.includes(center);
    row[center] = atSeat ? "┼" : "┴";
    row[lo] = lo === center ? (atSeat ? "├" : "└") : "┌";
    row[hi] = hi === center ? (atSeat ? "┤" : "┘") : "┐";
    return row.join("").replace(/\s+$/, "");
  }

  /** Build the header as an array of lines, each within the terminal width. */
  private render(): string[] {
    const width = Math.max(40, (process.stdout.columns ?? 80) - 1);
    const t = this.t;
    const out: string[] = [];

    // -- banner: shield + wordmark + run facts, goal beside the shield --
    const shield = t.shield();
    const shieldW = 4;
    const gutter = shieldW + 3;
    const elapsed = formatAgo(Date.now() - this.startedAt);
    const pct = (x?: { utilization: number }) => (x ? `${Math.round(x.utilization * 100)}%` : null);
    const w5 = pct(this.windows?.fiveHour);
    const w7 = pct(this.windows?.sevenDay);
    // Facts in priority order; the least important are dropped first when the
    // terminal is narrow rather than truncating the line mid-word.
    const factList: { text: string; keep: number }[] = [
      { text: this.budgetNote ? t.paint(this.budgetNote, "amber") : "", keep: 5 },
      { text: this.runNet ? `Σ $${this.runNet.usd.toFixed(2)} · ${formatTokens(this.runNet.tokens)}` : "", keep: 4 },
      { text: w5 || w7 ? `5h ${w5 ?? "—"} · 7d ${w7 ?? "—"}` : "", keep: 3 },
      { text: `⏱ ${elapsed}`, keep: 2 },
      { text: this.runName, keep: 1 },
      { text: `ckpt ${this.intervalMin}m`, keep: 0 },
    ].filter((f) => f.text);
    const wordmark = t.wordmark();
    const room = width - gutter - Theme.width(wordmark) - 2;
    const joinFacts = (fs: { text: string }[]) => fs.map((f) => f.text).join(t.paint(" · ", "dim"));
    let shown = [...factList];
    while (shown.length && Theme.width(joinFacts(shown)) > room) {
      const drop = shown.reduce((m, f) => (f.keep < m.keep ? f : m));
      shown = shown.filter((f) => f !== drop);
    }
    const facts = joinFacts(shown);
    const gap = Math.max(2, width - gutter - Theme.width(wordmark) - Theme.width(facts));
    out.push(` ${shield[0]}  ${wordmark}${" ".repeat(gap)}${t.paint(facts, "muted")}`);

    const goalLabel = t.paint("GOAL", "amberHi", true);
    const goalLines = wrapText(this.goal || "(no goal recorded)", width - gutter - 6, 2);
    out.push(` ${shield[1]}  ${goalLabel}  ${t.paint(goalLines[0] ?? "", "text")}`);
    out.push(` ${shield[2]}  ${" ".repeat(4)}  ${t.paint(goalLines[1] ?? "", "text")}`);

    // -- seats: columns centered, wrapped into bands; the orchestrator sits over the first band --
    const seatBlocks = this.seats.map((s) => this.seatLines(s, 0));
    const colW = Math.min(
      width - 2,
      Math.max(18, ...seatBlocks.flat().map((l) => Theme.width(l))) + 3
    );
    const perBand = Math.max(1, Math.floor((width - 2) / colW));
    const bands: Seat[][] = [];
    for (let i = 0; i < this.seats.length; i += perBand) bands.push(this.seats.slice(i, i + perBand));
    const bandGeometry = (band: Seat[]) => {
      const left = Math.max(1, Math.floor((width - band.length * colW) / 2));
      const centers = band.map((_, i) => left + i * colW + Math.floor(colW / 2) - 1);
      return { left, centers };
    };
    const first = bands.length ? bandGeometry(bands[0]) : { left: 1, centers: [Math.floor(width / 2)] };
    // Odd band: the junction lands on the middle seat; even: between the two middle seats.
    const center =
      first.centers.length % 2 === 1
        ? first.centers[(first.centers.length - 1) / 2]
        : Math.floor((first.centers[first.centers.length / 2 - 1] + first.centers[first.centers.length / 2]) / 2);

    // -- orchestrator --
    const orchAgo = formatAgo(Date.now() - this.orchSince);
    const orchLine =
      `${t.paint("◆", "amber", true)} ${t.bold("orchestrator")}` +
      t.paint(`   turn ${this.orchTurns} · ${this.orchText} ${orchAgo}`, "muted") +
      (this.orchTurn_ || this.orchNet ? `   ${this.spendText(this.orchTurn_, this.orchNet)}` : "");
    const orchPad = Math.max(1, Math.min(center, width - Theme.width(orchLine) - 1));
    out.push(" ".repeat(orchPad) + orchLine);

    bands.forEach((band, bi) => {
      const { left, centers } = bandGeometry(band);
      if (bi === 0) {
        out.push(t.paint(this.connector(width, center, centers), "dim"));
      } else {
        out.push("");
      }
      const blocks = band.map((s) => this.seatLines(s, colW));
      for (let li = 0; li < 4; li++) {
        out.push(" ".repeat(left) + blocks.map((b) => b[li]).join("").replace(/\s+$/, ""));
      }
    });

    const hint = ` ctrl-x stop seats · show <seat> · exit${this.journalsOff ? ' · journals off (type "journals")' : ""} `;
    const rule = width > hint.length + 8 ? `──${hint}${"─".repeat(width - hint.length - 2)}` : "─".repeat(width);
    out.push(t.paint(rule, "dim"));
    return out.map((l) => this.fit(l, width));
  }
}
