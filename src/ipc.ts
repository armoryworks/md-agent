import { readFile, writeFile, appendFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";

export const SENTINEL = "(incomplete communication)";
export const SAFE_WORD = "exit";

/**
 * Write content atomically-ish: first with sentinel appended, then without.
 * Readers that see the sentinel ending know the write is mid-flight.
 */
export async function safeWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content + "\n" + SENTINEL, "utf8");
  await writeFile(file, content, "utf8");
}

/**
 * Read content if file is "ready" (non-empty, not ending with the sentinel).
 * Returns null if not ready.
 */
export async function readIfReady(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  try {
    const s = await stat(file);
    if (s.size === 0) return null;
  } catch {
    return null;
  }
  const text = await readFile(file, "utf8");
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.length === 0) return null;
  if (trimmed.endsWith(SENTINEL)) return null;
  return text;
}

export async function clearFile(file: string): Promise<void> {
  await writeFile(file, "", "utf8");
}

/**
 * Append a tagged entry to the master transcript.
 *   tag: e.g. "→ researcher", "← researcher", "USER", "ORCH"
 */
export async function appendTranscript(
  transcriptFile: string,
  tag: string,
  content: string
): Promise<void> {
  await mkdir(path.dirname(transcriptFile), { recursive: true });
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS only
  const block = `\n## ${tag}  \n_${ts}_\n\n${content.trim()}\n`;
  await appendFile(transcriptFile, block, "utf8");
}

/**
 * Watch a single file for changes (write/create). Calls onReady with the
 * file's content when it transitions to a ready state (non-empty, no sentinel).
 * Returns a close function.
 */
export function watchFile(
  file: string,
  onReady: (content: string) => void | Promise<void>
): () => Promise<void> {
  const watcher = chokidar.watch(file, {
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignoreInitial: false,
  });

  const check = async () => {
    const content = await readIfReady(file);
    if (content !== null) await onReady(content);
  };

  watcher.on("add", check);
  watcher.on("change", check);

  return async () => {
    await watcher.close();
  };
}

export function isSafeWord(text: string): boolean {
  return text.trim() === SAFE_WORD;
}
