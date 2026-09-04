import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The installed package's version, read once from package.json beside dist/. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();
