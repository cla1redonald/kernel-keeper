import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseProposalMarkdown } from "../apply/proposals.js";
import { NotionClient } from "../glass/notion/client.js";
import { NotionServiceUnavailableError, NotionUsageError } from "../glass/notion/errors.js";
import { renderNotionProposals } from "../glass/notion/render.js";
import { publishNotionProposals, syncNotionAudit, syncNotionDecisions } from "../glass/notion/sync.js";
import { proposalToDetail, refusalToGlass } from "../glass/view-models.js";
import type { ParsedProposal } from "../apply/proposals.js";
import type { GlassSource } from "../glass/types.js";
import type { RegisterMode } from "../types.js";

const USAGE = `kernel-keeper notion <command> [options]

Commands:
  sync <root> --proposals DIR [--dry-run | --notion-database DB]
  decisions <root> --proposals DIR --notion-database DB
  audit <root> --proposals DIR --notion-database DB

Options:
  --proposals <dir>       Directory containing Kernel Keeper proposal markdown files
  --dry-run               Print deterministic Notion payload JSON; make no API calls
  --notion-database <id>  Notion database/data source ID for live publish
  --register <mode>       Treat root as a procedure estate: estate, skills, agents, commands
  --memory                Mark bundle source as memory mode
  --now <iso-date>        Deterministic render timestamp for tests/demos
  --help                  Show this help
`;

function usageError(message: string): never {
  console.error(message);
  process.exit(64);
}

function help(): void {
  console.log(USAGE.trimEnd());
}

function parseRegister(value: string): RegisterMode {
  if (value === "estate" || value === "skills" || value === "agents" || value === "commands") return value;
  usageError(`notion: invalid --register: ${value}`);
}

interface SyncArgs {
  root: string;
  proposalsDir: string;
  dryRun: boolean;
  notionDatabase?: string;
  register?: RegisterMode;
  memory: boolean;
  now: Date;
}

interface DecisionsArgs {
  root: string;
  proposalsDir: string;
  notionDatabase: string;
  register?: RegisterMode;
  memory: boolean;
  now: Date;
}

type AuditArgs = DecisionsArgs;

function parseSyncArgs(argv: string[]): SyncArgs {
  let root: string | null = null;
  let proposalsDir: string | null = null;
  let dryRun = false;
  let notionDatabase: string | undefined;
  let register: RegisterMode | undefined;
  let memory = false;
  let now = new Date();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      help();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--memory") {
      memory = true;
      continue;
    }
    if (arg === "--proposals") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) usageError("notion sync: --proposals requires a directory.");
      proposalsDir = next;
      continue;
    }
    if (arg === "--notion-database") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) usageError("notion sync: --notion-database requires a database id.");
      notionDatabase = next;
      continue;
    }
    if (arg === "--register") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) usageError("notion sync: --register requires a mode.");
      register = parseRegister(next);
      continue;
    }
    if (arg === "--now") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) usageError("notion sync: --now requires an ISO date.");
      const parsed = new Date(next);
      if (Number.isNaN(parsed.getTime())) usageError(`notion sync: invalid --now: ${next}`);
      now = parsed;
      continue;
    }
    if (arg.startsWith("--")) usageError(`notion sync: unknown option: ${arg}`);
    if (root) usageError(`notion sync: unexpected extra argument: ${arg}`);
    root = arg;
  }

  if (!root) usageError("notion sync: root is required.");
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) usageError(`notion sync: no such root: ${absRoot}`);
  if (!proposalsDir) usageError("notion sync: --proposals is required.");
  const absProposals = resolve(proposalsDir);
  if (!existsSync(absProposals)) usageError(`notion sync: no such proposals dir: ${absProposals}`);
  if (!dryRun && !notionDatabase) usageError("notion sync: --notion-database is required unless --dry-run is set.");
  if (dryRun && notionDatabase) usageError("notion sync: use either --dry-run or --notion-database, not both.");

  return { root: absRoot, proposalsDir: absProposals, dryRun, ...(notionDatabase ? { notionDatabase } : {}), ...(register ? { register } : {}), memory, now };
}

