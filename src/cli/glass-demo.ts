import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startGlassServer } from "../glass/server.js";

const USAGE = `kernel-keeper glass-demo [options]

Start a seeded local Glass demo using the Northwind memory lab fixture.
The fixture is copied to a temporary directory before Glass starts.

Options:
  --host <host>  Host to bind (default 127.0.0.1)
  --port <n>     Port to bind (default 8787; use 0 for an ephemeral port)
  -h, --help     Show this help

Exit codes: 0 started · 64 usage · 66 server error.`;

interface Args {
  host: string;
  port: number;
}

export interface GlassDemoFixture {
  demoRoot: string;
  commandsRoot: string;
  proposalsDir: string;
}

function usageError(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(64);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { host: "127.0.0.1", port: 8787 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
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
        usageError(`Unknown option: ${a}`);
    }
  }
  return args;
}

export function prepareGlassDemo(cwd = process.cwd()): GlassDemoFixture {
  const checkoutFixture = resolve(cwd, "tests", "fixtures", "northwind-memory-lab");
  const packageFixture = fileURLToPath(new URL("../../tests/fixtures/northwind-memory-lab", import.meta.url));
  const source = existsSync(checkoutFixture) ? checkoutFixture : packageFixture;
  if (!existsSync(source)) throw new Error(`Northwind demo fixture not found: ${source}`);
  const demoRoot = mkdtempSync(join(tmpdir(), "kernel-keeper-glass-demo-"));
  cpSync(source, demoRoot, { recursive: true });
  return {
    demoRoot,
    commandsRoot: join(demoRoot, "estate", "commands"),
    proposalsDir: join(demoRoot, "proposals"),
  };
}

export async function glassDemoMain(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  try {
    const fixture = prepareGlassDemo();
    const started = await startGlassServer({
      root: fixture.commandsRoot,
      register: "commands",
      proposalsDir: fixture.proposalsDir,
      host: args.host,
      port: args.port,
    });
    console.log(`glass-demo: ${started.url}`);
    console.log(`glass-demo root: ${fixture.demoRoot}`);
    console.log("glass-demo story: Proposals -> approve P-northwind-promote-command -> Apply -> audit -> generated command");
  } catch (err) {
    console.error(`glass-demo: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(66);
  }
}
