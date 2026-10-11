import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { extractLinks, loadBundle, parseFrontmatter, resolveLink } from "../core/bundle.js";
import { loadEstate } from "../core/estate.js";
import { hashReviewedSurface } from "../ai/provenance.js";
import type { Bundle, Estate, Frontmatter, RegisterMode } from "../types.js";

const TEXT_EXT = new Set([".md", ".txt", ".yml", ".yaml", ".json", ".csv"]);

export interface ApplyOptions {
  proposalsDir: string;
  register?: RegisterMode;
  proposalId?: string;
  check?: string;
  noAuditLog?: boolean;
}

export interface ParsedProposal {
  file: string;
  id: string;
  target: string | null;
  kind: "amend" | "new-concept" | "new-procedure";
  status: string | null;
  checks: string[];
  evidence: string[];
  needsHuman: boolean;
  elected: boolean;
  promptSha256: string | null;
  reviewedSurfaceSha256: string | null;
  reviewedSurfaceFiles: { path: string; sha256: string }[];
  generatedAt: string | null;
  frontmatterPatch: Record<string, string> | null;
  bodyDraft: string | null;
  indexEntry: string | null;
  journalLine: string | null;
}

export interface ApplyChange {
  file: string;
  before: string;
  after: string;
  diff: string;
  newFile?: boolean;
}

export interface PlannedProposal {
  proposal: ParsedProposal;
  changes: ApplyChange[];
}

export interface ApplyPlan {
  planned: PlannedProposal[];
  skipped: { proposal: string; reason: string }[];
  refused: { proposal: string; reason: string }[];
}

export interface ApplyWriteResult {
  plan: ApplyPlan;
  written: string[];
}

