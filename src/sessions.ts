import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import type { Provider } from "./persist.js";

/**
 * Finding a seat's session again. Two mechanisms, both keyed on the seat's
 * identity in the run rather than on anything the CLI hands back:
 *
 *  - claude sessions are MINTED: the id is a uuid v5 of `<run>/<role>#<gen>`,
 *    passed as `--session-id` on the first turn, so it is known (and in the
 *    journal) before the seat ever speaks.
 *  - every seat's first prompt opens with a MARKER line `[md-agent <run>/<role>#<gen>]`.
 *    When the stored id is gone, the CLIs' own stores are searched for it:
 *    ~/.claude/projects/<project>/<id>.jsonl (the id is the file name) and
 *    ~/.gemini/antigravity-cli/brain/<conversation-id>/ for agy.
 */

const NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"; // RFC 4122 URL namespace

export function markerFor(runName: string, role: string, gen: number): string {
  return `[md-agent ${runName}/${role}#${gen}]`;
}

/** The prefix every generation of one seat shares. */
export function markerPrefix(runName: string, role: string): string {
  return `[md-agent ${runName}/${role}#`;
}

/** Deterministic uuid v5 for a seat generation, so a resume can name the session without having captured it. */
export function mintSessionId(runName: string, role: string, gen: number): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(ns).update(`md-agent/${runName}/${role}#${gen}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function claudeProjectsRoot(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"), "projects");
}

/** The directory the claude CLI files a cwd's sessions under: the path with every non-alphanumeric run turned to `-`. */
export function claudeProjectDirFor(cwd: string): string {
  return path.join(claudeProjectsRoot(), path.resolve(cwd).replace(/[^A-Za-z0-9-]/g, "-"));
}

export function agyBrainRoot(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
}

/** Where a claude session's transcript lives, searching every project dir. */
export async function findClaudeSessionFile(id: string): Promise<string | null> {
  const root = claudeProjectsRoot();
  if (!existsSync(root)) return null;
  for (const proj of await readdir(root)) {
    const f = path.join(root, proj, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

const HEAD_BYTES = 96 * 1024;

/** Whether the first part of a file contains `needle`; returns the highest generation number after `needle` when it does. */
async function headHasMarker(file: string, prefix: string): Promise<number | null> {
  let fh;
  try {
    fh = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    let bytesRead = 0;
    try {
      ({ bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0));
    } catch {
      return null; // a directory, or unreadable
    }
    const text = buf.subarray(0, bytesRead).toString("utf8");
    let best: number | null = null;
    let from = 0;
    for (;;) {
      const i = text.indexOf(prefix, from);
      if (i < 0) break;
      const m = /^(\d+)\]/.exec(text.slice(i + prefix.length, i + prefix.length + 12));
      if (m) best = Math.max(best ?? -1, Number(m[1]));
      from = i + prefix.length;
    }
    return best;
  } finally {
    await fh.close();
  }
}

export interface FoundSession {
  id: string;
  gen: number;
  file: string;
}

/**
 * Search the provider's local store for the seat's marker. Returns the highest
 * generation found — the most recent session of that seat — or null.
 */
export async function findSessionByMarker(provider: Provider, runName: string, role: string): Promise<FoundSession | null> {
  const prefix = markerPrefix(runName, role);
  let best: FoundSession | null = null;
  const consider = (id: string, gen: number, file: string) => {
    if (!best || gen > best.gen) best = { id, gen, file };
  };
  if (provider === "claude") {
    const root = claudeProjectsRoot();
    if (!existsSync(root)) return null;
    for (const proj of await readdir(root)) {
      const dir = path.join(root, proj);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const gen = await headHasMarker(path.join(dir, name), prefix);
        if (gen !== null) consider(name.replace(/\.jsonl$/, ""), gen, path.join(dir, name));
      }
    }
    return best;
  }
  const brain = agyBrainRoot();
  if (!existsSync(brain)) return null;
  for (const conv of await readdir(brain)) {
    const msgs = path.join(brain, conv, ".system_generated", "messages");
    let names: string[];
    try {
      names = await readdir(msgs);
    } catch {
      continue;
    }
    for (const name of names) {
      const gen = await headHasMarker(path.join(msgs, name), prefix);
      if (gen !== null) {
        consider(conv, gen, path.join(msgs, name));
        break;
      }
    }
  }
  return best;
}
