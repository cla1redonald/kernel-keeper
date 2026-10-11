import { loadBundle } from "./core/bundle.js";
import { loadEstate } from "./core/estate.js";
import { runChecks } from "./checks/index.js";
import { runEstateChecks } from "./checks/estate.js";
import type {
  EstateOptions,
  EstateResult,
  PatrolOptions,
  PatrolResult,
  RegisterKind,
  RegisterMode,
  Severity,
  FrontmatterParser,
} from "./types.js";

export * from "./types.js";
export { loadBundle } from "./core/bundle.js";
export { loadEstate, discoverEstateRoots } from "./core/estate.js";
export { runChecks, ALL_CHECKS } from "./checks/index.js";
export { runEstateChecks, ALL_ESTATE_CHECKS } from "./checks/estate.js";
export { renderMarkdown, renderEstateMarkdown } from "./report/markdown.js";
export { runScribe, clusterFindings } from "./ai/scribe.js";
export { runMine, loadCorpus, chunkCorpus, estimateTokens } from "./ai/miner.js";
export { runDriftReview, collectBundleDriftJobs, collectEstateDriftJobs } from "./ai/drift.js";
export { renderProposalMarkdown, assertOutDirSafe, writeProposal } from "./ai/proposal.js";
export { parseProposalMarkdown, loadProposals, planApply, writeApply } from "./apply/proposals.js";
export { snapshotRoot, snapshotBundle, snapshotEstate, compareSnapshots, readVerifySnapshot, writeVerifySnapshot } from "./verify.js";
export {
  applyApproved as glassApplyApproved,
  decideProposal as glassDecideProposal,
  getAuditTrail as glassGetAuditTrail,
  getProposalDetail as glassGetProposalDetail,
  listProposals as glassListProposals,
  previewApply as glassPreviewApply,
  scanSurface as glassScanSurface,
} from "./glass/service.js";
export { createGlassServer, renderApplyPage, renderGlassDashboard, renderProposalInbox, startGlassServer } from "./glass/server.js";
export { renderNotionProposal, renderNotionProposals } from "./glass/notion/render.js";
export { NotionClient, NOTION_VERSION } from "./glass/notion/client.js";
export { validateNotionDatabaseContract } from "./glass/notion/schema.js";
export { publishNotionProposals, readNotionSyncState, syncNotionAudit, syncNotionDecisions, writeNotionSyncState } from "./glass/notion/sync.js";
export { NotionConflictError, NotionServiceUnavailableError, NotionUsageError } from "./glass/notion/errors.js";
export type { GlassDecision, GlassDecisionOptions } from "./glass/decisions.js";
export type { ProposalDraft, Provenance, AgentRunResult, FindingCluster, Confidence } from "./ai/types.js";
export type * from "./glass/types.js";
export type * from "./glass/notion/types.js";
export type * from "./glass/notion/client.js";
export type * from "./glass/notion/schema.js";
export type * from "./glass/notion/sync.js";
export type { GlassServer, GlassServerOptions } from "./glass/server.js";

export interface PatrolConfig {
  policyDays?: number;
  journalDays?: number;
  now?: Date;
  memory?: boolean;
  frontmatterParser?: FrontmatterParser;
}

/** Load a bundle from disk and run every check. The library entry point. */
export function patrol(bundlePath: string, config: PatrolConfig = {}): PatrolResult {
  const opts: PatrolOptions = {
    policyDays: config.policyDays ?? 90,
    journalDays: config.journalDays ?? 30,
    now: config.now ?? new Date(),
    memory: config.memory ?? false,
  };
  const bundle = loadBundle(bundlePath, config.frontmatterParser ? { frontmatterParser: config.frontmatterParser } : {});
  const findings = runChecks(bundle, opts);
  const findingsBySeverity: Record<Severity, number> = { HIGH: 0, MED: 0, LOW: 0 };
  for (const f of findings) findingsBySeverity[f.severity] += 1;
  return {
    findings,
    stats: {
      concepts: bundle.concepts.length,
      definitions: bundle.definitions.length,
      findingsBySeverity,
    },
  };
}

export interface EstateConfig {
  policyDays?: number;
  denylist?: string[];
  now?: Date;
  /** Home directory for resolving `~/…` refs (injectable for tests). */
  homeDir?: string;
  frontmatterParser?: FrontmatterParser;
}

/** Load a procedure register (or whole estate) and run the estate checks. */
export function patrolEstate(inputPath: string, mode: RegisterMode, config: EstateConfig = {}): EstateResult {
  const opts: EstateOptions = {
    policyDays: config.policyDays ?? 90,
    denylist: config.denylist ?? [],
    now: config.now ?? new Date(),
  };
  const estate = loadEstate(inputPath, mode, {
    ...(config.homeDir ? { homeDir: config.homeDir } : {}),
    ...(config.frontmatterParser ? { frontmatterParser: config.frontmatterParser } : {}),
  });
  const findings = runEstateChecks(estate, opts);
  const findingsBySeverity: Record<Severity, number> = { HIGH: 0, MED: 0, LOW: 0 };
  for (const f of findings) findingsBySeverity[f.severity] += 1;
  const byRegister: Record<RegisterKind, number> = { skill: 0, agent: 0, command: 0, plugin: 0 };
  for (const i of estate.items) byRegister[i.register] += 1;
  return {
    findings,
    stats: { items: estate.items.length, byRegister, findingsBySeverity },
  };
}

/** Map findings to a CI exit code under a fail-on threshold. Works for bundle and estate results. */
export function exitCode(
  result: { stats: { findingsBySeverity: Record<Severity, number> } },
  failOn: "high" | "med" | "any",
): number {
  const { HIGH, MED, LOW } = result.stats.findingsBySeverity;
  if (HIGH > 0) return 2;
  if (MED > 0 && (failOn === "med" || failOn === "any")) return 1;
  if (LOW > 0 && failOn === "any") return 1;
  return 0;
}
