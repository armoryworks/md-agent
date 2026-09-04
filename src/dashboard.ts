import util from "node:util";
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
export type SeatState = "idle" | "working" | "replied" | "dead" | "huddle";

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
  lastCost: number;
  lastCacheRead: number;
  totalCost: number;
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
  private readonly startedAt = Date.now();

  private intervalMin: number;
  private orchText = "waiting…";
  private orchSince = Date.now();
  private orchTurns = 0;
  private headerRows = 0;
  private costText = "";
  private ticker: ReturnType<typeof setInterval> | undefined;

  private readonly origLog = console.log;
  private readonly origWarn = console.warn;
  private readonly origError = console.error;

  constructor(opts: { runName: string; goal?: string; roles: DashRole[]; intervalMin: number; theme?: Theme }) {
    this.runName = opts.runName;
    this.goal = opts.goal ?? "";
    this.intervalMin = opts.intervalMin;
    this.t = opts.theme ?? defaultTheme;
    this.seats = opts.roles.map((r) => ({
      ...r,
      state: "idle",
      since: Date.now(),
      turns: 0,
      lastCost: 0,
      lastCacheRead: 0,
      totalCost: 0,
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

  /** Override a seat's state outside the send/reply flow (watchdog, huddles). */
  setSeatState(name: string, state: SeatState): void {
    const s = this.seat(name);
    if (!s) return;
    s.state = state;
    s.since = Date.now();
    this.redraw();
  }

  setIntervalMinutes(min: number): void {
    this.intervalMin = min;
    this.redraw();
  }

  /** Update the run-wide cumulative spend shown in the header. */
  setCost(usd: number): void {
    const next = `$${usd.toFixed(2)}`;
    if (next === this.costText) return;
    this.costText = next;
    this.redraw();
  }

  /**
   * Show a seat's most recent turn cost and cache-read volume, so an expensive
   * seat (e.g. runaway cache-read from a stale session) is visible live instead
   * of only in sessions/*.cost.json after the run.
   */
  setRoleTurn(name: string, costUsd: number, cacheReadTokens: number, totalUsd?: number): void {
    const s = this.seat(name);
    if (!s) return;
    s.lastCost = costUsd;
    s.lastCacheRead = cacheReadTokens;
    if (totalUsd != null) s.totalCost = totalUsd;
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
      default:
        return this.t.paint("○", "dim");
    }
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
      default:
        return this.t.paint("idle", "dim");
    }
  }

  /** The 4 lines describing one seat, plain-width aligned to `colW`. */
  private seatLines(s: Seat, colW: number): string[] {
    const pad = (line: string) => line + " ".repeat(Math.max(0, colW - Theme.width(line)));
    const provider = s.provider ?? "claude";
    const model = s.model.replace(/^claude-|^gemini-/, "");
    const cost =
      s.turns > 0
        ? `$${s.lastCost.toFixed(2)}` +
          (s.lastCacheRead ? this.t.paint(` · ⌁${formatTokens(s.lastCacheRead)}`, "dim") : "") +
          (s.totalCost ? this.t.paint(`  Σ$${s.totalCost.toFixed(2)}`, "dim") : "")
        : this.t.paint("—", "dim");
    return [
      pad(`${this.glyph(s.state)} ${this.t.bold(s.name)}`),
      pad(`  ${this.t.paint(provider, provider === "agy" ? "amberDark" : "tealDark")} ${this.t.paint("·", "dim")} ${this.t.paint(model, "muted")}`),
      pad(`  ${this.stateText(s)}${s.turns ? this.t.paint(` · ${s.turns}t`, "dim") : ""}`),
      pad(`  ${cost}`),
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
    const facts = [this.runName, this.costText, `⏱ ${elapsed}`, `ckpt ${this.intervalMin}m`]
      .filter(Boolean)
      .join(t.paint(" · ", "dim"));
    const wordmark = t.wordmark();
    const room = width - gutter - Theme.width(wordmark) - 2;
    const factsShown = Theme.width(facts) <= room ? facts : this.fit(facts, Math.max(0, room));
    const gap = Math.max(2, width - gutter - Theme.width(wordmark) - Theme.width(factsShown));
    out.push(` ${shield[0]}  ${wordmark}${" ".repeat(gap)}${t.paint(factsShown, "muted")}`);

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
      t.paint(`   turn ${this.orchTurns} · ${this.orchText} ${orchAgo}`, "muted");
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

    out.push(t.paint("─".repeat(width), "dim"));
    return out.map((l) => this.fit(l, width));
  }
}
