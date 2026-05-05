import { readdirSync } from "fs";
import { statSync } from "fs";
import { join, extname } from "path";

export function collectSlpFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectSlpFiles(full));
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".slp") {
        files.push(full);
      }
    }
  } catch {
    // unreadable
  }
  return files;
}

export function findNewestSlpWithMtime(dirs: string[]): { path: string; mtimeMs: number } | null {
  let best: { path: string; mtimeMs: number } | null = null;
  for (const dir of dirs) {
    if (!dir?.trim()) continue;
    for (const f of collectSlpFiles(dir.trim())) {
      try {
        const m = statSync(f).mtimeMs;
        if (!best || m > best.mtimeMs) best = { path: f, mtimeMs: m };
      } catch {
        // skip
      }
    }
  }
  return best;
}
