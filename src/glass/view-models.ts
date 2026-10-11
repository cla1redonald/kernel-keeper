import { basename } from "node:path";
import type { ApplyChange, ApplyPlan, ParsedProposal } from "../apply/proposals.js";
import type { Finding } from "../types.js";
import { findingCopy, refusalSummary } from "./copy.js";
import type {
  GlassApplyChange,
  GlassApplyPreview,
  GlassFinding,
  GlassPlannedProposal,
  GlassProposalCard,
  GlassProposalDetail,
  GlassProposalState,
  GlassRefusal,
  GlassSeverityCounts,
  GlassSkipped,
  GlassSource,
} from "./types.js";

export function severityCounts(): GlassSeverityCounts {
  return { HIGH: 0, MED: 0, LOW: 0 };
}

export function findingToGlass(finding: Finding, index: number): GlassFinding {
  const copy = findingCopy(finding);
  const location = finding.file ? ` in ${finding.file}` : "";
  return {
    id: `${finding.check}:${finding.file ?? "surface"}:${index}`,
    check: finding.check,
    severity: finding.severity,
    title: copy.title,
    summary: `${finding.message}${location}`,
    whyItMatters: copy.whyItMatters,
    recommendedAction: copy.recommendedAction,
    ...(finding.file ? { file: finding.file } : {}),
    ...(finding.owner ? { owner: finding.owner } : {}),
    ...(finding.register ? { register: finding.register } : {}),
    technical: {
      message: finding.message,
      ...(finding.hint ? { hint: finding.hint } : {}),
    },
  };
}

export function proposalState(proposal: ParsedProposal): GlassProposalState {
  if (proposal.elected) return "approved";
  if (proposal.status === "rejected") return "rejected";
  if (proposal.status === "amended" || proposal.status === "needs-edit") return "amended";
  if (proposal.needsHuman) return "needs-review";
  return "drafted";
}

export function proposalTitle(proposal: ParsedProposal): string {
  const target = proposal.target ? basename(proposal.target) : "new item";
  if (proposal.kind === "new-concept") return `New truth concept: ${target}`;
  if (proposal.kind === "new-procedure") return `New procedure: ${target}`;
  return `Amend ${target}`;
}

export function proposalSummary(proposal: ParsedProposal): string {
  if (proposal.kind === "new-concept") return "Create a new governed truth concept after human approval.";
  if (proposal.kind === "new-procedure") return "Promote a repeated lesson into an approved skill, agent, or command.";
  if (proposal.frontmatterPatch && proposal.bodyDraft) return "Update metadata and body content.";
  if (proposal.frontmatterPatch) return "Update metadata.";
  if (proposal.bodyDraft) return "Update body content.";
  return "Review this proposal before applying any change.";
}

export function proposalToCard(proposal: ParsedProposal): GlassProposalCard {
  return {
    id: proposal.id,
    file: proposal.file,
    state: proposalState(proposal),
    kind: proposal.kind,
    target: proposal.target,
    title: proposalTitle(proposal),
    summary: proposalSummary(proposal),
    checks: proposal.checks,
    evidence: proposal.evidence,
    needsHuman: proposal.needsHuman,
    elected: proposal.elected,
    generatedAt: proposal.generatedAt,
  };
}

export function proposalToDetail(proposal: ParsedProposal): GlassProposalDetail {
  return {
    ...proposalToCard(proposal),
    provenance: {
      promptSha256: proposal.promptSha256,
      reviewedSurfaceSha256: proposal.reviewedSurfaceSha256,
      reviewedSurfaceFiles: proposal.reviewedSurfaceFiles,
    },
    draft: {
      frontmatterPatch: proposal.frontmatterPatch,
      bodyDraft: proposal.bodyDraft,
      indexEntry: proposal.indexEntry,
      journalLine: proposal.journalLine,
    },
  };
}

export function refusalToGlass(refusal: { proposal: string; reason: string }): GlassRefusal {
  return {
    proposal: refusal.proposal,
    summary: refusalSummary(refusal.reason),
    technicalReason: refusal.reason,
  };
}

export function skippedToGlass(skipped: { proposal: string; reason: string }): GlassSkipped {
  return {
    proposal: skipped.proposal,
    summary: refusalSummary(skipped.reason),
    technicalReason: skipped.reason,
  };
}

export function changeToGlass(change: ApplyChange): GlassApplyChange {
  return {
    file: change.file,
    newFile: change.newFile ?? false,
    summary: change.newFile ? `Create ${change.file}` : `Update ${change.file}`,
    diff: change.diff,
  };
}

export function plannedToGlass(planned: ApplyPlan["planned"][number]): GlassPlannedProposal {
  return {
    proposal: proposalToCard(planned.proposal),
    changes: planned.changes.map(changeToGlass),
  };
}

export function planToGlass(source: GlassSource, plan: ApplyPlan): GlassApplyPreview {
  return {
    source,
    planned: plan.planned.map(plannedToGlass),
    skipped: plan.skipped.map(skippedToGlass),
    refused: plan.refused.map(refusalToGlass),
    canWrite: plan.planned.length > 0 && plan.refused.length === 0,
  };
}
