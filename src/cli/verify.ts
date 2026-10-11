import { compareSnapshots, readVerifySnapshot, runVerifyGenerators, snapshotRoot, writeVerifySnapshot } from "../verify.js";
import type { RegisterMode } from "../types.js";
import { EXIT_IO, usageError } from "./common.js";

const USAGE = `kernel-keeper verify <bundle-or-estate-root> --baseline FILE [options]

Deterministic post-maintenance verifier. Compare the current governed surface
against a prior baseline and report the damage fraction: missing, changed, or
newly unresolvable registered items divided by prior registered items.

Options:
  --baseline <file>          Prior verify baseline JSON to compare against
  --write-baseline <file>    Write the current surface as a baseline and exit
  --register <kind>          Treat input as procedure register: estate | skills | agents | commands
  --generator <command>      Run a deterministic generator before snapshot/compare; repeatable, no shell syntax
  --damage-threshold <n>     Allowed damage fraction, 0..1 (default 0)
  --json                     Print machine-readable result
  -h, --help                 Show this help

Exit codes: 0 ok · 1 damage above threshold · 64 usage · 66 io.`;

const REGISTER_MODES = new Set(["skills", "agents", "commands", "estate"]);

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function verifyMain(argv: string[]): void {
  let inputPath = "";
  let baselinePath = "";
  let writeBaselinePath = "";
  let register: RegisterMode | undefined;
  let threshold = 0;
  let json = false;
  const generators: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--baseline": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--baseline requires a file path");
        baselinePath = v;
        break;
      }
      case "--write-baseline": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--write-baseline requires a file path");
        writeBaselinePath = v;
        break;
      }
      case "--register": {
        const v = argv[++i];
        if (!v || !REGISTER_MODES.has(v)) usageError(`--register must be skills|agents|commands|estate, got: ${v ?? "(nothing)"}`);
        register = v as RegisterMode;
        break;
      }
      case "--damage-threshold":
        threshold = Number(argv[++i]);
        break;
      case "--generator": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--generator requires a command value");
        generators.push(v);
        break;
      }
      case "--json":
        json = true;
        break;
      default:
        if (a.startsWith("-")) usageError(`Unknown option: ${a}\n\n${USAGE}`);
        if (inputPath) usageError(`Unexpected positional argument: ${a}`);
        inputPath = a;
    }
  }
  if (!inputPath) usageError(USAGE);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) usageError("--damage-threshold must be a number from 0 to 1");
  if (baselinePath && writeBaselinePath) usageError("verify: use either --baseline or --write-baseline, not both.");
  if (!baselinePath && !writeBaselinePath) usageError("verify: --baseline or --write-baseline is required.");

  try {
    const opts = { ...(register ? { register } : {}) };
    if (generators.length > 0) runVerifyGenerators(generators, inputPath);
    if (writeBaselinePath) {
      const snapshot = snapshotRoot(inputPath, opts);
      writeVerifySnapshot(writeBaselinePath, snapshot);
      if (json) console.log(JSON.stringify(snapshot, null, 2));
      else console.log(`verify baseline: wrote ${snapshot.items.length} ${snapshot.mode === "bundle" ? "registered files" : "items"} -> ${writeBaselinePath}`);
      return;
    }

    const baseline = readVerifySnapshot(baselinePath);
    const result = compareSnapshots(inputPath, baseline, { ...opts, threshold });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `verify: ${result.ok ? "ok" : "damage"} - ${pct(result.damageFraction)} damaged ` +
          `(${result.damaged.length}/${result.baseline.items.length}) threshold ${pct(result.threshold)}; ` +
          `items ${result.baseline.items.length} -> ${result.current.items.length}`,
      );
      if (result.missing.length > 0) console.log(`missing: ${result.missing.join(", ")}`);
      if (result.changed.length > 0) console.log(`changed: ${result.changed.join(", ")}`);
      if (result.unresolvedEvidence.length > 0) {
        console.log(`unresolved evidence: ${result.unresolvedEvidence.map((x) => `${x.path} -> ${x.ref}`).join(", ")}`);
      }
      if (result.archiveContinuity.length > 0) {
        console.log(`archive continuity: ${result.archiveContinuity.map((x) => `${x.path} -> ${x.reason}`).join(", ")}`);
      }
      if (result.newItems.length > 0) console.log(`new items: ${result.newItems.join(", ")}`);
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(`verify: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_IO);
  }
}
