import { runDriftReview } from "../ai/drift.js";
import { AiError } from "../ai/client.js";
import { UsageError } from "../ai/proposal.js";
import type { RegisterMode } from "../types.js";
import { EXIT_API, EXIT_IO, requireApiKey, usageError } from "./common.js";

const USAGE = `kernel-keeper drift <bundle-or-estate-root> --out-dir DIR [options]

THE DRIFT REVIEWER - compares registered items with their resolved outbound
local references and drafts semantic-drift proposals. Agents propose, never
commit: proposals are written OUTSIDE the register and require human election.

Options:
  --out-dir <dir>       Where proposal files land (required; must be outside the register)
  --register <kind>     Treat input as procedure register: estate | skills | agents | commands
  --memory              Bundle mode: prefer wiki-memory source receipts as they ship
  --fetch-sources       Memory bundle mode: fetch declared HTTP(S) source: frontmatter into a local cache
  --fetch-cache <dir>   Cache directory for fetched sources (default .kernel-keeper/drift-cache)
  --fetch-cache-max-age-hours <n>
                        Reuse fetched-source cache entries at most this old; absent means always fetch
  --max-fetch-bytes <n> Maximum bytes per fetched source (default 200000)
  --model <id>          Model (default claude-sonnet-5)
  --max-tokens <n>      Generation cap per call (default 8192)
  --dry-run             Print the assembled prompts; zero API calls
  --force               Rewrite proposals whose id already exists
  --allow-in-repo       Permit an out-dir inside the repo/root (warns; off by default)
  -h, --help            Show this help

Requires ANTHROPIC_API_KEY (except --dry-run).
Exit codes: 0 ok · 1 some jobs failed · 64 usage · 66 io · 69 api unavailable.`;

const REGISTER_MODES = new Set(["skills", "agents", "commands", "estate"]);

export async function driftMain(argv: string[]): Promise<void> {
  let inputPath = "";
  let outDir = "";
  let register: RegisterMode | undefined;
  let model = "claude-sonnet-5";
  let maxTokens: number | undefined;
  let dryRun = false;
  let force = false;
  let allowInRepo = false;
  let memory = false;
  let fetchSources = false;
  let fetchCacheDir: string | undefined;
  let fetchCacheMaxAgeHours: number | undefined;
  let maxFetchBytes: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--out-dir": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--out-dir requires a path value");
        outDir = v;
        break;
      }
      case "--register": {
        const v = argv[++i];
        if (!v || !REGISTER_MODES.has(v)) usageError(`--register must be skills|agents|commands|estate, got: ${v ?? "(nothing)"}`);
        register = v as RegisterMode;
        break;
      }
      case "--model": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--model requires a model id");
        model = v;
        break;
      }
      case "--max-tokens":
        maxTokens = Number(argv[++i]);
        if (!Number.isFinite(maxTokens) || maxTokens <= 0) usageError("--max-tokens must be a positive number");
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--force":
        force = true;
        break;
      case "--allow-in-repo":
        allowInRepo = true;
        break;
      case "--memory":
        memory = true;
        break;
      case "--fetch-sources":
        fetchSources = true;
        break;
      case "--fetch-cache": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--fetch-cache requires a path value");
        fetchCacheDir = v;
        break;
      }
      case "--max-fetch-bytes":
        maxFetchBytes = Number(argv[++i]);
        if (!Number.isFinite(maxFetchBytes) || maxFetchBytes <= 0) usageError("--max-fetch-bytes must be a positive number");
        break;
      case "--fetch-cache-max-age-hours":
        fetchCacheMaxAgeHours = Number(argv[++i]);
        if (!Number.isFinite(fetchCacheMaxAgeHours) || fetchCacheMaxAgeHours < 0) usageError("--fetch-cache-max-age-hours must be a non-negative number");
        break;
      default:
        if (a.startsWith("-")) usageError(`Unknown option: ${a}\n\n${USAGE}`);
        if (inputPath) usageError(`Unexpected positional argument: ${a}`);
        inputPath = a;
    }
  }
  if (!inputPath) usageError(USAGE);
  if (!outDir) usageError("drift: --out-dir is required (proposals live outside the register - agents propose, never commit).");
  if (register && memory) usageError("drift: --memory only applies to bundle mode");
  if (fetchSources && register) usageError("drift: --fetch-sources only applies to bundle mode");
  if (fetchSources && !memory) usageError("drift: --fetch-sources requires --memory");

  const apiKey = requireApiKey(dryRun);
  try {
    const result = await runDriftReview(inputPath, {
      outDir, model, apiKey, dryRun, force, allowInRepo, memory, fetchSources,
      ...(register ? { register } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(fetchCacheDir ? { fetchCacheDir } : {}),
      ...(fetchCacheMaxAgeHours !== undefined ? { fetchCacheMaxAgeHours } : {}),
      ...(maxFetchBytes ? { maxFetchBytes } : {}),
    });
    for (const sk of result.skippedExisting) console.error(`drift: skipped (pending proposal exists) ${sk}`);
    for (const f of result.failed) console.error(`drift: FAILED ${f.cluster} - ${f.error}`);
    process.exitCode = result.failed.length > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) usageError(`drift: ${err.message}`);
    if (err instanceof AiError) {
      console.error(`drift: API unavailable after retries - ${err.message}`);
      process.exit(EXIT_API);
    }
    console.error(`drift: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_IO);
  }
}
