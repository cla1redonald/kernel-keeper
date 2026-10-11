import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { patrol, patrolEstate, exitCode, renderMarkdown, renderEstateMarkdown } from "../index.js";
import type { FrontmatterParser, RegisterMode } from "../types.js";
import { writeOut } from "./common.js";

const USAGE = `kernel-keeper - the automated librarian patrol for knowledge bundles and procedure registers

Usage:
  kernel-keeper <bundle-path> [options]                  patrol an OKF bundle (the truth register)
  kernel-keeper <path> --register <kind> [options]       patrol a procedure register
  kernel-keeper discover-estates <search-root> [options] find likely estate roots in a repo container or vault
  kernel-keeper drift <path> --out-dir DIR [options]     draft semantic-drift proposals from local references
  kernel-keeper apply <path> --proposals DIR [options]   preview elected proposal diffs
  kernel-keeper verify <path> --baseline FILE [options]  compare current surface to a prior baseline
  kernel-keeper glass <path> [options]                   start the local Glass review console

Registers:
  --register skills     <path> is a folder of skill dirs (each holding SKILL.md)
  --register agents     <path> is a folder of agent .md files
  --register commands   <path> is a folder of command .md files
  --register estate     <path> is an estate root (skills/ agents/ commands/ plugins/)

Options:
  --policy-days <n>   Affirm-or-amend window (default 90)
  --journal-days <n>  Max age of the newest log.md entry - bundle mode only (default 30)
  --memory            Bundle mode: opt into wiki-memory policy checks as they ship
  --frontmatter-parser <simple|yaml>
                      Parser policy for frontmatter (default simple; yaml requires optional yaml package)
  --denylist <file>   Register modes: tool names (one per line) whose mention is a HIGH finding
  --out <file>        Write the markdown report to a file (default: stdout)
  --json              Emit JSON instead of markdown
  --fail-on <level>   Exit non-zero on: high | med | any (default med)
  --quiet             Print only the one-line summary
  -h, --help          Show this help

Exit codes: 0 clean (under threshold) · 1 findings at/above threshold · 2 any HIGH finding (regardless of threshold) · 64 bad invocation · 66 load/write error.
Plugins are patrolled as third-party: a skill's SKILL.md-exists check, name-collisions and deprecated-tools only - you rent those.
The keeper never edits content. It reports and proposes; owners decide.`;

const REGISTER_MODES = new Set(["skills", "agents", "commands", "estate"]);

interface Args {
  bundlePath: string;
  register: RegisterMode | null;
  denylistPath: string | null;
  policyDays: number;
  journalDays: number;
  /** True when --journal-days was passed explicitly (it's bundle-mode-only). */
  journalDaysSet: boolean;
  out: string | null;
  json: boolean;
  failOn: "high" | "med" | "any";
  quiet: boolean;
  memory: boolean;
  frontmatterParser: FrontmatterParser;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    bundlePath: "",
    register: null,
    denylistPath: null,
    policyDays: 90,
    journalDays: 30,
    journalDaysSet: false,
    out: null,
    json: false,
    failOn: "med",
    quiet: false,
    memory: false,
    frontmatterParser: "simple",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--policy-days":
        args.policyDays = Number(argv[++i]);
        break;
      case "--journal-days":
        args.journalDays = Number(argv[++i]);
        args.journalDaysSet = true;
        break;
      case "--register": {
        const v = argv[++i];
        if (!v || !REGISTER_MODES.has(v)) {
          console.error(`--register must be skills|agents|commands|estate, got: ${v ?? "(nothing)"}`);
          process.exit(64);
        }
        args.register = v as RegisterMode;
        break;
      }
      case "--denylist": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) {
          console.error("--denylist requires a file path");
          process.exit(64);
        }
        args.denylistPath = v;
        break;
      }
      case "--out": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) {
          console.error("--out requires a file path");
          process.exit(64);
        }
        args.out = v;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--fail-on": {
        const v = argv[++i];
        if (v !== "high" && v !== "med" && v !== "any") {
          console.error(`--fail-on must be high|med|any, got: ${v}`);
          process.exit(64);
        }
        args.failOn = v;
        break;
      }
      case "--quiet":
        args.quiet = true;
        break;
      case "--memory":
        args.memory = true;
        break;
      case "--frontmatter-parser": {
        const v = argv[++i];
        if (v !== "simple" && v !== "yaml") {
          console.error(`--frontmatter-parser must be simple|yaml, got: ${v ?? "(nothing)"}`);
          process.exit(64);
        }
        args.frontmatterParser = v;
        break;
      }
      default:
        if (a.startsWith("-")) {
          console.error(`Unknown option: ${a}\n\n${USAGE}`);
          process.exit(64);
        }
        if (args.bundlePath) {
          console.error(`Unexpected positional argument: ${a}`);
          process.exit(64);
        }
        args.bundlePath = a;
    }
  }
  if (!args.bundlePath) {
    console.error(USAGE);
    process.exit(64);
  }
  if (!Number.isFinite(args.policyDays) || !Number.isFinite(args.journalDays)) {
    console.error("--policy-days and --journal-days must be numbers");
    process.exit(64);
  }
  return args;
}

