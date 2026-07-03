import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_AGENT_FILES } from "./detect.js";

/**
 * Optional `.ruleherder.json` config. All fields are optional; sensible defaults
 * are baked in so projects only need this file when they want to deviate.
 *
 * Example:
 *
 * ```json
 * {
 *   "extends": ["docs/AGENTS.md"],
 *   "ignore": ["CLAUDE.md"],
 *   "aliases": {
 *     "rules": ["Rules", "Guidelines", "Conventions > Rules"]
 *   },
 *   "thresholds": { "drift": 0.25, "reworded": 0.55 }
 * }
 * ```
 */
export interface RuleHerderConfig {
  /** Replace the default candidate list entirely. Mutually exclusive with `extends`. */
  files?: string[];
  /** Append additional candidates to the default list. Ignored when `files` is set. */
  extends?: string[];
  /** Relative paths to drop from the detected/candidate set. Matched exact. */
  ignore?: string[];
  /**
   * Heading-path aliases: canonical key → array of equivalent heading paths.
   * A heading path is given as `Parent > Child` (case-insensitive). Differently-worded
   * headings that map to the same canonical key are matched together by the drift engine.
   */
  aliases?: Record<string, string[]>;
  /** Drift thresholds. */
  thresholds?: {
    /** Overall drift threshold for `diff` exit-code (0..1). Default 0.2. */
    drift?: number;
    /** Body-similarity threshold above which two blocks count as "reworded". Default 0.6. */
    reworded?: number;
  };
  /**
   * Optional opt-in LLM block-matcher settings. **The LLM matcher is never
   * invoked unless `llm.enabled` is `true` here OR the caller passes
   * `--llm-match` explicitly on the CLI.** This is a deliberate belt-and-braces
   * default so config alone can never accidentally start making network calls
   * on someone else's machine (e.g. a checked-in `.ruleherder.json`).
   */
  llm?: {
    /** Opt-in switch. Default `false`. */
    enabled?: boolean;
    /** OpenAI-compatible chat/completions URL. Env: `RULE_HERDER_LLM_URL`. */
    url?: string;
    /** Model identifier sent in the request body. Env: `RULE_HERDER_LLM_MODEL`. */
    model?: string;
    /**
     * API key. Env: `RULE_HERDER_LLM_KEY`. Optional — many local backends
     * (Ollama, LM Studio, llama.cpp) do not require one.
     */
    apiKey?: string;
    /** Drop matches under this confidence (0..1). Default 0.7. */
    minConfidence?: number;
    /** Max candidate pairs per run. Default 50. */
    maxCandidates?: number;
  };
}

export const CONFIG_FILENAME = ".ruleherder.json";

/** Default config used when no `.ruleherder.json` is present. */
export const DEFAULT_CONFIG: {
  files: readonly string[];
  ignore: readonly string[];
  aliases: Record<string, string[]>;
  thresholds: { drift: number; reworded: number };
  llm: {
    enabled: boolean;
    url: string | null;
    model: string | null;
    apiKey: string | null;
    minConfidence: number;
    maxCandidates: number;
  };
} = {
  files: DEFAULT_AGENT_FILES,
  ignore: [],
  aliases: {},
  thresholds: { drift: 0.2, reworded: 0.6 },
  llm: {
    enabled: false,
    url: null,
    model: null,
    apiKey: null,
    minConfidence: 0.7,
    maxCandidates: 50,
  },
};

export interface LoadedConfig {
  /** Effective candidate file list after applying files/extends. */
  files: string[];
  /** Effective ignore list (relative paths). */
  ignore: string[];
  /** Normalized alias map: canonical key → lowercased ` > `-joined heading paths. */
  aliases: Record<string, string[]>;
  /** Effective thresholds (defaults applied). */
  thresholds: { drift: number; reworded: number };
  /** Effective LLM matcher settings (defaults applied). */
  llm: {
    enabled: boolean;
    url: string | null;
    model: string | null;
    apiKey: string | null;
    minConfidence: number;
    maxCandidates: number;
  };
  /** Absolute path of the loaded config file, or null when defaults are used. */
  configPath: string | null;
}

function asStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new TypeError(`${CONFIG_FILENAME}: "${field}" must be a string array`);
  }
  return v as string[];
}

function asBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") {
    throw new TypeError(`${CONFIG_FILENAME}: "${field}" must be a boolean`);
  }
  return v;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") {
    throw new TypeError(`${CONFIG_FILENAME}: "${field}" must be a string`);
  }
  return v;
}

function asNumber(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TypeError(`${CONFIG_FILENAME}: "${field}" must be a finite number`);
  }
  return v;
}

/**
 * Validate a parsed JSON object as a RuleHerderConfig. Unknown fields are ignored
 * (forward-compatible) but typed fields are strictly checked.
 */
