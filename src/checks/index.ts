import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractLinks, extractSourceReceipts, isTextLikePath, resolveLink, resolveSourceReceipt } from "../core/bundle.js";
import { daysBetween, parseYyyyMmDd } from "../core/dates.js";
import { isActive, isRetired, lifecycleStatus, scalar, stringList, validStableId } from "../core/governance.js";
import type { Bundle, Check, Finding, PatrolOptions, Severity } from "../types.js";

const RESERVED = new Set(["index.md", "log.md"]);

/** Concept files that carry meaning (everything except OKF's reserved index/log). */
function meaningConcepts(bundle: Bundle) {
  return bundle.concepts.filter((c) => !RESERVED.has(c.bundlePath));
}

function conceptType(c: { frontmatter: { [k: string]: string | string[] } | null }): string {
  const t = c.frontmatter?.["type"];
  return typeof t === "string" ? t.toLowerCase() : "";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Newest dated entry in log.md content (`**YYYY-MM-DD**`), or null when undated. */
function newestJournalDate(logContent: string): string | null {
  const dates = [...logContent.matchAll(/\*\*(\d{4}-\d{2}-\d{2})\*\*/g)]
    .map((m) => m[1] as string)
    .filter((d) => parseYyyyMmDd(d).date !== null);
  return dates.length > 0 ? (dates.sort().at(-1) as string) : null;
}

/** 1 · Internal links that resolve to nothing. The single worst rot signal. */
export const danglingLinks: Check = (bundle) => {
  const findings: Finding[] = [];
  for (const c of bundle.concepts) {
    for (const l of c.links) {
      if (l.resolved !== null && bundle.repoFiles.has(l.resolved)) continue;
      findings.push({
        check: "dangling-links",
        severity: "HIGH",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: `Link \`${l.target}\` resolves to nothing`,
        hint: "Fix the path, or write the missing concept - an agent following this link gets silence.",
      });
    }
  }
  return findings;
};

/** 2 · Concepts nothing links to - unreachable knowledge. */
export const orphans: Check = (bundle) => {
  const inbound = new Set<string>();
  for (const c of bundle.concepts) {
    for (const l of c.links) if (l.resolved) inbound.add(l.resolved);
  }
  for (const d of bundle.definitions) {
    if (d.conceptRef) {
      // concept back-refs count as inbound links to the concept
      const resolved = resolveLink(d.conceptRef, d.path, bundle.bundleRel);
      if (resolved) inbound.add(resolved);
    }
  }
  return meaningConcepts(bundle)
    .filter((c) => !inbound.has(c.path))
    .map(
      (c): Finding => ({
        check: "orphans",
        severity: "LOW",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: "No other concept links here - agents can only find it by browsing",
        hint: "Link it from index.md or a related concept, or retire it.",
      }),
    );
};

/** 3 · Concepts missing from index.md - the progressive-disclosure map has a hole. */
export const indexCoverage: Check = (bundle) => {
  const index = bundle.concepts.find((c) => c.bundlePath === "index.md");
  if (!index) {
    return [
      {
        check: "index-coverage",
        severity: "HIGH",
        message: "index.md is missing - OKF's progressive-disclosure entry point",
        hint: "Create index.md linking every concept, grouped by folder.",
      },
    ];
  }
  const indexed = new Set(index.links.map((l) => l.resolved).filter((r): r is string => r !== null));
  return meaningConcepts(bundle)
    .filter((c) => !indexed.has(c.path))
    .map(
      (c): Finding => ({
        check: "index-coverage",
        severity: "LOW",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: "Not listed in index.md",
        hint: "Add it to the map so agents doing progressive disclosure can find it.",
      }),
    );
};

function meaningfulWords(text: string): string[] {
  return text
    .replace(/[`*_~()[\]#.,:;!?/\\|-]+/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => /[A-Za-z0-9]/.test(w));
}

function isFilenameLike(text: string): boolean {
  const t = text.trim();
  return /\.[A-Za-z0-9]{1,6}$/.test(t) || /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/i.test(t);
}

/** Memory mode · index.md should be useful as the cheap first read. */
export const indexLineQuality: Check = (bundle, opts) => {
  if (!opts.memory) return [];
  const index = bundle.concepts.find((c) => c.bundlePath === "index.md");
  if (!index) return [];

  const conceptPaths = new Set(meaningConcepts(bundle).map((c) => c.path));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const linkRe = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g;

  for (const line of index.content.split(/\r?\n/)) {
    linkRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(line)) !== null) {
      const linkText = (m[1] ?? "").trim();
      const rawTarget = m[2] ?? "";
      const resolved = resolveLink(rawTarget.split("#")[0] ?? rawTarget, index.path, bundle.bundleRel);
      if (!resolved || !conceptPaths.has(resolved) || seen.has(resolved)) continue;
      seen.add(resolved);

      const after = line.slice(m.index + m[0].length);
      const words = meaningfulWords(after);
      if (words.length >= 3) continue;

      const target = bundle.concepts.find((c) => c.path === resolved);
      const filenameLike = isFilenameLike(linkText);
      findings.push({
        check: "index-line-quality",
        severity: filenameLike ? "MED" : "LOW",
        file: index.path,
        ...(target?.owner ? { owner: target.owner } : {}),
        message: filenameLike
          ? `Index link \`${linkText}\` is filename-like and has no useful description`
          : `Index link \`${linkText || rawTarget}\` has no useful one-line description`,
        hint: "Add a short phrase after the link so index.md can work as the cheap first read.",
      });
    }
  }
  return findings;
};

