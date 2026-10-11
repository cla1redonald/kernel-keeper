import { resolve } from "node:path";
import { loadBundle } from "../core/bundle.js";
import { runChecks } from "../checks/index.js";
import type { Finding, PatrolOptions, Severity } from "../types.js";
import { createMessage, runWithConcurrency } from "./client.js";
import { assembleScribePrompt, bundleContext, SCRIBE_SCHEMA } from "./prompts.js";
import { buildProvenance, proposalIdFor, stampJournalLine } from "./provenance.js";
import { assertOutDirSafe, proposalExists, proposalPath, writeProposal } from "./proposal.js";
import { assertShape, SCRIBE_RESPONSE_SPEC } from "./validate.js";
import type { AgentRunResult, Confidence, FindingCluster, ProposalDraft } from "./types.js";

const SEV_RANK: Record<Severity, number> = { HIGH: 0, MED: 1, LOW: 2 };
/** Checks the Scribe never drafts for. */
const UNDRAFTABLE = new Set(["keeper-internal"]);

export interface ScribeOptions {
  outDir: string;
  model: string;
  apiKey: string;
  minSeverity?: Severity;
  dryRun?: boolean;
  force?: boolean;
  allowInRepo?: boolean;
  policyDays?: number;
  journalDays?: number;
  concurrency?: number;
  maxTokens?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  now?: Date;
  log?: (msg: string) => void;
}

/** Group findings by target file - one model call per cluster, one proposal per file. */
export function clusterFindings(findings: Finding[], minSeverity: Severity): FindingCluster[] {
  const eligible = findings.filter(
    (f) => !UNDRAFTABLE.has(f.check) && SEV_RANK[f.severity] <= SEV_RANK[minSeverity],
  );
  const byFile = new Map<string, FindingCluster>();
  for (const f of eligible) {
    const key = f.file ?? "(bundle)";
    const cluster = byFile.get(key) ?? { file: f.file ?? null, owner: f.owner ?? null, findings: [] };
    cluster.findings.push(f);
    if (!cluster.owner && f.owner) cluster.owner = f.owner;
    byFile.set(key, cluster);
  }
  return [...byFile.values()].sort((a, b) => (a.file ?? "").localeCompare(b.file ?? ""));
}

