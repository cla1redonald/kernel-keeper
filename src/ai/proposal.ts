import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { parseFrontmatter } from "../core/bundle.js";
import { sha256Hex } from "./provenance.js";
import type { ProposalDraft, Provenance } from "./types.js";

/**
 * THE WRITE CHOKEPOINT. This is the only module under src/ai/ permitted to
 * import fs write APIs (a source-grep test enforces it). Every AI-drafted
 * byte that reaches disk passes through this module: writeProposal() refuses
 * to write proposals inside the bundle, and fetched source caches are written
 * as local evidence files under an explicit cache dir.
 */

export class UsageError extends Error {}

/** Resolve to a real path even when the leaf doesn't exist yet (resolve parents). */
function realish(p: string): string {
  const abs = resolve(p);
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    tail.unshift(probe.split("/").pop() as string);
    const parent = dirname(probe);
    if (parent === probe) return abs;
    probe = parent;
  }
  return join(realpathSync(probe), ...tail);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Out-dir rules: inside the BUNDLE root is a hard error (proposals would
 * become register content); inside the REPO root is a loud warning unless
 * explicitly allowed - proposal files enter loadBundle's repoFiles set,
 * which is a latent baseline-shift vector.
 */
export function assertOutDirSafe(
  outDir: string,
  bundleRoot: string,
  repoRoot: string,
  allowInRepo: boolean,
  warn: (msg: string) => void = (m) => console.error(m),
): void {
  const out = realish(outDir);
  const bundle = realish(bundleRoot);
  const repo = realish(repoRoot);
  if (isInside(out, bundle)) {
    throw new UsageError(
      `--out-dir resolves inside the bundle (${out}) - agents propose, never commit; proposals cannot live in the register.`,
    );
  }
  if (isInside(out, repo)) {
    if (!allowInRepo) {
      throw new UsageError(
        `--out-dir resolves inside the repo root (${out}). Proposal files would enter link-resolution scope on future patrols. Pass --allow-in-repo if this is intentional.`,
      );
    }
    warn(`kernel-keeper: warning - writing proposals inside the repo root (${out}); they will be visible to link resolution.`);
  }
}

export function writeFetchedSourceCache(args: {
  repoRoot: string;
  bundleRoot: string;
  cacheDir: string;
  url: string;
  content: string;
  status: number;
  contentType: string;
  fetchedAt: Date;
}): { path: string } {
  const absDir = isAbsolute(args.cacheDir) ? resolve(args.cacheDir) : resolve(args.repoRoot, args.cacheDir);
  if (!isInside(absDir, resolve(args.repoRoot))) throw new UsageError("--fetch-cache must resolve inside the repo root");
  if (isInside(absDir, resolve(args.bundleRoot))) throw new UsageError("--fetch-cache must not resolve inside the bundle");
  const id = sha256Hex(args.url).slice(0, 24);
  const abs = join(absDir, `${id}.txt`);
  const rel = relative(args.repoRoot, abs).split(/[\\/]/).join("/");
  mkdirSync(absDir, { recursive: true });
  writeFileSync(abs, args.content);
  writeFileSync(join(absDir, `${id}.json`), `${JSON.stringify({
    url: args.url,
    status: args.status,
    contentType: args.contentType,
    fetchedAt: args.fetchedAt.toISOString(),
    sha256: sha256Hex(args.content),
    bytes: Buffer.byteLength(args.content, "utf8"),
  }, null, 2)}\n`);
  return { path: rel };
}