/** Memory mode · explicit source receipts must resolve to local text-like evidence. */
export const claimReceipts: Check = (bundle, opts) => {
  if (!opts.memory) return [];
  const findings: Finding[] = [];
  for (const c of meaningConcepts(bundle)) {
    for (const raw of extractSourceReceipts(c.content)) {
      if (/^https?:\/\//i.test(raw)) continue;
      const resolved = resolveSourceReceipt(raw, c.path, bundle.bundleRel);
      if (!resolved) {
        findings.push({
          check: "claim-receipts",
          severity: "MED",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `Source receipt \`${raw}\` resolves outside the loaded surface`,
          hint: "Point receipts at local text-like evidence inside the governed repo surface.",
        });
        continue;
      }
      if (!bundle.repoFiles.has(resolved)) {
        findings.push({
          check: "claim-receipts",
          severity: "MED",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `Source receipt \`${raw}\` points at no local text-like evidence file`,
          hint: "Fix the receipt path, or add the missing evidence file.",
        });
        continue;
      }
      if (!isTextLikePath(resolved)) {
        findings.push({
          check: "claim-receipts",
          severity: "LOW",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `Source receipt \`${raw}\` points at a binary/media file`,
          hint: "Use text-like evidence for claim receipts; keep media links as ordinary context.",
        });
      }
    }
  }
  return findings;
};

/** Memory mode · dated overviews make the age of readable memory visible. */
export const datedOverview: Check = (bundle, opts) => {
  if (!opts.memory) return [];
  const findings: Finding[] = [];
  const overviewRe = /\bAs of\s+(\d{4}-\d{2}-\d{2})\b/i;
  for (const c of meaningConcepts(bundle)) {
    const m = c.content.match(overviewRe);
    if (!m?.[1]) continue;
    const parsed = parseYyyyMmDd(m[1]);
    if (!parsed.date) {
      findings.push({
        check: "dated-overview",
        severity: "MED",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: `Overview date \`${m[1]}\` is not a valid YYYY-MM-DD date`,
        hint: "Use a real calendar date in the overview so the memory's age is visible.",
      });
    } else if (daysBetween(opts.now, parsed.date) < 0) {
      findings.push({
        check: "dated-overview",
        severity: "MED",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: `Overview date \`${parsed.yyyyMmDd}\` is in the future`,
        hint: "Correct the overview date; future-dated memory makes stale content look fresh.",
      });
    }
  }
  return findings;
};

function generatedSourcePath(bundle: Bundle, fromPath: string, raw: string): string | null {
  if (bundle.repoFiles.has(raw)) return raw;
  const candidate = raw.startsWith("/") ? raw : `/${raw}`;
  return resolveLink(candidate, fromPath, bundle.bundleRel) ?? resolveLink(raw, fromPath, bundle.bundleRel);
}

/** Memory mode · generated artifacts are caches and must point back to source. */
export const derivedArtifacts: Check = (bundle, opts) => {
  if (!opts.memory) return [];
  const findings: Finding[] = [];
  for (const c of meaningConcepts(bundle)) {
    const artifactKind = scalar(c.frontmatter, "artifact-kind");
    const generatedAt = scalar(c.frontmatter, "generated-at");
    const generatedFrom = stringList(c.frontmatter, "generated-from");
    const generatedLike = artifactKind === "cache" || generatedAt !== null || generatedFrom.length > 0;
    if (!generatedLike) continue;

    if (generatedFrom.length === 0) {
      findings.push({
        check: "derived-artifacts",
        severity: "MED",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: "Generated artifact has no `generated-from:` provenance",
        hint: "Declare the checked-in source file(s) this cache can be regenerated from.",
      });
      continue;
    }

    for (const raw of generatedFrom) {
      const resolved = generatedSourcePath(bundle, c.path, raw);
      if (!resolved || !bundle.repoFiles.has(resolved)) {
        findings.push({
          check: "derived-artifacts",
          severity: "MED",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `Generated artifact source \`${raw}\` resolves to nothing`,
          hint: "Fix `generated-from:` so this cache has an inspectable source of truth.",
        });
      }
    }
  }
  return findings.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? ""));
};

