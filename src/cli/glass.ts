import { startGlassServer } from "../glass/server.js";
import type { RegisterMode } from "../types.js";

const USAGE = `kernel-keeper glass <bundle-or-estate-root> [options]

Start the local Kernel Keeper Glass review console. The console binds to
loopback (127.0.0.1 by default), serves only the source it was started with,
and calls the same deterministic engine as the CLI.

Options:
  --register <kind>  Treat input as procedure register: estate | skills | agents | commands
  --memory           Bundle mode: opt into wiki-memory checks
  --proposals <dir>  Load drafted proposal files into the browser inbox
  --by <name>        Reviewer recorded in the audit trail (default: KERNEL_KEEPER_REVIEWER,
                     then git user.name, then "reviewer")
  --host <host>      Host to bind (default 127.0.0.1)
  --port <n>         Port to bind (default 8787; use 0 for an ephemeral port)
  -h, --help         Show this help

Exit codes: 0 started · 64 usage · 66 server error.`;

const REGISTER_MODES = new Set(["skills", "agents", "commands", "estate"]);

interface Args {
  root: string;
  register?: RegisterMode;
  memory: boolean;
  host: string;
  port: number;
  proposalsDir?: string;
  by?: string;
}

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(64);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: "", memory: false, host: "127.0.0.1", port: 8787 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--register": {
        const v = argv[++i];
        if (!v || !REGISTER_MODES.has(v)) usageError(`--register must be skills|agents|commands|estate, got: ${v ?? "(nothing)"}`);
        args.register = v as RegisterMode;
        break;
      }
      case "--memory":
        args.memory = true;
        break;
      case "--proposals": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--proposals requires a directory path");
        args.proposalsDir = v;
        break;
      }
      case "--by": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--by requires a name");
        args.by = v;
        break;
      }
      case "--host": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) usageError("--host requires a value");
        args.host = v;
        break;
      }
      case "--port": {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 0 || v > 65535) usageError("--port must be an integer from 0 to 65535");
        args.port = v;
        break;
      }
      default:
        if (a.startsWith("-")) usageError(`Unknown option: ${a}`);
        if (args.root) usageError(`Unexpected positional argument: ${a}`);
        args.root = a;
    }
  }
  if (!args.root) args.root = ".";
  if (args.register && args.memory) usageError("--memory only applies to bundle mode");
  return args;
}

export async function glassMain(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  try {
    const started = await startGlassServer({
      root: args.root,
      ...(args.register ? { register: args.register } : {}),
      memory: args.memory,
      host: args.host,
      port: args.port,
      ...(args.proposalsDir ? { proposalsDir: args.proposalsDir } : {}),
      ...(args.by ? { reviewer: args.by } : {}),
    });
    console.log(`glass: ${started.url}`);
  } catch (err) {
    console.error(`glass: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(66);
  }
}