function readDenylist(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch (err) {
    console.error(`kernel-keeper: cannot read denylist ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(66);
    return []; // unreachable - keeps TS happy
  }
}

export function patrolMain(argv: string[]): void {
  const args = parseArgs(argv);
  let result;
  let summaryScope: string;
  try {
    if (args.register) {
      if (args.journalDaysSet) {
        console.error("--journal-days only applies to bundle mode (there is no journal convention in the procedure registers)");
        process.exit(64);
      }
      if (args.memory) {
        console.error("--memory only applies to bundle mode");
        process.exit(64);
      }
      const denylist = args.denylistPath ? readDenylist(args.denylistPath) : [];
      result = patrolEstate(args.bundlePath, args.register, {
        policyDays: args.policyDays,
        denylist,
        frontmatterParser: args.frontmatterParser,
      });
      summaryScope = `${(result as { stats: { items: number } }).stats.items} items`;
    } else {
      if (args.denylistPath) {
        console.error("--denylist only applies to --register modes");
        process.exit(64);
      }
      result = patrol(args.bundlePath, {
        policyDays: args.policyDays,
        journalDays: args.journalDays,
        memory: args.memory,
        frontmatterParser: args.frontmatterParser,
      });
      summaryScope = `${result.stats.concepts} concepts`;
    }
  } catch (err) {
    console.error(`kernel-keeper: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(66);
    return;
  }
  const { HIGH, MED, LOW } = result.stats.findingsBySeverity;
  const summary = `patrol: ${result.findings.length} findings (${HIGH} high, ${MED} med, ${LOW} low) across ${summaryScope}`;


  if (args.json) {
    const payload = JSON.stringify(result, null, 2);
    if (args.out) {
      writeOut(args.out, payload);
      if (!args.quiet) console.log(`${summary} → ${args.out}`);
    } else if (args.quiet) {
      console.log(summary); // --quiet always means the one-line summary, JSON suppressed
    } else {
      console.log(payload);
    }
  } else {
    const label = basename(resolve(args.bundlePath));
    const md = args.register
      ? renderEstateMarkdown(result as Parameters<typeof renderEstateMarkdown>[0], label, new Date())
      : renderMarkdown(result as Parameters<typeof renderMarkdown>[0], label, new Date());
    if (args.out) {
      writeOut(args.out, md);
      if (!args.quiet) console.log(`${summary} → ${args.out}`);
    } else if (args.quiet) {
      console.log(summary);
    } else {
      console.log(md);
    }
  }
  // exitCode (not exit): process.exit() can truncate a large report mid-flush.
  process.exitCode = exitCode(result, args.failOn);
}