export async function runScribe(bundlePath: string, opts: ScribeOptions): Promise<AgentRunResult> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const now = opts.now ?? new Date();
  const patrolOpts: PatrolOptions = {
    policyDays: opts.policyDays ?? 90,
    journalDays: opts.journalDays ?? 30,
    now,
    memory: false,
  };
  const bundle = loadBundle(bundlePath);
  const findings = runChecks(bundle, patrolOpts);
  const clusters = clusterFindings(findings, opts.minSeverity ?? "MED");

  const bundleRoot = bundle.bundleRel === "" ? bundle.repoRoot : resolve(bundle.repoRoot, bundle.bundleRel);
  assertOutDirSafe(opts.outDir, bundleRoot, bundle.repoRoot, opts.allowInRepo ?? false, log);

  const result: AgentRunResult = { written: [], skippedExisting: [], failed: [], usageTotals: { input: 0, output: 0 } };
  if (clusters.length === 0) {
    log("scribe: nothing to draft - no findings at or above the severity threshold.");
    return result;
  }

  const ctx = bundleContext(bundle);
  const prepared = clusters.map((cluster) => {
    const concept = cluster.file ? (bundle.concepts.find((c) => c.path === cluster.file) ?? null) : null;
    const prompt = assembleScribePrompt(cluster, concept, ctx);
    // Id key deliberately excludes finding MESSAGES: staleness/journal messages embed
    // ageDays, which increments daily - keying on them would mint a fresh proposal every
    // day for the same rot. (file, sorted check set) = one open proposal per decision.
    const id = proposalIdFor("scribe", [
      cluster.file ?? "(bundle)",
      ...[...new Set(cluster.findings.map((f) => f.check))].sort(),
    ]);
    return { cluster, concept, prompt, id };
  });

  // Spend idempotency: skip clusters whose proposal already exists BEFORE calling
  // the API - file idempotency alone would still re-draft (and re-pay) every run.
  const pending = prepared.filter((p) => {
    if (opts.force) return true;
    if (proposalExists(opts.outDir, p.id)) {
      result.skippedExisting.push(proposalPath(opts.outDir, p.id));
      return false;
    }
    return true;
  });

  if (opts.dryRun) {
    for (const p of prepared) {
      log(`--- scribe cluster ${p.id} (${p.cluster.file ?? "bundle"}) - est ~${estimate(p.prompt.system + p.prompt.user)} input tokens`);
      log(`[system]\n${p.prompt.system}\n[user]\n${p.prompt.user}`);
    }
    log(`scribe --dry-run: ${prepared.length} cluster(s), zero API calls made.`);
    return result;
  }

  if (pending.length === 0) {
    log(`scribe: all ${prepared.length} cluster(s) already have pending proposals - nothing to draft, zero API calls.`);
    return result;
  }
  log(`scribe: ${pending.length} cluster(s) to draft (est ~${pending.reduce((n, p) => n + estimate(p.prompt.system + p.prompt.user), 0)} input tokens total).`);

  const settled = await runWithConcurrency(opts.concurrency ?? 3, pending.map((p) => async () => {
    const res = await createMessage(
      { system: p.prompt.system, user: p.prompt.user, schema: SCRIBE_SCHEMA, maxTokens: opts.maxTokens ?? 8192 },
      { apiKey: opts.apiKey, model: opts.model, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}), ...(opts.sleepFn ? { sleepFn: opts.sleepFn } : {}) },
    );
    assertShape(res.json, SCRIBE_RESPONSE_SPEC, `scribe:${p.id}`);
    const r = res.json as {
      kind: "amend" | "new-concept"; summary: string; rationale: string;
      frontmatterPatch: { key: string; value: string }[] | null; bodyDraft: string | null;
      journalLine: string; indexEntry: string | null; confidence: Confidence;
      evidenceQuotes: { file: string; quote: string }[]; needsHuman: boolean;
    };
    // Fields are listed explicitly, never spread from the model's reply: an extra `id`,
    // `target` or `checks` key in the JSON must not be able to override the deterministic ones.
    const draft: ProposalDraft = {
      id: p.id,
      target: p.cluster.file,
      kind: r.kind,
      summary: r.summary,
      rationale: r.rationale,
      bodyDraft: r.bodyDraft,
      indexEntry: r.indexEntry,
      confidence: r.confidence,
      evidenceQuotes: r.evidenceQuotes,
      needsHuman: r.needsHuman,
      frontmatterPatch: r.frontmatterPatch
        ? Object.fromEntries(r.frontmatterPatch.map((kv) => [kv.key, kv.value]))
        : null,
      journalLine: stampJournalLine(r.journalLine, p.id),
    };
    const prov = buildProvenance({
      agent: "scribe", model: opts.model, system: p.prompt.system, user: p.prompt.user,
      evidenceFiles: [p.cluster.file ?? "index.md"],
      ...(p.concept ? { reviewedSurfaceFiles: [{ path: p.concept.path, content: p.concept.content }] } : {}),
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }, now,
    });
    result.usageTotals.input += res.usage.input_tokens;
    result.usageTotals.output += res.usage.output_tokens;
    return writeProposal(opts.outDir, draft, prov, opts.force ?? false, { repoRoot: bundle.repoRoot, surfaceRoot: bundleRoot, agent: "scribe" });
  }));

  settled.forEach((s, i) => {
    const p = pending[i] as (typeof pending)[number];
    if (s.status === "fulfilled") {
      if (s.value.skipped) result.skippedExisting.push(s.value.path);
      else result.written.push(s.value.path);
    } else {
      result.failed.push({ cluster: p.id, error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
    }
  });
  log(`scribe: ${result.written.length} written, ${result.skippedExisting.length} skipped (existing), ${result.failed.length} failed. Usage: ${result.usageTotals.input}+${result.usageTotals.output} tokens.`);
  return result;
}

/** Sonnet-5 tokenizer heuristic (~3.2 chars/token). */
function estimate(s: string): number {
  return Math.ceil(s.length / 3.2);
}