function isArchivePath(bundlePath: string): boolean {
  return bundlePath === "archive" || bundlePath.startsWith("archive/");
}

/** Memory mode · archived memory stays visible, but must be deliberate. */
export const archiveLifecycle: Check = (bundle, opts) => {
  if (!opts.memory) return [];
  const findings: Finding[] = [];
  for (const c of meaningConcepts(bundle)) {
    const status = lifecycleStatus(c.frontmatter);
    if (isArchivePath(c.bundlePath) && status !== "archived") {
      findings.push({
        check: "archive-lifecycle",
        severity: "MED",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: "Item lives under `archive/` but has no archive lifecycle metadata",
        hint: "Add `status: archived` when the location is intentionally historical.",
      });
    }
    if (status === "archived" && !scalar(c.frontmatter, "archive-note")) {
      findings.push({
        check: "archive-lifecycle",
        severity: "LOW",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: "Archived item has no `archive-note:`",
        hint: "Add a short note explaining why this memory is preserved instead of retired or superseded.",
      });
    }
  }
  const order: Record<Severity, number> = { HIGH: 0, MED: 1, LOW: 2 };
  return findings.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || order[a.severity] - order[b.severity]);
};

function isRestrictedCompartment(value: string | null): boolean {
  return !!value && !["public", "open", "none"].includes(value.toLowerCase());
}

function isGeneratedLike(c: Bundle["concepts"][number]): boolean {
  const artifactKind = scalar(c.frontmatter, "artifact-kind")?.toLowerCase();
  return artifactKind === "cache" || artifactKind === "index" || artifactKind === "export" ||
    scalar(c.frontmatter, "generated-at") !== null || stringList(c.frontmatter, "generated-from").length > 0;
}

function isPublicGeneratedCopy(c: Bundle["concepts"][number]): boolean {
  const visibility = scalar(c.frontmatter, "visibility")?.toLowerCase();
  const audience = scalar(c.frontmatter, "audience")?.toLowerCase();
  return isGeneratedLike(c) && (visibility === "public" || audience === "public");
}

