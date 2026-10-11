import type { Finding } from "../types.js";

/**
 * AI-layer types (v0.4). Kept separate from src/types.ts so the public
 * deterministic JSON shapes stay frozen - the stage contract.
 */

export interface AiCallOptions {
  apiKey: string;
  model: string;
  /** Injectable for tests - defaults to globalThis.fetch. Live API is unreachable from CI. */
  fetchFn?: typeof fetch;
  /** Injectable sleep for retry tests. */
  sleepFn?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

/** Findings on the same target file, drafted together in one model call. */
export interface FindingCluster {
  /** Repo-relative file the findings point at; null for bundle-level findings. */
  file: string | null;
  owner: string | null;
  findings: Finding[];
}

/** Closed enum - a routing hint for the judge, never calibration theatre. */
export type Confidence = "low" | "medium" | "high";

/** What the model returns (as validated JSON) and the renderer turns into a proposal file. */
export interface ProposalDraft {
  /** Deterministic id: "P-" + sha256(agent|keyParts)[:12]. No date - re-runs are idempotent. */
  id: string;
  kind: "amend" | "new-concept" | "new-procedure";
  /** Bundle/estate-relative path this amends or creates; null only for legacy new concepts. */
  target: string | null;
  summary: string;
  rationale: string;
  /** Flat key→value patch for the target's frontmatter, when applicable. */
  frontmatterPatch: Record<string, string> | null;
  /** Full drafted body for new concepts (or a replacement section), when applicable. */
  bodyDraft: string | null;
  /** Ready journal line in the decision grammar (date placeholder until election). */
  journalLine: string;
  /** Ready index.md line, when the proposal adds a bundle concept. */
  indexEntry: string | null;
  confidence: Confidence;
  evidenceQuotes: { file: string; quote: string }[];
  /** True when the model judges a human must author content (e.g. a missing concept). */
  needsHuman: boolean;
  /** Finding/check labels represented by this proposal. Defaults from kind when omitted. */
  checks?: string[];
}

/** Stamped on every AI output. The judge can audit exactly what produced a draft. */
export interface Provenance {
  agent: "scribe" | "gap-miner" | "drift-reviewer";
  model: string;
  /** sha256 of system+user prompt text. Prompt assembly is pure, so this is reproducible. */
  promptSha256: string;
  evidenceFiles: string[];
  /** sha256 over the sorted reviewed file path/content hashes. Used by apply write mode to refuse stale proposals. */
  reviewedSurfaceSha256?: string;
  reviewedSurfaceFiles?: { path: string; sha256: string }[];
  generatedAt: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Result of an agent run - partial failure is a first-class outcome. */
export interface AgentRunResult {
  written: string[];
  skippedExisting: string[];
  failed: { cluster: string; error: string }[];
  usageTotals: { input: number; output: number };
}
