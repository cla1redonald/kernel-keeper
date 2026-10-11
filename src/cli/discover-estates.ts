import { discoverEstateRoots } from "../core/estate.js";
import { writeOut, usageError } from "./common.js";

const USAGE = `kernel-keeper discover-estates <search-root> [options]

Find likely procedure estate roots below a repo container or vault.

Options:
  --max-depth <n>   Directory depth below the search root to inspect (default 3)
  --json            Emit JSON instead of newline-delimited paths
  --out <file>      Write output to a file
  -h, --help        Show this help`;

interface Args {
  searchRoot: string;
  maxDepth: number;
  json: boolean;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { searchRoot: "", maxDepth: 3, json: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--max-depth": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--max-depth requires a number");
        args.maxDepth = Number(v);
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--out": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--out requires a file path");
        args.out = v;
        break;
      }
      default:
        if (a.startsWith("-")) usageError(`Unknown option: ${a}\n\n${USAGE}`);
        if (args.searchRoot) usageError(`Unexpected positional argument: ${a}`);
        args.searchRoot = a;
    }
  }
  if (!args.searchRoot) usageError(USAGE);
  if (!Number.isInteger(args.maxDepth) || args.maxDepth < 0) usageError("--max-depth must be a non-negative integer");
  return args;
}

export function discoverEstatesMain(argv: string[]): void {
  const args = parseArgs(argv);
  try {
    const roots = discoverEstateRoots(args.searchRoot, { maxDepth: args.maxDepth });
    const output = args.json ? JSON.stringify({ roots }, null, 2) : roots.join("\n");
    if (args.out) writeOut(args.out, output);
    else console.log(output);
  } catch (err) {
    console.error(`kernel-keeper: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(66);
  }
}
