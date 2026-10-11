import { createHash } from "node:crypto";
import type { Provenance } from "./types.js";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function hashReviewedSurface(files: { path: string; content: string }[]): {
  sha256: string;
  files: { path: string; sha256: string }[];
} {
  const hashed = files
    .map((f) => ({ path: f.path, sha256: sha256Hex(f.content) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: hashed,
    sha256: sha256Hex(hashed.map((f) => `${f.path}\0${f.sha256}`).join("\n")),
  };
}

/**
 * Deterministic proposal id. Deliberately contains NO date: the same agent
 * proposing the same thing on a re-run hashes identically, so `propose` can
 * skip it - an inbox that spams teaches the judge to stop judging.
 */
export function proposalIdFor(agent: string, keyParts: string[]): string {
  return "P-" + sha256Hex([agent, ...keyParts].join("|")).slice(0, 12);
}

/**
 * Deterministically stamp the journal grammar tail. The model supplies prose;
 * the join key and decision fields are NEVER model-authored: any model-written
 * bracket clauses are stripped and the canonical tail is appended. A missing
 * clause therefore cannot survive silently (the round-1 regex replace was a
 * no-op on no-match - this rebuild cannot be).
 */
export function stampJournalLine(line: string, id: string): string {
  const prose = line.replace(/\s*\[(proposal|decision|by):[^\]]*\]/gi, "").trimEnd();
  return `${prose} [proposal: ${id}] [decision: elected] [by: <judge>]`;
}

export function buildProvenance(args: {
  agent: Provenance["agent"];
  model: string;
  system: string;
  user: string;
  evidenceFiles: string[];
  reviewedSurfaceFiles?: { path: string; content: string }[];
  usage: { inputTokens: number; outputTokens: number };
  now: Date;
}): Provenance {
  const reviewedSurface = args.reviewedSurfaceFiles ? hashReviewedSurface(args.reviewedSurfaceFiles) : null;
  return {
    agent: args.agent,
    model: args.model,
    promptSha256: sha256Hex(args.system + "\n␞\n" + args.user),
    evidenceFiles: [...args.evidenceFiles].sort(),
    ...(reviewedSurface ? {
      reviewedSurfaceSha256: reviewedSurface.sha256,
      reviewedSurfaceFiles: reviewedSurface.files,
    } : {}),
    generatedAt: args.now.toISOString(),
    usage: args.usage,
  };
}
