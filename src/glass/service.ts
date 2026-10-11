import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseProposalMarkdown, planApply, writeApply as writeApplyEngine } from "../apply/proposals.js";
import { runEstateChecks } from "../checks/estate.js";
import { runChecks } from "../checks/index.js";
import { loadBundle } from "../core/bundle.js";
import { loadEstate } from "../core/estate.js";
import { writeProposalDecision } from "./decisions.js";
import type { ParsedProposal } from "../apply/proposals.js";
import type { GlassDecision, GlassDecisionOptions } from "./decisions.js";
import type { EstateOptions, PatrolOptions } from "../types.js";
import type {
  GlassApplyOptions,
  GlassApplyPreview,
  GlassApplyResult,
  GlassAuditEntry,
  GlassAuditTrail,
  GlassProposalDetail,
  GlassProposalParseResult,
  GlassScanOptions,
  GlassScanResult,
  GlassSource,
} from "./types.js";
import {
  findingToGlass,
  planToGlass,
  proposalToCard,
  proposalToDetail,
  refusalToGlass,
  severityCounts,
} from "./view-models.js";

function sourceFor(root: string, opts: { register?: GlassSource["register"]; memory?: boolean; label?: string } = {}): GlassSource {
  return {
    root: resolve(root),
    kind: opts.register ? "estate" : "bundle",
    ...(opts.register ? { register: opts.register } : {}),
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
    ...(opts.label ? { label: opts.label } : {}),
  };
}

export function scanSurface(
  root: string,
  opts: GlassScanOptions & { register?: GlassSource["register"]; memory?: boolean; label?: string } = {},
): GlassScanResult {
  const source = sourceFor(root, opts);
  const now = opts.now ?? new Date();
  const result = opts.register
    ? (() => {
        const estate = loadEstate(root, opts.register);
        const checkOpts: EstateOptions = {
          policyDays: opts.policyDays ?? 90,
          denylist: opts.denylist ?? [],
          now,
        };
        return { findings: runEstateChecks(estate, checkOpts), items: estate.items.length };
      })()
    : (() => {
        const bundle = loadBundle(root);
        const checkOpts: PatrolOptions = {
          policyDays: opts.policyDays ?? 90,
          journalDays: opts.journalDays ?? 30,
          memory: opts.memory ?? false,
          now,
        };
        return { findings: runChecks(bundle, checkOpts), items: bundle.concepts.length + bundle.definitions.length };
      })();
  const findingsBySeverity = severityCounts();
  for (const finding of result.findings) findingsBySeverity[finding.severity] += 1;
  return {
    source,
    scannedAt: now.toISOString(),
    stats: {
      items: result.items,
      findingsBySeverity,
    },
    findings: result.findings.map(findingToGlass),
  };
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

export function listProposals(proposalsDir: string): GlassProposalParseResult {
  const loaded = loadProposalInputs(proposalsDir);
  return {
    proposals: loaded.proposals.map(proposalToCard),
    refused: loaded.refused.map(refusalToGlass),
  };
}

export function getProposalDetail(proposalsDir: string, proposalId: string): GlassProposalDetail | null {
  const proposal = loadProposalInputs(proposalsDir).proposals.find((p) => p.id === proposalId);
  return proposal ? proposalToDetail(proposal) : null;
}

export function decideProposal(
  proposalsDir: string,
  proposalId: string,
  decision: GlassDecision,
  opts: GlassDecisionOptions = {},
): GlassProposalDetail {
  return writeProposalDecision(proposalsDir, proposalId, decision, opts);
}

export function previewApply(root: string, opts: GlassApplyOptions & { register?: GlassSource["register"]; memory?: boolean; label?: string }): GlassApplyPreview {
  const source = sourceFor(root, opts);
  const plan = planApply(root, {
    proposalsDir: opts.proposalsDir,
    ...(opts.register ? { register: opts.register } : {}),
    ...(opts.proposalId ? { proposalId: opts.proposalId } : {}),
    ...(opts.check ? { check: opts.check } : {}),
    ...(opts.noAuditLog !== undefined ? { noAuditLog: opts.noAuditLog } : {}),
  });
  return planToGlass(source, plan);
}

export function applyApproved(root: string, opts: GlassApplyOptions & { register?: GlassSource["register"]; memory?: boolean; label?: string }): GlassApplyResult {
  const source = sourceFor(root, opts);
  const result = writeApplyEngine(root, {
    proposalsDir: opts.proposalsDir,
    ...(opts.register ? { register: opts.register } : {}),
    ...(opts.proposalId ? { proposalId: opts.proposalId } : {}),
    ...(opts.check ? { check: opts.check } : {}),
    ...(opts.noAuditLog !== undefined ? { noAuditLog: opts.noAuditLog } : {}),
  });
  return {
    preview: planToGlass(source, result.plan),
    written: result.written,
  };
}

function auditPathFor(root: string, source: GlassSource): string | null {
  if (source.kind === "estate" && source.register) return join(source.root, ".kernel-keeper", "audit", `${source.register}-log.md`);
  const bundle = loadBundle(root);
  const log = bundle.concepts.find((concept) => concept.bundlePath === "log.md");
  return log ? join(bundle.repoRoot, log.path) : null;
}

function parseAuditLine(line: string): GlassAuditEntry | null {
  if (!line.trim().startsWith("-")) return null;
  const date = line.match(/^- \*\*(\d{4}-\d{2}-\d{2})\*\*/)?.[1] ?? null;
  const proposal = line.match(/\[proposal: ([^\]]+)\]/)?.[1]?.trim() ?? null;
  const target = line.match(/`([^`]+)`/)?.[1]?.trim() ?? null;
  const summary = line
    .replace(/^- \*\*\d{4}-\d{2}-\d{2}\*\* [\u2014-]\s*/, "")
    .replace(/\s*\[[^\]]+\]/g, "")
    .trim();
  return { date, proposal, target, summary, raw: line };
}

export function getAuditTrail(root: string, opts: { register?: GlassSource["register"]; memory?: boolean; label?: string } = {}): GlassAuditTrail {
  const source = sourceFor(root, opts);
  const path = auditPathFor(root, source);
  if (!path || !existsSync(path)) return { source, path, entries: [] };
  const entries = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map(parseAuditLine)
    .filter((entry): entry is GlassAuditEntry => entry !== null);
  return { source, path, entries };
}

export function proposalDisplayName(proposal: GlassProposalDetail): string {
  return proposal.target ? basename(proposal.target) : proposal.id;
}