export function readFetchedSourceCache(args: {
  repoRoot: string;
  bundleRoot: string;
  cacheDir: string;
  url: string;
  now: Date;
  maxAgeHours: number;
}): { path: string; content: string; fetchedAt: Date } | null {
  const absDir = isAbsolute(args.cacheDir) ? resolve(args.cacheDir) : resolve(args.repoRoot, args.cacheDir);
  if (!isInside(absDir, resolve(args.repoRoot))) throw new UsageError("--fetch-cache must resolve inside the repo root");
  if (isInside(absDir, resolve(args.bundleRoot))) throw new UsageError("--fetch-cache must not resolve inside the bundle");
  const id = sha256Hex(args.url).slice(0, 24);
  const abs = join(absDir, `${id}.txt`);
  const metaAbs = join(absDir, `${id}.json`);
  if (!existsSync(abs) || !existsSync(metaAbs)) return null;
  const meta = JSON.parse(readFileSync(metaAbs, "utf8")) as {
    url?: string;
    fetchedAt?: string;
    sha256?: string;
  };
  if (meta.url !== args.url || !meta.fetchedAt || !meta.sha256) return null;
  const fetchedAt = new Date(meta.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime())) return null;
  const ageMs = args.now.getTime() - fetchedAt.getTime();
  if (ageMs < 0 || ageMs > args.maxAgeHours * 60 * 60 * 1000) return null;
  const content = readFileSync(abs, "utf8");
  if (sha256Hex(content) !== meta.sha256) throw new Error(`cached fetched source checksum mismatch: ${args.url}`);
  const rel = relative(args.repoRoot, abs).split(/[\\/]/).join("/");
  return { path: rel, content, fetchedAt };
}

/** A model-authored draft failed a code-level check. The reason is logged against the cluster. */
export class ProposalRejectedError extends Error {}

/** Characters that break line-oriented parsing or hide text: C0 controls (including newline and tab), DEL, NEL, LS, PS. */
const LINE_BREAKING_RE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
const LINE_BREAKING_GLOBAL_RE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;

/**
 * Serialise one frontmatter scalar. Plain when it is unambiguous, otherwise a
 * double-quoted YAML string with JSON escapes, so a newline can never start a new
 * key. Values beginning with `---` are refused outright (they read as a fence).
 */