function scalar(fm: Frontmatter | null, key: string): string | null {
  const v = fm?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function list(fm: Frontmatter | null, key: string): string[] {
  const v = fm?.[key];
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (Array.isArray(v)) return v.map((x) => x.trim()).filter(Boolean);
  return [];
}

function boolish(v: string | null): boolean {
  return v === "true" || v === "yes" || v === "1";
}

function parseReviewedSurface(entries: string[]): { path: string; sha256: string }[] {
  return entries.map((entry) => {
    const m = entry.match(/^(.+):([a-f0-9]{64})$/i);
    if (!m || !m[1] || !m[2]) throw new Error(`malformed reviewed-surface entry: ${entry}`);
    return { path: m[1].trim(), sha256: m[2].toLowerCase() };
  });
}

function isTextLike(path: string): boolean {
  const base = posix.basename(path);
  const i = base.lastIndexOf(".");
  return i >= 0 && TEXT_EXT.has(base.slice(i).toLowerCase());
}

function fencedBlock(content: string, heading: string): string | null {
  const i = content.indexOf(`### ${heading}`);
  if (i < 0) return null;
  const rest = content.slice(i);
  const m = rest.match(/^### .+\r?\n```[^\n]*\r?\n([\s\S]*?)\r?\n```/);
  return m?.[1] ?? null;
}

function parsePatch(block: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!m || !m[1]) throw new Error(`malformed frontmatter patch line: ${line}`);
    out[m[1]] = (m[2] ?? "").trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function parseProposalMarkdown(content: string, file = "(memory)"): ParsedProposal {
  const fm = parseFrontmatter(content);
  if (fm?.["type"] !== "Proposal") throw new Error("not a Proposal file");
  const id = scalar(fm, "id");
  if (!id) throw new Error("proposal missing id");
  const rawKind = scalar(fm, "kind");
  if (rawKind !== "amend" && rawKind !== "new-concept" && rawKind !== "new-procedure") throw new Error(`unsupported proposal kind: ${rawKind ?? "(missing)"}`);
  const rawTarget = scalar(fm, "target");
  const target = rawTarget && rawTarget !== "(new concept)" ? rawTarget : null;
  const needsHuman = boolish(scalar(fm, "needs-human"));
  const elected =
    boolish(scalar(fm, "elected")) ||
    scalar(fm, "status") === "elected" ||
    /^- \[[xX]\] Elect\b/m.test(content);

  const patchBlock = fencedBlock(content, "Frontmatter patch");
  return {
    file,
    id,
    target,
    kind: rawKind,
    status: scalar(fm, "status"),
    checks: list(fm, "checks"),
    evidence: list(fm, "evidence"),
    needsHuman,
    elected,
    promptSha256: scalar(fm, "prompt-sha256"),
    reviewedSurfaceSha256: scalar(fm, "reviewed-surface-sha256"),
    reviewedSurfaceFiles: parseReviewedSurface(list(fm, "reviewed-surface")),
    generatedAt: scalar(fm, "generated-at"),
    frontmatterPatch: patchBlock === null ? null : parsePatch(patchBlock),
    bodyDraft: fencedBlock(content, "Body draft") ?? fencedBlock(content, "New concept:") ?? fencedBlock(content, "New procedure:"),
    indexEntry: fencedBlock(content, "index.md entry"),
    journalLine: fencedBlock(content, "Journal line (paste into log.md on election)"),
  };
}

export function loadProposals(dir: string): ParsedProposal[] {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new Error(`No such proposals dir: ${abs}`);
  const out: ParsedProposal[] = [];
  for (const f of readdirSync(abs).sort()) {
    if (!f.endsWith(".md")) continue;
    const path = join(abs, f);
    out.push(parseProposalMarkdown(readFileSync(path, "utf8"), path));
  }
  return out;
}

function loadProposalInputs(dir: string): { proposals: ParsedProposal[]; refused: { proposal: string; reason: string }[] } {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new Error(`No such proposals dir: ${abs}`);
  const proposals: ParsedProposal[] = [];
  const refused: { proposal: string; reason: string }[] = [];
  for (const f of readdirSync(abs).sort()) {
    if (!f.endsWith(".md")) continue;
    const path = join(abs, f);
    try {
      proposals.push(parseProposalMarkdown(readFileSync(path, "utf8"), path));
    } catch (err) {
      refused.push({ proposal: f.replace(/\.md$/, ""), reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { proposals, refused };
}

function frontmatterBounds(content: string): { bodyStart: number; block: string } | null {
  const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?/);
  if (!m || m[1] === undefined || m.index !== 0) return null;
  return { bodyStart: m[0].length, block: m[1] };
}

function assertSimpleFrontmatterBlock(block: string): void {
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\s/.test(line)) throw new Error("target frontmatter uses non-simple YAML; apply write-mode cannot safely round-trip it");
    if (/: *[|>](?:\s|$)/.test(line)) {
      throw new Error("target frontmatter uses non-simple YAML; apply write-mode cannot safely round-trip it");
    }
    if (/(^|[\s[,])[&*][A-Za-z0-9_-]+($|[\s,\]])/.test(line)) {
      throw new Error("target frontmatter uses non-simple YAML; apply write-mode cannot safely round-trip it");
    }
    if (!/^[A-Za-z][\w-]*:\s*.*$/.test(line)) {
      throw new Error("target frontmatter uses non-simple YAML; apply write-mode cannot safely round-trip it");
    }
  }
}

function applyFrontmatterPatch(content: string, patch: Record<string, string>): string {
  const bounds = frontmatterBounds(content);
  if (!bounds) throw new Error("target has no deterministic frontmatter block");
  assertSimpleFrontmatterBlock(bounds.block);
  const lines = bounds.block.split(/\r?\n/);
  for (const key of Object.keys(patch).sort()) {
    const next = `${key}: ${patch[key]}`;
    const i = lines.findIndex((line) => line.match(new RegExp(`^${escapeRegExp(key)}:\\s*`)));
    if (i >= 0) lines[i] = next;
    else lines.push(next);
  }
  return `---\n${lines.join("\n")}\n---\n${content.slice(bounds.bodyStart)}`;
}

function applyBodyDraft(content: string, bodyDraft: string): string {
  const bounds = frontmatterBounds(content);
  if (!bounds) throw new Error("target has no deterministic frontmatter/body boundary");
  return `${content.slice(0, bounds.bodyStart)}${bodyDraft.replace(/\s+$/, "")}\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unifiedDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const oldChunk = a.slice(prefix, a.length - suffix);
  const newChunk = b.slice(prefix, b.length - suffix);
  const oldStart = prefix + 1;
  const newStart = prefix + 1;
  const lines = [`--- a/${file}`, `+++ b/${file}`, `@@ -${oldStart},${oldChunk.length} +${newStart},${newChunk.length} @@`];
  for (const line of oldChunk) lines.push(`-${line}`);
  for (const line of newChunk) lines.push(`+${line}`);
  return `${lines.join("\n")}\n`;
}

function readBundleTarget(bundle: Bundle, target: string): string | null {
  return bundle.concepts.find((x) => x.path === target)?.content ?? null;
}

function estateTargetItem(estate: Estate, target: string): Estate["items"][number] | null {
  return estate.items.find((x) => x.path === target && x.content !== null) ?? null;
}

function bundleLog(bundle: Bundle): { path: string; content: string } | null {
  const log = bundle.concepts.find((c) => c.bundlePath === "log.md");
  return log ? { path: log.path, content: log.content } : null;
}

function bundleIndex(bundle: Bundle): { path: string; content: string } | null {
  const index = bundle.concepts.find((c) => c.bundlePath === "index.md");
  return index ? { path: index.path, content: index.content } : null;
}

function canonicalBundleTarget(bundle: Bundle, target: string): string | null {
  const clean = posix.normalize(target.replace(/^\/+/, ""));
  if (!clean || clean === "." || clean.startsWith("..")) return null;
  const resolved = bundle.bundleRel === "" || clean === bundle.bundleRel || clean.startsWith(`${bundle.bundleRel}/`)
    ? clean
    : posix.join(bundle.bundleRel, clean);
  if (resolved.startsWith("..")) return null;
  if (bundle.bundleRel !== "" && resolved !== bundle.bundleRel && !resolved.startsWith(`${bundle.bundleRel}/`)) return null;
  return resolved;
}

function canonicalEstateTarget(estate: Estate, target: string): string | null {
  const clean = posix.normalize(target.replace(/^\/+/, ""));
  if (!clean || clean === "." || clean.startsWith("..")) return null;
  if (estate.mode === "skills") return /^[^/]+\/SKILL\.md$/.test(clean) ? clean : null;
  if (estate.mode === "agents") return /^[^/]+\.md$/.test(clean) ? clean : null;
  if (estate.mode === "commands") return /^[^/]+\.md$/.test(clean) ? clean : null;
  if (/^skills\/[^/]+\/SKILL\.md$/.test(clean)) return clean;
  if (/^agents\/[^/]+\.md$/.test(clean)) return clean;
  if (/^commands\/[^/]+\.md$/.test(clean)) return clean;
  if (/^plugins\//.test(clean)) return clean;
  return null;
}

function isAuthoredEstateCreateTarget(estate: Estate, target: string): boolean {
  if (estate.mode === "skills") return /^[^/]+\/SKILL\.md$/.test(target);
  if (estate.mode === "agents") return /^[^/]+\.md$/.test(target);
  if (estate.mode === "commands") return /^[^/]+\.md$/.test(target);
  return /^skills\/[^/]+\/SKILL\.md$/.test(target) || /^agents\/[^/]+\.md$/.test(target) || /^commands\/[^/]+\.md$/.test(target);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function estateEvidenceExists(estate: Estate, evidencePath: string): boolean {
  if (estate.items.some((i) => i.path === evidencePath && i.content !== null)) return true;
  const abs = resolve(estate.root, evidencePath);
  if (!isInside(abs, estate.root)) return false;
  try {
    return lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

function readBundleSurfaceFile(bundle: Bundle, path: string): string | null {
  const concept = bundle.concepts.find((x) => x.path === path);
  if (concept) return concept.content;
  const definition = bundle.definitions.find((x) => x.path === path);
  if (definition) return definition.content;
  const evidence = bundle.evidenceFiles.find((x) => x.path === path);
  if (evidence) return evidence.content;
  if (!bundle.repoFiles.has(path) || !isTextLike(path)) return null;
  const abs = resolve(bundle.repoRoot, path);
  if (!isInside(abs, bundle.repoRoot)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function readEstateSurfaceFile(estate: Estate, path: string): string | null {
  const item = estate.items.find((x) => x.path === path && x.content !== null);
  if (item?.content !== null && item?.content !== undefined) return item.content;
  if (!isTextLike(path)) return null;
  const abs = resolve(estate.root, path);
  if (!isInside(abs, estate.root)) return null;
  try {
    if (!lstatSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function reviewedSurfaceMatches(
  surface: { type: "bundle"; bundle: Bundle } | { type: "estate"; estate: Estate },
  proposal: ParsedProposal,
): { ok: boolean; reason?: string } {
  if (!proposal.reviewedSurfaceSha256 || proposal.reviewedSurfaceFiles.length === 0) {
    return { ok: false, reason: "missing reviewed-surface provenance" };
  }
  const files: { path: string; content: string }[] = [];
  for (const f of proposal.reviewedSurfaceFiles) {
    const content = surface.type === "bundle"
      ? readBundleSurfaceFile(surface.bundle, f.path)
      : readEstateSurfaceFile(surface.estate, f.path);
    if (content === null) return { ok: false, reason: `reviewed surface file missing: ${f.path}` };
    files.push({ path: f.path, content });
  }
  const current = hashReviewedSurface(files);
  if (
    current.sha256 !== proposal.reviewedSurfaceSha256 ||
    current.files.some((f, i) => f.path !== proposal.reviewedSurfaceFiles[i]?.path || f.sha256 !== proposal.reviewedSurfaceFiles[i]?.sha256)
  ) {
    return { ok: false, reason: "reviewed surface changed since proposal was drafted" };
  }
  return { ok: true };
}

function appendIndexEntry(content: string, entry: string): string {
  return `${content.replace(/\s*$/, "\n")}${entry.trim()}\n`;
}

function indexEntryTargets(bundle: Bundle, indexPath: string, entry: string, target: string): boolean {
  return extractLinks(entry).some((raw) => resolveLink(raw, indexPath, bundle.bundleRel) === target);
}

function assertNewConceptContent(content: string): void {
  const bounds = frontmatterBounds(content);
  if (!bounds) throw new Error("new-concept body must include deterministic frontmatter");
  assertSimpleFrontmatterBlock(bounds.block);
  const fm = parseFrontmatter(content);
  if (!fm?.["type"]) throw new Error("new-concept frontmatter must include `type:`");
}

function assertNewProcedureContent(content: string): void {
  const bounds = frontmatterBounds(content);
  if (!bounds) throw new Error("new-procedure body must include deterministic frontmatter");
  assertSimpleFrontmatterBlock(bounds.block);
  const fm = parseFrontmatter(content);
  const description = typeof fm?.["description"] === "string" ? fm["description"].trim() : "";
  if (!description) throw new Error("new-procedure frontmatter must include `description:`");
}

function planIndexChange(bundle: Bundle, proposal: ParsedProposal, target: string, changes: ApplyChange[]): boolean {
  if (!proposal.indexEntry) return true;
  const index = bundleIndex(bundle);
  if (!index) throw new Error("bundle index.md is missing");
  const entry = proposal.indexEntry.trim();
  if (!entry) return true;
  if (!indexEntryTargets(bundle, index.path, entry, target)) {
    throw new Error(`index entry does not link to proposal target: ${target}`);
  }
  if (index.content.includes(entry)) return true;
  const indexAfter = appendIndexEntry(index.content, entry);
  const indexDiff = unifiedDiff(index.path, index.content, indexAfter);
  if (indexDiff) changes.push({ file: index.path, before: index.content, after: indexAfter, diff: indexDiff });
  return true;
}

function estateAuditPath(mode: RegisterMode): string {
  return `.kernel-keeper/audit/${mode}-log.md`;
}

function estateAuditDate(proposal: ParsedProposal): string {
  const journalDate = proposal.journalLine?.match(/^- \*\*(\d{4}-\d{2}-\d{2})\*\*/)?.[1];
  if (journalDate) return journalDate;
  if (proposal.generatedAt) {
    const d = new Date(proposal.generatedAt);
    if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return "YYYY-MM-DD";
}

function estateAuditJudge(proposal: ParsedProposal): string {
  return proposal.journalLine?.match(/\[by: ([^\]]+)\]/)?.[1]?.trim() || "<judge>";
}

function estateAuditLine(proposal: ParsedProposal, target: string): string {
  const checks = proposal.checks.length > 0 ? ` [checks: ${proposal.checks.join(",")}]` : "";
  return `- **${estateAuditDate(proposal)}** - applied proposal ${proposal.id} to \`${target}\` [proposal: ${proposal.id}] [decision: elected] [by: ${estateAuditJudge(proposal)}]${checks}`;
}

function readEstateAuditLog(estate: Estate): string | null {
  const path = estateAuditPath(estate.mode);
  const abs = resolve(estate.root, path);
  if (!isInside(abs, estate.root)) return null;
  try {
    if (!lstatSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function planEstateAuditChange(estate: Estate, proposal: ParsedProposal, target: string, changes: ApplyChange[]): void {
  const path = estateAuditPath(estate.mode);
  const before = readEstateAuditLog(estate);
  if (before?.includes(`[proposal: ${proposal.id}]`) || before?.includes(`proposal ${proposal.id} to \`${target}\``)) return;
  const header = `# Kernel Keeper ${estate.mode} Apply Audit\n\n`;
  const base = before ?? header;
  const line = estateAuditLine(proposal, target);
  const after = `${base.replace(/\s*$/, "\n")}${line}\n`;
  const diff = unifiedDiff(path, before ?? "", after);
  if (diff) changes.push({ file: path, before: before ?? "", after, diff, newFile: before === null });
}

export function planApply(inputPath: string, opts: ApplyOptions): ApplyPlan {
  const loaded = loadProposalInputs(opts.proposalsDir);
  const proposals = loaded.proposals
    .filter((p) => !opts.proposalId || p.id === opts.proposalId)
    .filter((p) => !opts.check || p.checks.includes(opts.check));
  const plan: ApplyPlan = {
    planned: [],
    skipped: [],
    refused: loaded.refused.filter((r) => !opts.proposalId || r.proposal === opts.proposalId),
  };
  const surface = opts.register ? { type: "estate" as const, estate: loadEstate(inputPath, opts.register) } : { type: "bundle" as const, bundle: loadBundle(inputPath) };
  const targetFor = (p: ParsedProposal): string | null => {
    if (!p.target) return null;
    return surface.type === "bundle" ? canonicalBundleTarget(surface.bundle, p.target) : canonicalEstateTarget(surface.estate, p.target);
  };
  const targetCounts = new Map<string, number>();
  for (const p of proposals) {
    const target = targetFor(p);
    if (target) targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
  }
  const hasEvidence = (e: string): boolean => {
    if (surface.type === "bundle") return surface.bundle.repoFiles.has(e);
    return estateEvidenceExists(surface.estate, e);
  };

  for (const p of proposals) {
    if (!p.elected) {
      plan.skipped.push({ proposal: p.id, reason: "not elected" });
      continue;
    }
    if (p.kind === "amend" && !p.needsHuman) {
      plan.refused.push({ proposal: p.id, reason: "missing needs-human: true" });
      continue;
    }
    if (p.kind === "new-procedure" && !p.needsHuman) {
      plan.refused.push({ proposal: p.id, reason: "missing needs-human: true" });
      continue;
    }
    if (!p.promptSha256) {
      plan.refused.push({ proposal: p.id, reason: "missing prompt-sha256 provenance" });
      continue;
    }
    const target = targetFor(p);
    if (!target) {
      const reason = surface.type === "bundle"
        ? (p.target ? "proposal target escapes bundle root" : "proposal missing target")
        : (p.target ? "proposal target is not a supported authored estate path" : "proposal missing target");
      plan.refused.push({ proposal: p.id, reason });
      continue;
    }
    if ((targetCounts.get(target) ?? 0) > 1) {
      plan.refused.push({ proposal: p.id, reason: `multiple proposals target ${target}` });
      continue;
    }
    if (!isTextLike(target)) {
      plan.refused.push({ proposal: p.id, reason: `target is not text-like: ${target}` });
      continue;
    }
    const missingEvidence = p.evidence.filter((e) => e && !hasEvidence(e));
    if (missingEvidence.length > 0) {
      plan.refused.push({ proposal: p.id, reason: `missing evidence file(s): ${missingEvidence.join(", ")}` });
      continue;
    }

    const reviewed = reviewedSurfaceMatches(surface, p);
    if (!reviewed.ok) {
      plan.refused.push({ proposal: p.id, reason: reviewed.reason ?? "reviewed surface mismatch" });
      continue;
    }

    try {
      const changes: ApplyChange[] = [];
      if (p.kind === "new-concept") {
        if (surface.type !== "bundle") {
          plan.refused.push({ proposal: p.id, reason: "new-concept proposals only apply to bundle mode" });
          continue;
        }
        if (!p.bodyDraft) {
          plan.refused.push({ proposal: p.id, reason: "new-concept proposal has no body draft" });
          continue;
        }
        assertNewConceptContent(p.bodyDraft);
        const existing = readBundleSurfaceFile(surface.bundle, target);
        if (existing === null) {
          if (surface.bundle.repoFiles.has(target)) {
            plan.refused.push({ proposal: p.id, reason: `target already exists outside the loaded concept surface: ${target}` });
            continue;
          }
          const targetDiff = unifiedDiff(target, "", p.bodyDraft.replace(/\s+$/, "") + "\n");
          if (targetDiff) changes.push({ file: target, before: "", after: p.bodyDraft.replace(/\s+$/, "") + "\n", diff: targetDiff, newFile: true });
        } else if (existing !== p.bodyDraft.replace(/\s+$/, "") + "\n") {
          plan.refused.push({ proposal: p.id, reason: `target already exists with different content: ${target}` });
          continue;
        }
        if (!p.indexEntry) {
          plan.refused.push({ proposal: p.id, reason: "new-concept proposal has no index.md entry" });
          continue;
        }
        planIndexChange(surface.bundle, p, target, changes);
      } else if (p.kind === "new-procedure") {
        if (surface.type !== "estate") {
          plan.refused.push({ proposal: p.id, reason: "new-procedure proposals only apply to estate register mode" });
          continue;
        }
        if (!p.bodyDraft) {
          plan.refused.push({ proposal: p.id, reason: "new-procedure proposal has no body draft" });
          continue;
        }
        if (!isAuthoredEstateCreateTarget(surface.estate, target)) {
          plan.refused.push({ proposal: p.id, reason: "new-procedure target must be an authored skill, agent, or command path" });
          continue;
        }
        assertNewProcedureContent(p.bodyDraft);
        const existing = readEstateSurfaceFile(surface.estate, target);
        const next = p.bodyDraft.replace(/\s+$/, "") + "\n";
        if (existing === null) {
          const abs = resolve(surface.estate.root, target);
          if (!isInside(abs, surface.estate.root)) {
            plan.refused.push({ proposal: p.id, reason: `planned write escapes loaded root: ${target}` });
            continue;
          }
          try {
            if (lstatSync(abs).isFile()) {
              plan.refused.push({ proposal: p.id, reason: `target already exists outside the loaded estate surface: ${target}` });
              continue;
            }
          } catch {
            /* missing */
          }
          const targetDiff = unifiedDiff(target, "", next);
          if (targetDiff) changes.push({ file: target, before: "", after: next, diff: targetDiff, newFile: true });
        } else if (existing !== next) {
          plan.refused.push({ proposal: p.id, reason: `target already exists with different content: ${target}` });
          continue;
        }
      } else {
        const estateItem = surface.type === "estate" ? estateTargetItem(surface.estate, target) : null;
        if (estateItem?.thirdParty) {
          plan.refused.push({ proposal: p.id, reason: "target is a third-party plugin item; apply write-mode only edits authored estate items" });
          continue;
        }
        const before = surface.type === "bundle" ? readBundleTarget(surface.bundle, target) : estateItem?.content ?? null;
        if (before === null) {
          plan.refused.push({ proposal: p.id, reason: `target is not in the loaded surface: ${target}` });
          continue;
        }
        let after = before;
        if (p.frontmatterPatch) after = applyFrontmatterPatch(after, p.frontmatterPatch);
        if (p.bodyDraft) after = applyBodyDraft(after, p.bodyDraft);
        const targetDiff = unifiedDiff(target, before, after);
        if (targetDiff) changes.push({ file: target, before, after, diff: targetDiff });

        if (p.indexEntry) {
          if (surface.type !== "bundle") {
            plan.refused.push({ proposal: p.id, reason: "index entries only apply to bundle mode" });
            continue;
          }
          planIndexChange(surface.bundle, p, target, changes);
        }
      }

      if (surface.type === "bundle" && p.journalLine) {
        const log = bundleLog(surface.bundle);
        if (!log) {
          plan.refused.push({ proposal: p.id, reason: "bundle log.md is missing" });
          continue;
        }
        if (!log.content.includes(`[proposal: ${p.id}]`)) {
          const logAfter = `${log.content.replace(/\s*$/, "\n")}${p.journalLine}\n`;
          const logDiff = unifiedDiff(log.path, log.content, logAfter);
          if (logDiff) changes.push({ file: log.path, before: log.content, after: logAfter, diff: logDiff });
        }
      }
      if (surface.type === "estate" && !opts.noAuditLog && changes.length > 0) {
        planEstateAuditChange(surface.estate, p, target, changes);
      }

      if (changes.length === 0) plan.skipped.push({ proposal: p.id, reason: "already applied" });
      else plan.planned.push({ proposal: p, changes });
    } catch (err) {
      plan.refused.push({ proposal: p.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return plan;
}

function writeRoot(inputPath: string, register?: RegisterMode): string {
  if (register) return loadEstate(inputPath, register).root;
  return loadBundle(inputPath).repoRoot;
}

export function writeApply(inputPath: string, opts: ApplyOptions): ApplyWriteResult {
  const plan = planApply(inputPath, opts);
  const written: string[] = [];
  if (plan.refused.length > 0) return { plan, written };

  const fileCounts = new Map<string, number>();
  for (const p of plan.planned) {
    for (const c of p.changes) fileCounts.set(c.file, (fileCounts.get(c.file) ?? 0) + 1);
  }
  for (const [file, count] of fileCounts) {
    if (count > 1) {
      plan.refused.push({ proposal: "(write)", reason: `multiple planned changes touch ${file}; use --proposal to apply one at a time` });
    }
  }
  if (plan.refused.length > 0) return { plan, written };

  const root = writeRoot(inputPath, opts.register);
  for (const p of plan.planned) {
    for (const c of p.changes) {
      const abs = resolve(root, c.file);
      if (!isInside(abs, root)) {
        plan.refused.push({ proposal: p.proposal.id, reason: `planned write escapes loaded root: ${c.file}` });
        return { plan, written: [] };
      }
      let current: string;
      try {
        current = readFileSync(abs, "utf8");
      } catch (err) {
        if (c.newFile) current = "";
        else {
          plan.refused.push({ proposal: p.proposal.id, reason: err instanceof Error ? err.message : String(err) });
          return { plan, written: [] };
        }
      }
      if (c.newFile && current !== "") {
        plan.refused.push({ proposal: p.proposal.id, reason: `target appeared after dry-run planning: ${c.file}` });
        return { plan, written: [] };
      }
      if (!c.newFile && current !== c.before) {
        plan.refused.push({ proposal: p.proposal.id, reason: `target changed after dry-run planning: ${c.file}` });
        return { plan, written: [] };
      }
    }
  }

  for (const p of plan.planned) {
    for (const c of p.changes) {
      const abs = resolve(root, c.file);
      if (c.newFile) mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c.after);
      written.push(c.file);
    }
  }
  return { plan, written };
}
