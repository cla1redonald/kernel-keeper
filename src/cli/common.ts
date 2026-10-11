import { writeFileSync } from "node:fs";

/** sysexits-style codes shared by every verb. */
export const EXIT_USAGE = 64; // bad invocation
export const EXIT_IO = 66; // load/write failure
export const EXIT_API = 69; // EX_UNAVAILABLE - API failed after retries

export function writeOut(path: string, data: string): void {
  try {
    writeFileSync(path, data);
  } catch (err) {
    console.error(`kernel-keeper: cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_IO);
  }
}

export function usageError(msg: string): never {
  console.error(msg);
  process.exit(EXIT_USAGE);
}

/** Require ANTHROPIC_API_KEY unless --dry-run. Never logged, never echoed. */
export function requireApiKey(dryRun: boolean): string {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key && !dryRun) {
    usageError("kernel-keeper: ANTHROPIC_API_KEY is not set (required for AI verbs; use --dry-run to preview prompts without it).");
  }
  return key ?? "";
}