/** Memory mode · generated public copies must preserve compartment boundaries. */
export const compartmentBoundaries: Check = (bundle, opts) => {
  if (!opts.memory) return [];
  const concepts = meaningConcepts(bundle);
  const restricted = new Map(
    concepts
      .map((c) => [c.path, scalar(c.frontmatter, "compartment")] as const)
      .filter(([, compartment]) => isRestrictedCompartment(compartment)),
  );
  if (restricted.size === 0) return [];

  const findings: Finding[] = [];
  for (const c of concepts) {
    const redacted = scalar(c.frontmatter, "redacted-view");
    if (redacted) {
      const resolved = resolveLink(redacted, c.path, bundle.bundleRel);
      if (!resolved || !bundle.repoFiles.has(resolved)) {
        findings.push({
          check: "compartment-boundaries",
          severity: "HIGH",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `\`redacted-view: ${redacted}\` points at no known safe file`,
          hint: "Point `redacted-view:` at a local public-safe markdown file.",
        });
      }
    }

    if (!isPublicGeneratedCopy(c)) continue;
    const linkedRestricted = c.links.map((l) => l.resolved).filter((p): p is string => !!p && restricted.has(p));
    if (linkedRestricted.length === 0) continue;
    findings.push({
      check: "compartment-boundaries",
      severity: "MED",
      file: c.path,
      ...(c.owner ? { owner: c.owner } : {}),
      message: `Public generated artifact links restricted item(s): ${[...new Set(linkedRestricted)].map((p) => `\`${p}\``).join(", ")}`,
      hint: "Use redacted views for public copies, or keep the generated artifact out of public scope.",
    });
    if (!scalar(c.frontmatter, "compartment-labels")) {
      findings.push({
        check: "compartment-boundaries",
        severity: "MED",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: "Public generated artifact omits `compartment-labels:` while linking compartmented items",
        hint: "Declare how compartment labels are preserved in the generated copy.",
      });
    }
  }
  return findings.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || a.message.localeCompare(b.message));
};

function retrievalLogPath(bundle: Bundle): string | null {
  for (const c of bundle.concepts) {
    const raw = scalar(c.frontmatter, "retrieval-log");
    if (!raw) continue;
    const resolved = resolveLink(raw, c.path, bundle.bundleRel);
    return resolved && bundle.repoFiles.has(resolved) ? resolved : raw;
  }
  return null;
}

function recallPaths(content: string): string[] {
  const linked = extractLinks(content);
  const bare = [...content.matchAll(/(?:^|\s)((?:bundle\/)?[\w./-]+\.(?:md|txt|csv|json|ya?ml))(?:\s|$)/g)]
    .map((m) => m[1] as string);
  return [...linked, ...bare];
}

/** Memory mode · optional retrieval logs provide weak evidence that indexed memory is findable. */
export const recallEvidence: Check = (bundle, opts) => {
  if (!opts.memory) return [];
  const rawLogPath = retrievalLogPath(bundle);
  if (!rawLogPath || !bundle.repoFiles.has(rawLogPath)) return [];

  let content = "";
  try {
    content = readFileSync(join(bundle.repoRoot, rawLogPath), "utf8");
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  const retrieved = recallPaths(content)
    .map((raw) => {
      if (bundle.repoFiles.has(raw)) return raw;
      const candidate = raw.startsWith("/") ? raw : `/${raw}`;
      return resolveLink(candidate, rawLogPath, bundle.bundleRel) ?? resolveLink(raw, rawLogPath, bundle.bundleRel);
    })
    .filter((p): p is string => !!p);
  const retrievedSet = new Set(retrieved.filter((p) => bundle.repoFiles.has(p)));
  for (const p of uniqueSorted(retrieved.filter((p) => !bundle.repoFiles.has(p)))) {
    findings.push({
      check: "recall-evidence",
      severity: "MED",
      file: rawLogPath,
      message: `Recall log references missing file \`${p}\``,
      hint: "Fix the retrieval log path, or restore the referenced registered item.",
    });
  }

  const index = bundle.concepts.find((c) => c.bundlePath === "index.md");
  for (const target of uniqueSorted(index?.links.map((l) => l.resolved).filter((p): p is string => !!p && !RESERVED.has(p)) ?? [])) {
    if (retrievedSet.has(target)) continue;
    findings.push({
      check: "recall-evidence",
      severity: "LOW",
      file: target,
      message: "Indexed concept is not retrieved in the configured recall log",
      hint: "If this remains unused across a real window, improve index wording or remove stale memory.",
    });
  }

  const counts = new Map<string, number>();
  for (const p of retrieved) {
    if (retrievedSet.has(p)) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  for (const c of meaningConcepts(bundle)) {
    if ((counts.get(c.path) ?? 0) < 2 || !isGeneratedLike(c)) continue;
    const source = stringList(c.frontmatter, "generated-from").find((raw) => {
      const resolved = resolveLink(raw, c.path, bundle.bundleRel);
      return resolved && bundle.repoFiles.has(resolved);
    });
    if (!source) continue;
    findings.push({
      check: "recall-evidence",
      severity: "LOW",
      file: c.path,
      ...(c.owner ? { owner: c.owner } : {}),
      message: "Recall log repeatedly lands on a derived artifact while source material is available",
      hint: "Point retrieval at the source concept when it is the canonical memory.",
    });
  }
  return findings.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || a.message.localeCompare(b.message));
};

