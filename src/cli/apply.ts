import { planApply, writeApply } from "../apply/proposals.js";
import type { RegisterMode } from "../types.js";
import { EXIT_IO, usageError } from "./common.js";

const USAGE = `kernel-keeper apply <bundle-or-estate-root> --proposals DIR [options]

Deterministic clerk for elected proposal files. Dry-run is the default:
it parses elected proposals, verifies eligibility, and prints diffs. Pass
--write to apply eligible deterministic changes, including elected new
procedure files in authored estate registers.

Options:
  --proposals <dir>     Directory of proposal markdown files (required)
  --register <kind>     Treat input as procedure register: estate | skills | agents | commands
  --proposal <id>       Preview one proposal id
  --check <name>        Preview proposals for one check label
  --dry-run             Print planned diffs; default
  --write               Apply eligible deterministic changes
  --no-audit-log        Estate write-mode: do not append .kernel-keeper/audit/<mode>-log.md
  --json                Print machine-readable plan summary
  -h, --help            Show this help

Exit codes: 0 ok · 1 refused proposals · 64 usage · 66 io.`;

const REGISTER_MODES = new Set(["skills", "agents", "commands", "estate"]);

export function applyMain(argv: string[]): void {
  let inputPath = "";
  let proposalsDir = "";
  let register: RegisterMode | undefined;
  let proposalId: string | undefined;
  let check: string | undefined;
  let json = false;
  let write = false;
  let noAuditLog = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--proposals": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--proposals requires a path value");
        proposalsDir = v;
        break;
      }
      case "--register": {
        const v = argv[++i];
        if (!v || !REGISTER_MODES.has(v)) usageError(`--register must be skills|agents|commands|estate, got: ${v ?? "(nothing)"}`);
        register = v as RegisterMode;
        break;
      }
      case "--proposal": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--proposal requires an id");
        proposalId = v;
        break;
      }
      case "--check": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--check requires a check name");
        check = v;
        break;
      }
      case "--dry-run":
        break;
      case "--write":
        write = true;
        break;
      case "--no-audit-log":
        noAuditLog = true;
        break;
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
  if (!proposalsDir) usageError("apply: --proposals is required.");

  try {
    const opts = {
      proposalsDir,
      ...(register ? { register } : {}),
      ...(proposalId ? { proposalId } : {}),
      ...(check ? { check } : {}),
      ...(noAuditLog ? { noAuditLog } : {}),
    };
    const result = write ? writeApply(inputPath, opts) : { plan: planApply(inputPath, opts), written: [] };
    const plan = result.plan;
    if (json) {
      console.log(JSON.stringify({
        mode: write ? "write" : "dry-run",
        planned: plan.planned.map((p) => ({ id: p.proposal.id, target: p.proposal.target, files: p.changes.map((c) => c.file) })),
        written: result.written,
        skipped: plan.skipped,
        refused: plan.refused,
      }, null, 2));
    } else {
      if (write) {
        if (plan.refused.length === 0) {
          for (const p of plan.planned) {
            console.log(`apply --write: ${p.proposal.id} -> ${p.changes.map((c) => c.file).join(", ")}`);
          }
        }
      } else {
        for (const p of plan.planned) {
          console.log(`apply --dry-run: ${p.proposal.id} -> ${p.proposal.target}`);
          for (const c of p.changes) process.stdout.write(c.diff);
        }
      }
      for (const s of plan.skipped) console.error(`apply: skipped ${s.proposal} - ${s.reason}`);
      for (const r of plan.refused) console.error(`apply: refused ${r.proposal} - ${r.reason}`);
    }
    process.exitCode = plan.refused.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(`apply: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_IO);
  }
}
