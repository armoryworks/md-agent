import util from "node:util";

/**
 * A sticky, top-of-console status panel that shows the run's roles, who is
 * currently talking, and which direction a message is flowing.
 *
 * Implemented with a VT100 scroll region (DECSTBM): the top `headerRows` lines
 * are frozen and repainted in place, while all normal log output scrolls in the
 * region below. console.log/warn/error are routed through here while active so
 * existing logging "just works" beneath the panel.
 *
 * Degrades to a no-op (plain logging) when stdout is not a TTY, or when
 * MD_AGENT_NO_DASHBOARD is set.
 */

type FlowKind = "send" | "reply" | "idle";
type RoleStatus = "send" | "reply" | "idle";

interface DashRole {
  name: string;
  model: string;
}

const ESC = "\x1b";

export class Dashboard {
  private readonly enabled: boolean;
  private readonly noColor: boolean;
  private readonly runName: string;
  private readonly roles: DashRole[];
  private readonly status = new Map<string, RoleStatus>();

  private intervalMin: number;
  private flowText = "waiting…";
  private flowKind: FlowKind = "idle";
  private active: string | null = null;
  private headerRows = 0;
  private costText = "";

  private readonly origLog = console.log;
  private readonly origWarn = console.warn;
  private readonly origError = console.error;

  constructor(opts: { runName: string; roles: DashRole[]; intervalMin: number }) {
    this.runName = opts.runName;
    this.roles = opts.roles;
    this.intervalMin = opts.intervalMin;
    for (const r of opts.roles) this.status.set(r.name, "idle");
    this.enabled = !!process.stdout.isTTY && process.env.MD_AGENT_NO_DASHBOARD !== "1";
    this.noColor = !!process.env.NO_COLOR;
  }

  /** Begin: clear screen, route console output, install the scroll region. */
  start(): void {
    if (!this.enabled) return;
    console.log = (...a: unknown[]) => this.log(...a);
    console.warn = (...a: unknown[]) => this.log(...a);
    console.error = (...a: unknown[]) => this.log(...a);
    process.stdout.on("resize", this.onResize);
    process.stdout.write(`${ESC}[2J${ESC}[H`); // clear + home
    this.redraw();
  }

  /** Restore the terminal and console to their normal state. */
  stop(): void {
    if (!this.enabled) return;
    process.stdout.off("resize", this.onResize);
    console.log = this.origLog;
    console.warn = this.origWarn;
    console.error = this.origError;
    const rows = process.stdout.rows ?? 24;
    // Drop the scroll region and move below the (former) header.
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

  /**
   * Record a message flow. `from`/`to` are role names or the literal "orch".
   * Exactly one side is "orch".
   */
  flow(from: string, to: string): void {
    if (to === "orch") {
      this.status.set(from, "reply");
      this.active = from;
      this.flowKind = "reply";
      this.flowText = `${from}  ──→  ORCH`;
    } else {
      this.status.set(to, "send");
      this.active = to;
      this.flowKind = "send";
      this.flowText = `ORCH  ──→  ${to}`;
    }
    this.redraw();
  }

  /** Set a free-form status (e.g. checkpoint, stopping) with no active role. */
  setStatus(text: string): void {
    this.flowText = text;
    this.flowKind = "idle";
    this.active = null;
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
    // Region runs from just below the header to the last row, then park the
    // cursor at the bottom so subsequent log writes scroll the region.
    process.stdout.write(`${ESC}[${this.headerRows + 1};${rows}r${ESC}[${rows};1H`);
  }

  /** Repaint the frozen header rows, preserving the log cursor (DECSC/DECRC). */
  private paint(lines: string[]): void {
    let out = `${ESC}7`; // save cursor
    for (let i = 0; i < lines.length; i++) {
      out += `${ESC}[${i + 1};1H${ESC}[2K${lines[i]}`;
    }
    out += `${ESC}8`; // restore cursor
    process.stdout.write(out);
  }

  private color(s: string, code: string): string {
    return this.noColor ? s : `${ESC}[${code}m${s}${ESC}[0m`;
  }

  /** Build the header as an array of lines, each within the terminal width. */
  private render(): string[] {
    const width = Math.max(20, (process.stdout.columns ?? 80) - 1);

    // Title
    const label =
      `md-agent · ${this.runName} · checkpoint ~${this.intervalMin}m` +
      (this.costText ? ` · ${this.costText}` : "");
    let title = `── ${label} `;
    title = title.length > width ? title.slice(0, width) : title + "─".repeat(width - title.length);

    // Flow line
    const flowCode = this.flowKind === "send" ? "36;1" : this.flowKind === "reply" ? "32;1" : "2";
    const flowPlain = ` flow:  ${this.flowText}`.slice(0, width);

    // Role tokens with a direction glyph each, the active one highlighted.
    const tokens = this.roles.map((r) => {
      const st = this.status.get(r.name) ?? "idle";
      const glyph = st === "send" ? "→" : st === "reply" ? "←" : "·";
      const plain = `${glyph} ${r.name}`;
      const isActive = r.name === this.active;
      const code = isActive
        ? "7;1" // reverse + bold
        : st === "send"
          ? "36"
          : st === "reply"
            ? "32"
            : "2";
      return { plain, colored: this.color(plain, code) };
    });

    const roleLines = this.wrapTokens(tokens, width - 1).map((l) => " " + l);
    const rule = this.color("─".repeat(width), "2");

    return [this.color(title, "1"), this.color(flowPlain, flowCode), ...roleLines, rule];
  }

  /** Pack colored tokens into lines, budgeting by their visible (plain) width. */
  private wrapTokens(
    tokens: { plain: string; colored: string }[],
    maxWidth: number
  ): string[] {
    const lines: string[] = [];
    let cur = "";
    let curLen = 0;
    for (const t of tokens) {
      const sepLen = curLen === 0 ? 0 : 2;
      if (curLen + sepLen + t.plain.length > maxWidth && curLen > 0) {
        lines.push(cur);
        cur = "";
        curLen = 0;
      }
      cur += (curLen === 0 ? "" : "  ") + t.colored;
      curLen += (curLen === 0 ? 0 : 2) + t.plain.length;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }
}
