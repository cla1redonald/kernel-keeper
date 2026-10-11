import type { ApplyChange, ParsedProposal } from "../apply/proposals.js";
import type { RegisterMode, Severity } from "../types.js";

export type GlassSurfaceKind = "bundle" | "estate";

export interface GlassSource {
  root: string;
  kind: GlassSurfaceKind;
  register?: RegisterMode;
  memory?: boolean;
  label?: string;
}

export interface GlassSeverityCounts {
  HIGH: number;
  MED: number;
  LOW: number;
}

export interface GlassFinding {
  id: string;
  check: string;
  severity: Severity;
  title: string;
  summary: string;
  whyItMatters: string;
  recommendedAction: string;
  file?: string;
  owner?: string;
  register?: string;
  technical: {
    message: string;
    hint?: string;
  };
}

export interface GlassScanResult {
  source: GlassSource;
  scannedAt: string;
  stats: {
    items: number;
    findingsBySeverity: GlassSeverityCounts;
  };
  findings: GlassFinding[];
}

export type GlassProposalState = "drafted" | "needs-review" | "approved" | "rejected" | "amended" | "applied" | "refused" | "stale";

export interface GlassProposalCard {
  id: string;
  file: string;
  state: GlassProposalState;
  kind: ParsedProposal["kind"];
  target: string | null;
  title: string;
  summary: string;
  checks: string[];
  evidence: string[];
  needsHuman: boolean;
  elected: boolean;
  generatedAt: string | null;
}

export interface GlassProposalDetail extends GlassProposalCard {
  provenance: {
    promptSha256: string | null;
    reviewedSurfaceSha256: string | null;
    reviewedSurfaceFiles: { path: string; sha256: string }[];
  };
  draft: {
    frontmatterPatch: Record<string, string> | null;
    bodyDraft: string | null;
    indexEntry: string | null;
    journalLine: string | null;
  };
}

export interface GlassRefusal {
  proposal: string;
  summary: string;
  technicalReason: string;
}

export interface GlassSkipped {
  proposal: string;
  summary: string;
  technicalReason: string;
}

export interface GlassApplyChange {
  file: string;
  newFile: boolean;
  summary: string;
  diff: string;
}

export interface GlassPlannedProposal {
  proposal: GlassProposalCard;
  changes: GlassApplyChange[];
}

export interface GlassApplyPreview {
  source: GlassSource;
  planned: GlassPlannedProposal[];
  skipped: GlassSkipped[];
  refused: GlassRefusal[];
  canWrite: boolean;
}

export interface GlassApplyResult {
  preview: GlassApplyPreview;
  written: string[];
}

export interface GlassAuditEntry {
  date: string | null;
  proposal: string | null;
  target: string | null;
  summary: string;
  raw: string;
}

export interface GlassAuditTrail {
  source: GlassSource;
  path: string | null;
  entries: GlassAuditEntry[];
}

export interface GlassProposalParseResult {
  proposals: GlassProposalCard[];
  refused: GlassRefusal[];
}

export interface GlassApplyOptions {
  proposalsDir: string;
  proposalId?: string;
  check?: string;
  noAuditLog?: boolean;
}

export interface GlassScanOptions {
  policyDays?: number;
  journalDays?: number;
  denylist?: string[];
  now?: Date;
}

export type GlassRawChange = Pick<ApplyChange, "file" | "diff" | "newFile">;
