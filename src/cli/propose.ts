import { runScribe } from "../ai/scribe.js";
import { UsageError } from "../ai/proposal.js";
import { AiError } from "../ai/client.js";
import type { Severity } from "../types.js";
import { EXIT_API, EXIT_IO, requireApiKey, usageError } from "./common.js";

const USAGE = `kernel-keeper propose <bundle-path> --out-dir DIR [options]

THE SCRIBE - drafts patrol findings into affirm-or-amend proposals a judge
can elect with one tick. Agents propose, never commit: proposals are written
OUTSIDE the bundle, and nothing applies without a human signature.

Options:
  --out-dir <dir>       Where proposal files land (required; must be outside the bundle)
  --model <id>          Model (default claude-sonnet-5)
  --min-severity <s>    Draft findings at/above: high | med | low (default med)
  --policy-days <n>     Patrol staleness window (default 90)
  --journal-days <n>    Patrol journal window (default 30)
  --max-tokens <n>      Generation cap per call (default 8192 scribe / 16384 miner map)
  --dry-run             Print the assembled prompts; zero API calls
  --force               Rewrite proposals whose id already exists
  --allow-in-repo       Permit an out-dir inside the repo root (warns; off by default)
  -h, --help            Show this help

Requires ANTHROPIC_API_KEY (except --dry-run).
Exit codes: 0 ok · 1 some clusters failed · 64 usage · 66 io · 69 api unavailable.`;

const SEV = new Set(["high", "med", "low"]);
const SEV_MAP: Record<string, Severity> = { high: "HIGH", med: "MED", low: "LOW" };

export async function proposeMain(argv: string[]): Promise<void> {
  let bundlePath = "";
  let outDir = "";
  let model = "claude-sonnet-5";
  let minSeverity: Severity = "MED";
  let policyDays = 90;
  let journalDays = 30;
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
      case "--min-severity": {
        const v = argv[++i] ?? "";
        if (!SEV.has(v)) usageError(`--min-severity must be high|med|low, got: ${v}`);
        minSeverity = SEV_MAP[v] as Severity;
        break;
      }
      case "--policy-days":
        policyDays = Number(argv[++i]);
        break;
      case "--journal-days":
        journalDays = Number(argv[++i]);
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
        if (bundlePath) usageError(`Unexpected positional argument: ${a}`);
        bundlePath = a;
    }
  }
  if (!bundlePath) usageError(USAGE);
  if (!outDir) usageError("propose: --out-dir is required (proposals live outside the bundle - agents propose, never commit).");
  if (!Number.isFinite(policyDays) || !Number.isFinite(journalDays)) usageError("--policy-days and --journal-days must be numbers");

  const apiKey = requireApiKey(dryRun);
  try {
    const result = await runScribe(bundlePath, {
      outDir, model, apiKey, minSeverity, dryRun, force, allowInRepo, policyDays, journalDays,
      ...(maxTokens ? { maxTokens } : {}),
    });
    for (const sk of result.skippedExisting) console.error(`propose: skipped (pending proposal exists) ${sk}`);
    for (const f of result.failed) console.error(`propose: FAILED ${f.cluster} - ${f.error}`);
    process.exitCode = result.failed.length > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) usageError(`propose: ${err.message}`);
    if (err instanceof AiError) {
      console.error(`propose: API unavailable after retries - ${err.message}`);
      process.exit(EXIT_API);
    }
    console.error(`propose: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_IO);
  }
}
