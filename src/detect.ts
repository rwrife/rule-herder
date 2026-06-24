import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Default set of agent-instruction file globs we look for.
 * Keep paths cwd-relative; detection walks the project root only (no recursion
 * beyond directories explicitly listed here).
 */
export const DEFAULT_AGENT_FILES: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
];

export interface DetectedFile {
  /** Path relative to the scanned root. */
  relPath: string;
  /** Absolute resolved path. */
  absPath: string;
  /** Size in bytes. */
  size: number;
}

export interface DetectOptions {
  /** Directory to scan. Defaults to process.cwd(). */
  cwd?: string;
  /** Override the default candidate list. */
  candidates?: readonly string[];
}

/**
 * Detect known agent files in `cwd`. Returns the subset that exist and are
 * regular files, sorted by relative path.
 */
export async function detectAgentFiles(
  options: DetectOptions = {},
): Promise<DetectedFile[]> {
  const cwd = options.cwd ?? process.cwd();
  const candidates = options.candidates ?? DEFAULT_AGENT_FILES;

  const found: DetectedFile[] = [];
  for (const rel of candidates) {
    const abs = path.resolve(cwd, rel);
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) {
        found.push({ relPath: rel, absPath: abs, size: stat.size });
      }
    } catch {
      // not present — skip
    }
  }
  found.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return found;
}