export function validateConfig(raw: unknown): RuleHerderConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`${CONFIG_FILENAME}: root must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const out: RuleHerderConfig = {};
  if (obj.files !== undefined) out.files = asStringArray(obj.files, "files");
  if (obj.extends !== undefined) out.extends = asStringArray(obj.extends, "extends");
  if (obj.ignore !== undefined) out.ignore = asStringArray(obj.ignore, "ignore");
  if (obj.aliases !== undefined) {
    if (obj.aliases === null || typeof obj.aliases !== "object" || Array.isArray(obj.aliases)) {
      throw new TypeError(`${CONFIG_FILENAME}: "aliases" must be an object`);
    }
    const aliases: Record<string, string[]> = {};
    for (const [canonical, variants] of Object.entries(obj.aliases as Record<string, unknown>)) {
      aliases[canonical] = asStringArray(variants, `aliases["${canonical}"]`);
    }
    out.aliases = aliases;
  }
  if (obj.thresholds !== undefined) {
    if (obj.thresholds === null || typeof obj.thresholds !== "object" || Array.isArray(obj.thresholds)) {
      throw new TypeError(`${CONFIG_FILENAME}: "thresholds" must be an object`);
    }
    const t = obj.thresholds as Record<string, unknown>;
    out.thresholds = {};
    if (t.drift !== undefined) out.thresholds.drift = asNumber(t.drift, "thresholds.drift");
    if (t.reworded !== undefined) out.thresholds.reworded = asNumber(t.reworded, "thresholds.reworded");
  }
  if (obj.llm !== undefined) {
    if (obj.llm === null || typeof obj.llm !== "object" || Array.isArray(obj.llm)) {
      throw new TypeError(`${CONFIG_FILENAME}: "llm" must be an object`);
    }
    const l = obj.llm as Record<string, unknown>;
    out.llm = {};
    if (l.enabled !== undefined) out.llm.enabled = asBoolean(l.enabled, "llm.enabled");
    if (l.url !== undefined) out.llm.url = asString(l.url, "llm.url");
    if (l.model !== undefined) out.llm.model = asString(l.model, "llm.model");
    if (l.apiKey !== undefined) out.llm.apiKey = asString(l.apiKey, "llm.apiKey");
    if (l.minConfidence !== undefined) {
      out.llm.minConfidence = asNumber(l.minConfidence, "llm.minConfidence");
    }
    if (l.maxCandidates !== undefined) {
      const n = asNumber(l.maxCandidates, "llm.maxCandidates");
      if (!Number.isInteger(n) || n < 1) {
        throw new TypeError(
          `${CONFIG_FILENAME}: "llm.maxCandidates" must be a positive integer`,
        );
      }
      out.llm.maxCandidates = n;
    }
  }
  return out;
}

function normalizeAliases(
  aliases: Record<string, string[]> | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!aliases) return out;
  for (const [canonical, variants] of Object.entries(aliases)) {
    const key = canonical.trim().toLowerCase();
    if (!key) continue;
    const seen = new Set<string>();
    const norm: string[] = [];
    for (const v of variants) {
      const n = v
        .split(">")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
        .join(" > ");
      if (n && !seen.has(n)) {
        seen.add(n);
        norm.push(n);
      }
    }
    out[key] = norm;
  }
  return out;
}

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit config path. When set, the file is required to exist. */
  configPath?: string;
}

/**
 * Load `.ruleherder.json` from `cwd` (or an explicit path). Returns the
 * fully-resolved effective config — defaults filled in, candidate file list
 * computed, aliases normalized.
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.configPath
    ? path.resolve(cwd, options.configPath)
    : null;
  const candidatePath = explicit ?? path.resolve(cwd, CONFIG_FILENAME);

  let parsed: RuleHerderConfig = {};
  let configPath: string | null = null;
  try {
    const text = await fs.readFile(candidatePath, "utf8");
    parsed = validateConfig(JSON.parse(text));
    configPath = candidatePath;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (explicit || (e.code !== "ENOENT" && e.code !== "EISDIR")) {
      throw err;
    }
    // No config present — use defaults.
  }

  const files = parsed.files
    ? [...parsed.files]
    : [...DEFAULT_AGENT_FILES, ...(parsed.extends ?? [])];
  const ignore = parsed.ignore ?? [];
  const aliases = normalizeAliases(parsed.aliases);
  const thresholds = {
    drift: parsed.thresholds?.drift ?? DEFAULT_CONFIG.thresholds.drift,
    reworded: parsed.thresholds?.reworded ?? DEFAULT_CONFIG.thresholds.reworded,
  };
  const llm = {
    enabled: parsed.llm?.enabled ?? DEFAULT_CONFIG.llm.enabled,
    url: parsed.llm?.url ?? DEFAULT_CONFIG.llm.url,
    model: parsed.llm?.model ?? DEFAULT_CONFIG.llm.model,
    apiKey: parsed.llm?.apiKey ?? DEFAULT_CONFIG.llm.apiKey,
    minConfidence:
      parsed.llm?.minConfidence ?? DEFAULT_CONFIG.llm.minConfidence,
    maxCandidates:
      parsed.llm?.maxCandidates ?? DEFAULT_CONFIG.llm.maxCandidates,
  };

  return { files, ignore, aliases, thresholds, llm, configPath };
}