/** 4 · Frontmatter conformance - `type` is the one OKF-required key. */
export const frontmatter: Check = (bundle, opts) => {
  const findings: Finding[] = [];
  for (const c of meaningConcepts(bundle)) {
    if (!c.frontmatter) {
      findings.push({
        check: "frontmatter",
        severity: "HIGH",
        file: c.path,
        message: "No frontmatter block",
        hint: "Add `---` frontmatter with at least `type:` - it's the one OKF-required key.",
      });
      continue;
    }
    if (!c.frontmatter["type"]) {
      findings.push({
        check: "frontmatter",
        severity: "HIGH",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: "Frontmatter is missing `type` (the one OKF-required key)",
        hint: "Add `type: Metric|Process|Runbook|Reference|Glossary Term|...`.",
      });
    }
    for (const key of ["title", "description", "timestamp"] as const) {
      if (!c.frontmatter[key]) {
        findings.push({
          check: "frontmatter",
          severity: "LOW",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `Frontmatter is missing \`${key}\``,
          hint: `Add ${key} - agents use it for relevance and staleness.`,
        });
      }
    }
    for (const key of ["timestamp", "last-affirmed"] as const) {
      const raw = c.frontmatter[key];
      if (raw === undefined) continue;
      const parsed = parseYyyyMmDd(raw);
      if (!parsed.date) {
        findings.push({
          check: "frontmatter",
          severity: "MED",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `Frontmatter \`${key}\` is not a valid YYYY-MM-DD date`,
          hint: "Use a real calendar date so staleness and journal checks cannot silently skip it.",
        });
      } else if (daysBetween(opts.now, parsed.date) < 0) {
        findings.push({
          check: "frontmatter",
          severity: "MED",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `Frontmatter \`${key}\` is in the future (${parsed.yyyyMmDd})`,
          hint: "Correct the date; future affirmations make stale content look fresh.",
        });
      }
    }
  }
  return findings;
};

/** 5 · Staleness - concepts past the affirm-or-amend policy window. */
export const staleness: Check = (bundle, opts) => {
  const findings: Finding[] = [];
  for (const c of meaningConcepts(bundle)) {
    if (isRetired(c.frontmatter)) continue;
    const raw = c.frontmatter?.["last-affirmed"] ?? c.frontmatter?.["timestamp"];
    const parsed = parseYyyyMmDd(raw);
    if (!parsed.date || daysBetween(opts.now, parsed.date) < 0) continue; // frontmatter check owns this
    const ageDays = daysBetween(opts.now, parsed.date);
    if (ageDays > opts.policyDays) {
      findings.push({
        check: "staleness",
        severity: "MED",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: `Last affirmed ${ageDays} days ago (policy: ${opts.policyDays})`,
        hint: "Affirm or amend: re-read, fix what moved, bump the date.",
      });
    }
  }
  return findings;
};

/**
 * 6 · Ownerless concepts. Metrics/processes/runbooks/references NEED a named owner (MED);
 * glossary terms inherit bundle ownership (LOW) so a real bundle isn't a noise storm.
 */
export const ownerless: Check = (bundle) => {
  const findings: Finding[] = [];
  for (const c of meaningConcepts(bundle)) {
    if (isRetired(c.frontmatter)) continue;
    if (c.owner) continue;
    const t = conceptType(c);
    const isGlossary = t.includes("glossary");
    findings.push({
      check: "ownerless",
      severity: isGlossary ? "LOW" : "MED",
      file: c.path,
      message: isGlossary
        ? "Glossary term has no named owner (inherits bundle ownership)"
        : "No resolvable owner - nobody is accountable for this being true",
      hint: isGlossary
        ? "Optional: name an owning team in frontmatter if the term is contested."
        : "Add an **Owner.** line or `owner:` frontmatter - ownership is the kernel's whole point.",
    });
  }
  return findings;
};

/** Optional stable IDs - validate when present, do not force a migration. */
export const stableIds: Check = (bundle) => {
  const findings: Finding[] = [];
  const byId = new Map<string, string[]>();
  for (const c of meaningConcepts(bundle)) {
    const id = scalar(c.frontmatter, "id");
    if (!id) continue;
    if (!validStableId(id)) {
      findings.push({
        check: "stable-ids",
        severity: "MED",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: "Frontmatter `id` is not a valid stable token",
        hint: "Use only letters, numbers, `.`, `_`, `-`, and `:`.",
      });
      continue;
    }
    const paths = byId.get(id) ?? [];
    paths.push(c.path);
    byId.set(id, paths);
  }
  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    for (const p of paths) {
      const other = paths.find((x) => x !== p) as string;
      const c = bundle.concepts.find((x) => x.path === p);
      findings.push({
        check: "stable-ids",
        severity: "HIGH",
        file: p,
        ...(c?.owner ? { owner: c.owner } : {}),
        message: `Duplicate \`id: ${id}\` also used by \`${other}\``,
        hint: "IDs make references rename-proof only when each active identity is unique.",
      });
    }
  }
  return findings;
};

