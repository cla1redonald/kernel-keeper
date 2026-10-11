import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { loadBundle } from "../core/bundle.js";
import { createMessage } from "./client.js";
import { assembleMineConsolidatePrompt, assembleMineExtractPrompt, bundleContext, MINE_CONSOLIDATE_SCHEMA, MINE_EXTRACT_SCHEMA } from "./prompts.js";
import { buildProvenance, proposalIdFor, stampJournalLine } from "./provenance.js";
import { assertOutDirSafe, listPendingProposals, writeProposal } from "./proposal.js";
import { assertShape } from "./validate.js";
import type { AgentRunResult, Confidence, ProposalDraft } from "./types.js";

/**
 * THE GAP-MINER: two-phase map-reduce over a corpus of working notes.
 * Map: per-chunk candidate truths (filtered against the concept inventory).
 * Reduce: one consolidation call → deduped, ranked new-concept proposals.
 */

const IGNORED_DIRS = new Set([".git", "node_modules", ".obsidian", "dist"]);

export interface CorpusFile { path: string; content: string; estTokens: number }
export interface CorpusChunk { files: { path: string; content: string }[]; estTokens: number }

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.2); // sonnet-5 tokenizer heuristic
}

/** Walk a corpus dir: .md/.txt files, symlinks skipped, sorted for determinism. */
export function loadCorpus(dir: string): CorpusFile[] {
  const root = resolve(dir);
  const out: CorpusFile[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith(".") || IGNORED_DIRS.has(entry)) continue;
      const abs = join(d, entry);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && (entry.endsWith(".md") || entry.endsWith(".txt"))) {
        let content: string;
        try {
          content = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        out.push({ path: relative(root, abs).split(sep).join("/"), content, estTokens: estimateTokens(content) });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Greedy whole-file bin-packing; an oversized file splits on ## headings, then paragraphs. */
export function chunkCorpus(files: CorpusFile[], budgetTokens: number): CorpusChunk[] {
  const atoms: { path: string; content: string; estTokens: number }[] = [];
  for (const f of files) {
    if (f.estTokens <= budgetTokens) {
      atoms.push(f);
      continue;
    }
    const sections = f.content.split(/\n(?=## )/);
    for (const [i, sec] of sections.entries()) {
      const t = estimateTokens(sec);
      if (t <= budgetTokens) {
        atoms.push({ path: `${f.path}#${i}`, content: sec, estTokens: t });
      } else {
        const paras = sec.split(/\n\n+/);
        let buf: string[] = [];
        let bufTokens = 0;
        let part = 0;
        for (const para of paras) {
          const pt = estimateTokens(para);
          if (bufTokens + pt > budgetTokens && buf.length > 0) {
            atoms.push({ path: `${f.path}#${i}.${part++}`, content: buf.join("\n\n"), estTokens: bufTokens });
            buf = [buf.at(-1) as string]; // one-paragraph overlap at split points
            bufTokens = estimateTokens(buf[0] as string);
          }
          buf.push(para);
          bufTokens += pt;
        }
        if (buf.length > 0) atoms.push({ path: `${f.path}#${i}.${part}`, content: buf.join("\n\n"), estTokens: bufTokens });
      }
    }
  }
  const chunks: CorpusChunk[] = [];
  let current: CorpusChunk = { files: [], estTokens: 0 };
  for (const a of atoms) {
    if (current.estTokens + a.estTokens > budgetTokens && current.files.length > 0) {
      chunks.push(current);
      current = { files: [], estTokens: 0 };
    }
    current.files.push({ path: a.path, content: a.content });
    current.estTokens += a.estTokens;
  }
  if (current.files.length > 0) chunks.push(current);
  return chunks;
}

export interface MineOptions {
  outDir: string;
  model: string;
  apiKey: string;
  chunkBudget?: number;
  maxCalls?: number;
  dryRun?: boolean;
  force?: boolean;
  allowInRepo?: boolean;
  maxTokens?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  now?: Date;
  log?: (msg: string) => void;
}

export async function runMine(corpusDir: string, bundlePath: string, opts: MineOptions): Promise<AgentRunResult> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const now = opts.now ?? new Date();
  const bundle = loadBundle(bundlePath);
  const bundleRoot = bundle.bundleRel === "" ? bundle.repoRoot : resolve(bundle.repoRoot, bundle.bundleRel);
  assertOutDirSafe(opts.outDir, bundleRoot, bundle.repoRoot, opts.allowInRepo ?? false, log);

  const result: AgentRunResult = { written: [], skippedExisting: [], failed: [], usageTotals: { input: 0, output: 0 } };
  const corpus = loadCorpus(corpusDir);
  if (corpus.length === 0) {
    log("gap-miner: corpus is empty (no .md/.txt files).");
    return result;
  }
  const corpusByPath = new Map(corpus.map((f) => [f.path, f.content]));
  const chunks = chunkCorpus(corpus, opts.chunkBudget ?? 50_000);
  const calls = chunks.length + 1; // map calls + one reduce
  const maxCalls = opts.maxCalls ?? 25;
  const inventory = bundleContext(bundle);

  log(`gap-miner: ${corpus.length} files → ${chunks.length} chunk(s) + 1 consolidation = ${calls} call(s); est ~${chunks.reduce((n, c) => n + c.estTokens, 0)} corpus tokens.`);
  if (calls > maxCalls) {
    log(`gap-miner: ${calls} calls exceeds --max-calls ${maxCalls} - aborting before any API spend.`);
    result.failed.push({ cluster: "(preflight)", error: `would need ${calls} calls > max-calls ${maxCalls}` });
    return result;
  }
  if (opts.dryRun) {
    const p0 = assembleMineExtractPrompt(chunks[0]?.files ?? [], inventory);
    log(`--- gap-miner map prompt (chunk 1 of ${chunks.length}):\n[system]\n${p0.system}\n[user]\n${p0.user}`);
    log(`gap-miner --dry-run: zero API calls made.`);
    return result;
  }

  const callOpts = { apiKey: opts.apiKey, model: opts.model, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}), ...(opts.sleepFn ? { sleepFn: opts.sleepFn } : {}) };
  // Map phase runs SEQUENTIALLY by design: the reduce needs every map result anyway
  // (no wall-clock win from finishing early), and serial calls are gentle on rate
  // limits for large corpora. Parallelise later only with evidence it matters.
  const candidates: unknown[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const prompt = assembleMineExtractPrompt(chunk.files, inventory);
    try {
      const res = await createMessage({ system: prompt.system, user: prompt.user, schema: MINE_EXTRACT_SCHEMA, maxTokens: opts.maxTokens ?? 16_384 }, callOpts);
      result.usageTotals.input += res.usage.input_tokens;
      result.usageTotals.output += res.usage.output_tokens;
      const payload = res.json as { candidates?: unknown[] };
      for (const c of payload.candidates ?? []) {
        const cand = c as { coveredByExistingConcept?: string | null };
        if (!cand.coveredByExistingConcept) candidates.push(c);
      }
    } catch (err) {
      result.failed.push({ cluster: `map-chunk-${i + 1}`, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (candidates.length === 0) {
    log(`gap-miner: no uncovered candidate truths found. Usage: ${result.usageTotals.input}+${result.usageTotals.output} tokens.`);
    return result;
  }

  // Pending proposals count as covered: without this, model-worded summaries make
  // every weekly run mint near-duplicates (E2E finding, 2026-07-14).
  const pendingList = listPendingProposals(opts.outDir, "gap-miner");
  const reducePrompt = assembleMineConsolidatePrompt(JSON.stringify(candidates, null, 1), inventory, pendingList);
  try {
    const res = await createMessage({ system: reducePrompt.system, user: reducePrompt.user, schema: MINE_CONSOLIDATE_SCHEMA, maxTokens: opts.maxTokens ?? 16_384 }, callOpts);
    result.usageTotals.input += res.usage.input_tokens;
    result.usageTotals.output += res.usage.output_tokens;
    const payload = res.json as { proposals?: unknown[] };
    for (const raw of payload.proposals ?? []) {
      assertShape(raw, {
        conceptPath: { kind: "string" }, summary: { kind: "string" }, rationale: { kind: "string" },
        bodyDraft: { kind: "string" }, journalLine: { kind: "string" }, indexEntry: { kind: "string" },
        confidence: { kind: "string", enum: ["low", "medium", "high"] }, evidenceQuotes: { kind: "quote-array" },
      }, "gap-miner:proposal");
      const r = raw as { conceptPath: string; summary: string; rationale: string; bodyDraft: string; journalLine: string; indexEntry: string; confidence: Confidence; evidenceQuotes: { file: string; quote: string }[] };
      // Id keys on the concept PATH alone - summaries are model-worded and vary
      // run to run; two proposals for the same concept path are the same decision.
      const id = proposalIdFor("gap-miner", [r.conceptPath]);
      const draft: ProposalDraft = {
        id,
        kind: "new-concept",
        target: r.conceptPath,
        summary: r.summary,
        rationale: r.rationale,
        frontmatterPatch: null,
        bodyDraft: r.bodyDraft,
        journalLine: stampJournalLine(r.journalLine, id),
        indexEntry: r.indexEntry,
        confidence: r.confidence,
        evidenceQuotes: r.evidenceQuotes,
        // Gap-miner drafts are complete concepts, not stubs - needsHuman is reserved
        // for drafts a human must finish authoring. Election is the human gate either way.
        needsHuman: false,
      };
      const prov = buildProvenance({
        agent: "gap-miner", model: opts.model, system: reducePrompt.system, user: reducePrompt.user,
        evidenceFiles: [...new Set(r.evidenceQuotes.map((e) => e.file))],
        reviewedSurfaceFiles: [...new Set(r.evidenceQuotes.map((e) => e.file))]
          .map((path) => {
            const content = corpusByPath.get(path);
            return content === undefined ? null : { path, content };
          })
          .filter((x): x is { path: string; content: string } => x !== null),
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }, now,
      });
      const w = writeProposal(opts.outDir, draft, prov, opts.force ?? false);
      if (w.skipped) result.skippedExisting.push(w.path);
      else result.written.push(w.path);
    }
  } catch (err) {
    result.failed.push({ cluster: "consolidate", error: err instanceof Error ? err.message : String(err) });
  }
  log(`gap-miner: ${result.written.length} written, ${result.skippedExisting.length} skipped, ${result.failed.length} failed. Usage: ${result.usageTotals.input}+${result.usageTotals.output} tokens.`);
  return result;
}
