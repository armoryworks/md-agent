/**
 * Terminal styling for md-agent, in the ArmoryWorks palette (armoryworks.com
 * `_variables.scss`): teal primary, amber accent, slate ground. Truecolor when
 * the terminal advertises it, 256-color otherwise, plain text under NO_COLOR or
 * when stdout is not a TTY.
 */

const ESC = "\x1b";

export type ColorMode = "truecolor" | "256" | "none";

export function detectColorMode(): ColorMode {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return "none";
  const ct = (process.env.COLORTERM ?? "").toLowerCase();
  if (ct.includes("truecolor") || ct.includes("24bit")) return "truecolor";
  return "256";
}

interface Swatch {
  hex: string;
  /** Nearest xterm-256 index, for terminals without 24-bit color. */
  idx: number;
}

/** Brand swatches — hex from the site, index hand-picked for the 256 cube. */
export const AW = {
  teal: { hex: "#0d9488", idx: 30 },
  tealHi: { hex: "#2dd4bf", idx: 80 },
  tealDark: { hex: "#0b7a70", idx: 29 },
  amber: { hex: "#f59e0b", idx: 214 },
  amberHi: { hex: "#fbbf24", idx: 220 },
  amberDark: { hex: "#b45309", idx: 130 },
  text: { hex: "#f1f5f9", idx: 255 },
  muted: { hex: "#94a3b8", idx: 248 },
  dim: { hex: "#64748b", idx: 243 },
  red: { hex: "#ef4444", idx: 203 },
  green: { hex: "#22c55e", idx: 77 },
} satisfies Record<string, Swatch>;

export type SwatchName = keyof typeof AW;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Theme {
  constructor(readonly mode: ColorMode = detectColorMode()) {}

  private fgCode(s: Swatch): string {
    if (this.mode === "truecolor") {
      const [r, g, b] = hexToRgb(s.hex);
      return `38;2;${r};${g};${b}`;
    }
    return `38;5;${s.idx}`;
  }

  /** Paint `text` in a brand swatch, optionally bold. */
  paint(text: string, swatch: SwatchName, bold = false): string {
    if (this.mode === "none" || !text) return text;
    const code = `${bold ? "1;" : ""}${this.fgCode(AW[swatch])}`;
    return `${ESC}[${code}m${text}${ESC}[0m`;
  }

  bold(text: string): string {
    return this.mode === "none" || !text ? text : `${ESC}[1m${text}${ESC}[0m`;
  }

  /** Reverse video — used to spotlight the active seat. */
  invert(text: string): string {
    return this.mode === "none" || !text ? text : `${ESC}[7m${text}${ESC}[0m`;
  }

  /**
   * The mark: an amber shield, left half outlined and right half filled like
   * the site logo, with the W in the accent-hi tone. Three rows tall so it fits
   * a frozen header without eating the terminal.
   */
  shield(): string[] {
    const o = (s: string) => this.paint(s, "amberDark");
    const f = (s: string) => this.paint(s, "amber");
    const w = (s: string) => this.paint(s, "amberHi", true);
    return [`${o("▄")}${f("▄▄▄")}`, `${o("█")}${w("W")}${f("██")}`, `${o("▀")}${f("▙▟▀")}`];
  }

  /** "ARMORY WORKS · md-agent", in brand tones. */
  wordmark(): string {
    return `${this.paint("ARMORY", "amber", true)} ${this.paint("WORKS", "amberHi", true)} ${this.paint("·", "dim")} ${this.paint("md-agent", "teal", true)}`;
  }

  /** Plain-text width of a string that may carry ANSI sequences. */
  static width(s: string): number {
    return s.replace(/\x1b\[[0-9;]*m/g, "").length;
  }
}

/** Shared default theme for the process. */
export const theme = new Theme();