/** Supersession lifecycle integrity for bundle concepts. */
export const supersessionIntegrity: Check = (bundle) => {
  const findings: Finding[] = [];
  const concepts = meaningConcepts(bundle);
  const byId = new Map<string, string>();
  const byPath = new Map<string, (typeof concepts)[number]>();
  for (const c of concepts) {
    byPath.set(c.path, c);
    const id = scalar(c.frontmatter, "id");
    if (id) byId.set(id, c.path);
  }
  const resolvesTarget = (raw: string, fromPath: string): string | null => {
    if (byId.has(raw)) return byId.get(raw) as string;
    if (byPath.has(raw)) return raw;
    const resolved = resolveLink(raw, fromPath, bundle.bundleRel);
    return resolved && byPath.has(resolved) ? resolved : null;
  };

  const supersededPaths = new Set(concepts.filter((c) => lifecycleStatus(c.frontmatter) !== "active").map((c) => c.path));
  for (const c of concepts) {
    const status = lifecycleStatus(c.frontmatter);
    if (status === "superseded") {
      const raw = scalar(c.frontmatter, "superseded-by");
      if (!raw) {
        findings.push({
          check: "supersession-integrity",
          severity: "HIGH",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: "`status: superseded` requires `superseded-by:`",
          hint: "Point to the replacement by stable `id:` or path.",
        });
      } else if (!resolvesTarget(raw, c.path)) {
        findings.push({
          check: "supersession-integrity",
          severity: "HIGH",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `\`superseded-by: ${raw}\` points at no known item`,
          hint: "Use a known stable `id:` or resolvable path.",
        });
      }
    }
    if (isActive(c.frontmatter) && !scalar(c.frontmatter, "supersession-note")) {
      for (const l of c.links) {
        if (!l.resolved || !supersededPaths.has(l.resolved)) continue;
        findings.push({
          check: "supersession-integrity",
          severity: "MED",
          file: c.path,
          ...(c.owner ? { owner: c.owner } : {}),
          message: `Active item links to ${lifecycleStatus(byPath.get(l.resolved)?.frontmatter)} \`${l.resolved}\` without \`supersession-note:\``,
          hint: "Either link the replacement, or add `supersession-note:` explaining why the historical link remains.",
        });
      }
    }
  }

  const superseders = new Map<string, string[]>();
  for (const c of concepts) {
    if (!isActive(c.frontmatter)) continue;
    for (const raw of stringList(c.frontmatter, "supersedes")) {
      const target = resolvesTarget(raw, c.path) ?? raw;
      const paths = superseders.get(target) ?? [];
      paths.push(c.path);
      superseders.set(target, paths);
    }
  }
  for (const [target, paths] of superseders) {
    if (paths.length < 2) continue;
    const [first] = paths;
    if (!first) continue;
    const c = first ? byPath.get(first) : undefined;
    findings.push({
      check: "supersession-integrity",
      severity: "MED",
      file: first,
      ...(c?.owner ? { owner: c.owner } : {}),
      message: `\`${target}\` is superseded by multiple active items: ${paths.map((p) => `\`${p}\``).join(" · ")}`,
      hint: "Keep one active replacement claim, or split the superseded item into separate identities.",
    });
  }
  return findings;
};

/** 7 · The journal - change history is the audit trail; a silent journal means a dead register. */
export const journal: Check = (bundle, opts) => {
  const log = bundle.concepts.find((c) => c.bundlePath === "log.md");
  if (!log) {
    return [
      {
        check: "journal",
        severity: "HIGH",
        message: "log.md is missing - no change journal",
        hint: "Create log.md and date-stamp every change: who, what, when.",
      },
    ];
  }
  const latest = newestJournalDate(log.content);
  if (latest === null) {
    return [
      {
        check: "journal",
        severity: "MED",
        file: log.path,
        message: "log.md has no dated entries",
        hint: "Journal entries need dates: `- **YYYY-MM-DD** - what changed`.",
      },
    ];
  }
  const parsedLatest = parseYyyyMmDd(latest);
  const ageDays = parsedLatest.date ? daysBetween(opts.now, parsedLatest.date) : 0;
  if (ageDays > opts.journalDays) {
    return [
      {
        check: "journal",
        severity: "MED",
        file: log.path,
        message: `Last journal entry is ${ageDays} days old (policy: ${opts.journalDays})`,
        hint: "Either nothing changed (affirm it in the log) or changes are bypassing the journal.",
      },
    ];
  }
  return [];
};

/** 8 · Pointer integrity - definitions and their concepts must reference each other both ways. */
export const pointerIntegrity: Check = (bundle) => {
  const findings: Finding[] = [];
  const conceptPaths = new Set(bundle.concepts.map((c) => c.path));
  const referencedDefs = new Set<string>();
  for (const c of bundle.concepts) {
    for (const l of c.links) {
      if (l.resolved && (l.resolved.endsWith(".yml") || l.resolved.endsWith(".yaml"))) {
        referencedDefs.add(l.resolved);
      }
    }
  }
  for (const d of bundle.definitions) {
    if (d.conceptRef) {
      const resolved = resolveLink(d.conceptRef, d.path, bundle.bundleRel);
      if (resolved === null || !conceptPaths.has(resolved)) {
        findings.push({
          check: "pointer-integrity",
          severity: "HIGH",
          file: d.path,
          ...(d.owner ? { owner: d.owner } : {}),
          message: `Definition back-reference \`${d.conceptRef}\` points at no concept`,
          hint: "Fix the concept path - a definition without its concept is a number without meaning.",
        });
      }
    } else {
      findings.push({
        check: "pointer-integrity",
        severity: "MED",
        file: d.path,
        ...(d.owner ? { owner: d.owner } : {}),
        message: "Definition has no `concept:` back-reference",
        hint: "Point it at its concept file so agents can walk definition → meaning.",
      });
    }
    if (!referencedDefs.has(d.path)) {
      findings.push({
        check: "pointer-integrity",
        severity: "LOW",
        file: d.path,
        ...(d.owner ? { owner: d.owner } : {}),
        message: "No concept links to this definition",
        hint: "Reference it from the concept's Formula line, or retire it.",
      });
    }
  }
  return findings;
};

