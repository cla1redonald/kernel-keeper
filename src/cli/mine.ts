import { runMine } from "../ai/miner.js";
import { UsageError } from "../ai/proposal.js";
import { AiError } from "../ai/client.js";
import { EXIT_API, EXIT_IO, requireApiKey, usageError } from "./common.js";

const USAGE = `kernel-keeper mine <corpus-dir> --bundle <bundle-path> --out-dir DIR [options]

THE GAP-MINER - reads a corpus of working notes (.md/.txt) and proposes the
truths agents keep re-deriving that no register concept covers. Two-phase
map-reduce; proposals land OUTSIDE the bundle; a human elects.

Options:
  --bundle <path>       The register the proposals are for (required)
  --out-dir <dir>       Where proposal files land (required; outside the bundle)
  --model <id>          Model (default claude-sonnet-5)
  --chunk-budget <n>    Max estimated input tokens per map chunk (default 50000)
  --max-calls <n>       Abort before spending if the run would exceed this (default 25)
  --max-tokens <n>      Generation cap per call (default 8192 scribe / 16384 miner map)
  --dry-run             Print the first map prompt + call estimate; zero API calls
  --force               Rewrite proposals whose id already exists
  --allow-in-repo       Permit an out-dir inside the repo root (warns; off by default)
  -h, --help            Show this help

Requires ANTHROPIC_API_KEY (except --dry-run).
Exit codes: 0 ok · 1 some calls failed · 64 usage · 66 io · 69 api unavailable.`;

export async function mineMain(argv: string[]): Promise<void> {
  let corpusDir = "";
  let bundlePath = "";
  let outDir = "";
  let model = "claude-sonnet-5";
  let chunkBudget = 50_000;
  let maxCalls = 25;
  let maxTokens: number | undefined;
  let dryRun = false;
  let force = false;
  let allowInRepo = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--bundle": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--bundle requires a path value");
        bundlePath = v;
        break;
      }
      case "--out-dir": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--out-dir requires a path value");
        outDir = v;
        break;
      }
      case "--model": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--model requires a model id");
        model = v;
        break;
      }
      case "--chunk-budget":
        chunkBudget = Number(argv[++i]);
        break;
      case "--max-calls":
        maxCalls = Number(argv[++i]);
        break;
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
      default:
        if (a.startsWith("-")) usageError(`Unknown option: ${a}\n\n${USAGE}`);
        if (corpusDir) usageError(`Unexpected positional argument: ${a}`);
        corpusDir = a;
    }
  }
  if (!corpusDir) usageError(USAGE);
  if (!bundlePath) usageError("mine: --bundle is required (which register are these proposals for?).");
  if (!outDir) usageError("mine: --out-dir is required (proposals live outside the bundle).");
  if (!Number.isFinite(chunkBudget) || !Number.isFinite(maxCalls)) usageError("--chunk-budget and --max-calls must be numbers");

  const apiKey = requireApiKey(dryRun);
  try {
    const result = await runMine(corpusDir, bundlePath, {
      outDir, model, apiKey, chunkBudget, maxCalls, dryRun, force, allowInRepo,
      ...(maxTokens ? { maxTokens } : {}),
    });
    for (const sk of result.skippedExisting) console.error(`mine: skipped (pending proposal exists) ${sk}`);
    for (const f of result.failed) console.error(`mine: FAILED ${f.cluster} - ${f.error}`);
    process.exitCode = result.failed.length > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) usageError(`mine: ${err.message}`);
    if (err instanceof AiError) {
      console.error(`mine: API unavailable after retries - ${err.message}`);
      process.exit(EXIT_API);
    }
    console.error(`mine: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_IO);
  }
}