export function yamlScalar(value: string, label = "frontmatter value"): string {
  if (value.startsWith("---")) throw new ProposalRejectedError(`${label} must not begin with "---"`);
  const plain = value !== "" && /^[A-Za-z0-9_./(~][^\s#"'\\]*(?: [^\s#"'\\]+)*$/.test(value) && !/: |:$/.test(value) && !LINE_BREAKING_RE.test(value);
  if (plain) return value;
  return JSON.stringify(value).replace(LINE_BREAKING_GLOBAL_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** One item of a flow list (`[a, b]`). The reader cannot represent quoting in lists, so unrepresentable items are refused. */
export function yamlListItem(value: string, label = "list item"): string {
  if (value === "" || value !== value.trim() || /[,\[\]"'#]/.test(value) || LINE_BREAKING_RE.test(value) || value.startsWith("---")) {
    throw new ProposalRejectedError(`${label} cannot be written safely into proposal frontmatter: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Render the proposal markdown DETERMINISTICALLY - the model never authors this file. */
export function renderProposalMarkdown(draft: ProposalDraft, prov: Provenance): string {
  const defaultCheck = draft.kind === "new-concept" ? "gap" : draft.kind === "new-procedure" ? "procedure-gap" : "amend";
  const checks = [...new Set(draft.checks ?? [defaultCheck])];
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: Proposal");
  lines.push(`id: ${yamlScalar(draft.id, "id")}`);
  lines.push(`proposer: ${yamlScalar(prov.agent, "proposer")}`);
  lines.push(`model: ${yamlScalar(prov.model, "model")}`);
  lines.push(`prompt-sha256: ${yamlScalar(prov.promptSha256, "prompt-sha256")}`);
  if (prov.reviewedSurfaceSha256) lines.push(`reviewed-surface-sha256: ${yamlScalar(prov.reviewedSurfaceSha256, "reviewed-surface-sha256")}`);
  if (prov.reviewedSurfaceFiles && prov.reviewedSurfaceFiles.length > 0) {
    lines.push(`reviewed-surface: [${prov.reviewedSurfaceFiles.map((f) => yamlListItem(`${f.path}:${f.sha256}`, "reviewed-surface entry")).join(", ")}]`);
  }
  lines.push(`target: ${yamlScalar(draft.target ?? "(new concept)", "target")}`);
  lines.push(`kind: ${draft.kind}`);
  lines.push(`checks: [${checks.map((c) => yamlListItem(c, "check")).join(", ")}]`);
  lines.push(`confidence: ${yamlScalar(draft.confidence, "confidence")}`);
  lines.push(`needs-human: ${draft.needsHuman === true ? "true" : "false"}`);
  lines.push(`evidence: [${prov.evidenceFiles.map((f) => yamlListItem(f, "evidence file")).join(", ")}]`);
  lines.push(`generated-at: ${yamlScalar(prov.generatedAt, "generated-at")}`);
  lines.push(`usage-tokens: ${prov.usage.inputTokens}+${prov.usage.outputTokens}`);
  lines.push("status: pending");
  lines.push("elected: false");
  lines.push("---");
  lines.push(`${PROPOSAL_HEADING_PREFIX}${draft.id} - ${draft.summary.replace(/\s+/g, " ").trim()}`);
  lines.push("");
  const agentName = prov.agent === "scribe" ? "Scribe" : prov.agent === "gap-miner" ? "Gap-Miner" : "Drift Reviewer";
  lines.push(`> Drafted by **the ${agentName}** - a human elects; nothing below applies itself. The Draft blocks are **immutable**: record any changes under Amendment, never by editing the draft.`);
  lines.push("");
  lines.push("## Rationale");
  lines.push(draft.rationale);
  lines.push("");
  if (draft.evidenceQuotes.length > 0) {
    lines.push("## Evidence");
    for (const e of draft.evidenceQuotes) lines.push(`- \`${e.file}\`: "${e.quote}"`);
    lines.push("");
  }
  lines.push("## Draft (immutable)");
  if (draft.frontmatterPatch && Object.keys(draft.frontmatterPatch).length > 0) {
    lines.push("### Frontmatter patch");
    lines.push("```yaml");
    for (const k of Object.keys(draft.frontmatterPatch).sort()) {
      lines.push(`${k}: ${draft.frontmatterPatch[k]}`);
    }
    lines.push("```");
  }
  if (draft.bodyDraft) {
    lines.push(draft.kind === "new-concept" ? `### New concept: ${draft.target ?? ""}` : draft.kind === "new-procedure" ? `### New procedure: ${draft.target ?? ""}` : "### Body draft");
    lines.push("```markdown");
    lines.push(draft.bodyDraft);
    lines.push("```");
  }
  if (draft.indexEntry) {
    lines.push("### index.md entry");
    lines.push("```markdown");
    lines.push(draft.indexEntry);
    lines.push("```");
  }
  lines.push("### Journal line (paste into log.md on election)");
  lines.push("```markdown");
  lines.push(draft.journalLine);
  lines.push("```");
  lines.push("");
  lines.push("## Decision");
  lines.push("- [ ] Elect - apply as drafted");
  lines.push("- [ ] Amend - record changes under Amendment, then elect");
  lines.push("- [ ] Reject");
  lines.push("");
  lines.push("Judge: ______   Date: ______");
  lines.push("");
  lines.push("## Amendment");
  lines.push("");
  return lines.join("\n");
}

/** Heading format shared by the renderer and the pending-proposal parser - one constant so they cannot desync. */
export const PROPOSAL_HEADING_PREFIX = "# Proposal ";
const PROPOSAL_HEADING_RE = new RegExp(`^${PROPOSAL_HEADING_PREFIX}(\\S+) - (.+)$`, "m");

/** Pending proposals already in out-dir - agents must treat these as "already covered". */
export function listPendingProposals(
  outDir: string,
  proposer?: string,
): { id: string; target: string; summary: string }[] {
  const dir = resolve(outDir);
  if (!existsSync(dir)) return [];
  const out: { id: string; target: string; summary: string }[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    let content: string;
    try {
      content = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    if (fm?.["type"] !== "Proposal" || fm?.["status"] !== "pending") continue;
    if (proposer && fm?.["proposer"] !== proposer) continue;
    const heading = content.match(PROPOSAL_HEADING_RE);
    out.push({
      id: typeof fm["id"] === "string" ? fm["id"] : f.replace(/\.md$/, ""),
      target: typeof fm["target"] === "string" ? fm["target"] : "",
      summary: heading?.[2] ?? "",
    });
  }
  return out;
}

/** Canonical on-disk path for a proposal id - the one shape every result list uses. */
export function proposalPath(outDir: string, id: string): string {
  return join(resolve(outDir), `${id}.md`);
}

/** Does a pending proposal with this id already exist in out-dir? (Spend-idempotency pre-check.) */
export function proposalExists(outDir: string, id: string): boolean {
  return existsSync(proposalPath(outDir, id));
}

/** Where a proposal's target must land, and which agent is drafting it. */
export interface TargetScope {
  repoRoot: string;
  /** The bundle root (or estate root) the proposal may amend or create files in. */
  surfaceRoot: string;
  agent: Provenance["agent"];
}

const PROPOSAL_ID_RE = /^P-[0-9a-f]{12}$/;
/**
 * What each agent may ask for. The kind is part of the authorisation a proposal
 * carries, so it is decided here by who is drafting, never by the model alone.
 * No agent may draft `new-procedure`: creating agent behaviour is a human act.
 */
const ALLOWED_KINDS: Record<Provenance["agent"], readonly ProposalDraft["kind"][]> = {
  scribe: ["amend", "new-concept"],
  "drift-reviewer": ["amend"],
  "gap-miner": ["new-concept"],
};

function confineTarget(target: string, scope: TargetScope): void {
  if (LINE_BREAKING_RE.test(target) || target.includes("\\") || isAbsolute(target) || /^[A-Za-z]:/.test(target) || target.startsWith("---")) {
    throw new ProposalRejectedError(`target is not a plain relative path: ${JSON.stringify(target)}`);
  }
  const clean = posix.normalize(target);
  if (clean === "." || clean === ".." || clean.startsWith("../")) {
    throw new ProposalRejectedError(`target escapes the bundle or estate root: ${target}`);
  }
  // Targets are repo-relative (scribe, drift) or surface-relative (gap-miner). Either reading
  // may land inside the surface; after resolving symlinks, at least one must.
  const surface = realish(scope.surfaceRoot);
  const inside = [scope.repoRoot, scope.surfaceRoot].some((base) => isInside(realish(resolve(base, clean)), surface));
  if (!inside) throw new ProposalRejectedError(`target resolves outside the bundle or estate root: ${target}`);
}

// Markup the proposal parsers read. A model string containing any of these could end up
// being read as a decision, a draft block or a fence rather than as prose.
const RESERVED_HEADING_RE = /###\s*(?:frontmatter patch|body draft|new concept|new procedure|index\.md entry|journal line)/i;
const DECISION_LINE_RE = /^\s*(?:[-*+]\s*)?\[[ xX]\]\s*(?:elect|amend|reject)/im;
const FENCE_LINE_RE = /^\s*(?:`{3,}|~{3,})/m;

function assertNoReservedMarkup(text: string, label: string): void {
  if (RESERVED_HEADING_RE.test(text)) throw new ProposalRejectedError(`${label} contains a reserved proposal heading`);
  if (DECISION_LINE_RE.test(text)) throw new ProposalRejectedError(`${label} contains a decision checkbox line`);
}

/** Text that must stay on one line (summary, journal line, index entry, patch values). */
function singleLine(text: string, label: string): string {
  if (LINE_BREAKING_RE.test(text)) throw new ProposalRejectedError(`${label} contains a newline or control character`);
  assertNoReservedMarkup(text, label);
  return text;
}

/** Prose or drafted file content. Newlines are fine; fences and decision lines are not. */
function multiLine(text: string, label: string): string {
  const normalised = text.replace(/\r\n?/g, "\n");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(normalised)) {
    throw new ProposalRejectedError(`${label} contains a control character`);
  }
  assertNoReservedMarkup(normalised, label);
  if (FENCE_LINE_RE.test(normalised)) throw new ProposalRejectedError(`${label} contains a code fence, which would end the proposal's draft block early`);
  return normalised;
}

const PATCH_KEY_RE = /^[A-Za-z][\w-]*$/;

/**
 * Code-level guarantees behind the prompt's "content is data" rule. The validator,
 * not the model's output, decides everything that carries authority. A model that
 * obeys an injected instruction still cannot, through this function:
 *  - choose where the proposal file is written (the id must be the deterministic P-<hash>),
 *  - point the proposal at a path outside the bundle or estate,
 *  - ask for a kind its agent may not draft (never `new-procedure`),
 *  - clear needs-human (set true for every agent except the gap-miner, whose false is set in code),
 *  - smuggle a decision line, a fence, a reserved heading or an extra key into the proposal file.
 * Returns the sanitised draft to write, or throws ProposalRejectedError.
 */
export function validateDraft(draft: ProposalDraft, scope: TargetScope): ProposalDraft {
  if (!PROPOSAL_ID_RE.test(draft.id)) throw new ProposalRejectedError(`proposal id is not a deterministic P-<hash>: ${JSON.stringify(draft.id)}`);
  if (!ALLOWED_KINDS[scope.agent]?.includes(draft.kind)) {
    throw new ProposalRejectedError(`${scope.agent} may not draft a ${JSON.stringify(draft.kind)} proposal`);
  }
  if (draft.target !== null) confineTarget(draft.target, scope);

  const patch = draft.frontmatterPatch
    ? Object.fromEntries(Object.entries(draft.frontmatterPatch).map(([key, value]) => {
        if (!PATCH_KEY_RE.test(key)) throw new ProposalRejectedError(`frontmatter patch key is not a plain key: ${JSON.stringify(key)}`);
        return [key, singleLine(value, `frontmatter patch value for ${key}`)];
      }))
    : null;
  return {
    ...draft,
    summary: singleLine(draft.summary, "summary"),
    rationale: multiLine(draft.rationale, "rationale"),
    frontmatterPatch: patch,
    bodyDraft: draft.bodyDraft === null ? null : multiLine(draft.bodyDraft, "body draft"),
    journalLine: singleLine(draft.journalLine, "journal line"),
    indexEntry: draft.indexEntry === null ? null : singleLine(draft.indexEntry, "index entry"),
    // Quotes are verbatim evidence and may span lines; they are rendered on one line.
    evidenceQuotes: draft.evidenceQuotes.map((q) => ({
      file: singleLine(q.file, "evidence quote file"),
      quote: singleLine(q.quote.replace(/\s+/g, " ").trim(), "evidence quote"),
    })),
    needsHuman: scope.agent === "gap-miner" ? draft.needsHuman : true,
  };
}

export function writeProposal(
  outDir: string,
  draft: ProposalDraft,
  prov: Provenance,
  force: boolean,
  scope: TargetScope,
): { path: string; skipped: boolean } {
  const checked = validateDraft(draft, scope);
  // Render first: it refuses frontmatter values that cannot be written safely, before anything touches disk.
  const markdown = renderProposalMarkdown(checked, prov);
  const path = proposalPath(outDir, checked.id);
  if (!isInside(resolve(path), resolve(outDir))) throw new ProposalRejectedError(`proposal path leaves the proposals directory: ${path}`);
  if (existsSync(path) && !force) return { path, skipped: true };
  mkdirSync(resolve(outDir), { recursive: true });
  writeFileSync(path, markdown);
  return { path, skipped: false };
}