/**
 * 9 · Unjournalled change - a concept dated after the journal's newest entry:
 * the direct tripwire for edits that bypassed the loop. Uses frontmatter dates
 * (not mtime - clone-safe). Missing/undated journals belong to the journal check.
 */
export const unjournalledChange: Check = (bundle, opts) => {
  const log = bundle.concepts.find((c) => c.bundlePath === "log.md");
  if (!log) return [];
  const newest = newestJournalDate(log.content);
  if (newest === null) return [];
  const findings: Finding[] = [];
  for (const c of meaningConcepts(bundle)) {
    const raw = c.frontmatter?.["last-affirmed"] ?? c.frontmatter?.["timestamp"];
    const parsed = parseYyyyMmDd(raw);
    if (!parsed.date || !parsed.yyyyMmDd || daysBetween(opts.now, parsed.date) < 0) continue;
    const d = parsed.yyyyMmDd;
    if (d > newest) {
      findings.push({
        check: "unjournalled-change",
        severity: "MED",
        file: c.path,
        ...(c.owner ? { owner: c.owner } : {}),
        message: `Dated ${d}, but the journal's newest entry is ${newest} - this change bypassed the journal`,
        hint: "Add a log.md entry for the change (who, what, why) - or correct the concept's date.",
      });
    }
  }
  return findings;
};

export const ALL_CHECKS: Check[] = [
  danglingLinks,
  orphans,
  indexCoverage,
  indexLineQuality,
  claimReceipts,
  datedOverview,
  derivedArtifacts,
  archiveLifecycle,
  compartmentBoundaries,
  recallEvidence,
  frontmatter,
  stableIds,
  supersessionIntegrity,
  staleness,
  ownerless,
  journal,
  pointerIntegrity,
  unjournalledChange,
];

export function runChecks(bundle: Bundle, opts: PatrolOptions): Finding[] {
  const findings: Finding[] = [];
  for (const check of ALL_CHECKS) {
    try {
      findings.push(...check(bundle, opts));
    } catch (err) {
      findings.push({
        check: "keeper-internal",
        severity: "LOW",
        message: `A check crashed and was skipped: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Report this to kernel-keeper - checks should never throw.",
      });
    }
  }
  const order: Record<Severity, number> = { HIGH: 0, MED: 1, LOW: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));
}