function parseLiveArgs(argv: string[], label: "decisions" | "audit"): DecisionsArgs {
  let root: string | null = null;
  let proposalsDir: string | null = null;
  let notionDatabase: string | undefined;
  let register: RegisterMode | undefined;
  let memory = false;
  let now = new Date();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      help();
      process.exit(0);
    }
    if (arg === "--memory") {
      memory = true;
      continue;
    }
    if (arg === "--proposals") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) usageError(`notion ${label}: --proposals requires a directory.`);
      proposalsDir = next;
      continue;
    }
    if (arg === "--notion-database") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) usageError(`notion ${label}: --notion-database requires a database id.`);
      notionDatabase = next;
      continue;
    }
    if (arg === "--register") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) usageError(`notion ${label}: --register requires a mode.`);
      register = parseRegister(next);
      continue;
    }
    if (arg === "--now") {
      const next = argv[++i];
      if (!next || next.startsWith("--")) usageError(`notion ${label}: --now requires an ISO date.`);
      const parsed = new Date(next);
      if (Number.isNaN(parsed.getTime())) usageError(`notion ${label}: invalid --now: ${next}`);
      now = parsed;
      continue;
    }
    if (arg.startsWith("--")) usageError(`notion ${label}: unknown option: ${arg}`);
    if (root) usageError(`notion ${label}: unexpected extra argument: ${arg}`);
    root = arg;
  }

  if (!root) usageError(`notion ${label}: root is required.`);
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) usageError(`notion ${label}: no such root: ${absRoot}`);
  if (!proposalsDir) usageError(`notion ${label}: --proposals is required.`);
  const absProposals = resolve(proposalsDir);
  if (!existsSync(absProposals)) usageError(`notion ${label}: no such proposals dir: ${absProposals}`);
  if (!notionDatabase) usageError(`notion ${label}: --notion-database is required.`);

  return { root: absRoot, proposalsDir: absProposals, notionDatabase, ...(register ? { register } : {}), memory, now };
}

function parseDecisionsArgs(argv: string[]): DecisionsArgs {
  return parseLiveArgs(argv, "decisions");
}

function parseAuditArgs(argv: string[]): AuditArgs {
  return parseLiveArgs(argv, "audit");
}

function loadProposalInputs(dir: string): { proposals: ParsedProposal[]; refused: { proposal: string; reason: string }[] } {
  const proposals: ParsedProposal[] = [];
  const refused: { proposal: string; reason: string }[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const path = join(dir, f);
    try {
      proposals.push(parseProposalMarkdown(readFileSync(path, "utf8"), path));
    } catch (err) {
      refused.push({ proposal: f.replace(/\.md$/, ""), reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { proposals, refused };
}

function sourceFor(args: SyncArgs | DecisionsArgs): GlassSource {
  return {
    root: args.root,
    kind: args.register ? "estate" : "bundle",
    ...(args.register ? { register: args.register } : {}),
    ...(args.memory ? { memory: true } : {}),
  };
}

function syncDryRun(args: SyncArgs): void {
  const loaded = loadProposalInputs(args.proposalsDir);
  const source = sourceFor(args);
  const proposals = loaded.proposals.map(proposalToDetail);
  const renderedAt = args.now.toISOString();
  const out = {
    source,
    dryRun: true,
    renderedAt,
    proposals: renderNotionProposals(source, proposals, args.now),
    refused: loaded.refused.map(refusalToGlass),
  };
  console.log(JSON.stringify(out, null, 2));
}

async function syncLive(args: SyncArgs): Promise<void> {
  if (!args.notionDatabase) usageError("notion sync: --notion-database is required unless --dry-run is set.");
  const token = process.env.NOTION_TOKEN ?? "";
  if (!token.trim()) usageError("notion sync: NOTION_TOKEN is required for live Notion sync.");
  const result = await publishNotionProposals({
    root: args.root,
    proposalsDir: args.proposalsDir,
    source: sourceFor(args),
    databaseId: args.notionDatabase,
    client: new NotionClient({ token }),
    now: args.now,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function decisionsLive(args: DecisionsArgs): Promise<void> {
  const token = process.env.NOTION_TOKEN ?? "";
  if (!token.trim()) usageError("notion decisions: NOTION_TOKEN is required for live Notion sync.");
  const result = await syncNotionDecisions({
    root: args.root,
    proposalsDir: args.proposalsDir,
    source: sourceFor(args),
    databaseId: args.notionDatabase,
    client: new NotionClient({ token }),
    now: args.now,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function auditLive(args: AuditArgs): Promise<void> {
  const token = process.env.NOTION_TOKEN ?? "";
  if (!token.trim()) usageError("notion audit: NOTION_TOKEN is required for live Notion sync.");
  const result = await syncNotionAudit({
    root: args.root,
    proposalsDir: args.proposalsDir,
    source: sourceFor(args),
    databaseId: args.notionDatabase,
    client: new NotionClient({ token }),
    now: args.now,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function notionMain(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    help();
    return;
  }
  try {
    if (command === "sync") {
      const args = parseSyncArgs(rest);
      if (args.dryRun) syncDryRun(args);
      else await syncLive(args);
      return;
    }
    if (command === "decisions") {
      await decisionsLive(parseDecisionsArgs(rest));
      return;
    }
    if (command === "audit") {
      await auditLive(parseAuditArgs(rest));
      return;
    }
    usageError(`notion: unknown command: ${command}`);
  } catch (err) {
    if (err instanceof NotionUsageError) usageError(`notion ${command}: ${err.message}`);
    if (err instanceof NotionServiceUnavailableError) {
      console.error(`notion ${command}: ${err.message}`);
      process.exit(69);
    }
    throw err;
  }
}
