# Design note: Wiki Memory Invariants

*Design note. This records why the feature is shaped the way it is, and was written while it was being built. The current behaviour is described in [../checks.md](../checks.md), [../memory-doctrine.md](../memory-doctrine.md) and [../ai-layer.md](../ai-layer.md); version numbers refer to [CHANGELOG.md](../../CHANGELOG.md).*

## Source Inspiration

Fabijan Bajo's "Agent Memory Wants a Wiki, Not a Vector Store" sharpens a direction Kernel Keeper already has: memory should be a readable, linked, dated register. Retrieval is cheap index first, then a few full pages. Trust comes from claims with receipts, visible supersession, and consolidation paid at write time instead of fuzzy retrieval paid at every query.

Argus and Bruce Stephenson's "What Breaks When You Run Agent Memory" adds the operating failure modes: derived artifacts masquerading as source, archive-by-moving becoming deletion, success exits that prove nothing, multiple canonical stores, indexes that bypass access boundaries, and the absence of integrity monitors. Kernel Keeper should absorb those as memory-governance checks: verify effects, distinguish source from cache, make archive a state, and govern every derived copy.

Kernel Keeper should absorb that as patrolable invariants, not as a vector-search feature.

## Doctrine

The doctrine is deliberately small:

- Canonical memory is readable markdown in the governed surface.
- Retrieval starts with an index, then reads full pages.
- Every derived representation is a cache with provenance, not a second source of truth.
- Archive is a lifecycle state, not disappearance.
- Successful maintenance means the register still verifies, not merely that a command returned `0`.
- AI can draft proposals, but deterministic checks decide what is eligible for a human to sign or a clerk to apply.

## Goal

Make Kernel Keeper explicitly protect wiki-memory quality:

- `index.md` is the cheap first read, not just a list of links.
- Concept pages say what is currently believed, when it was affirmed, and why.
- Claims can carry source receipts.
- Superseded claims stay visible with pointers to replacements.
- Raw/source evidence can be governed separately from synthesized concepts.
- Derived artifacts are treated as caches, never canonical source.
- Archive is a lifecycle state, not a move out of the read path.
- Memory upkeep is verified by effect checks, not command success.
- Any search/index/cache copy obeys the same boundaries as the source register.

## Non-Goals

- No embeddings.
- No vector store.
- No hidden retrieval layer.
- No automated deletion of old claims.
- No network fetching in this batch; that belongs to the network-backed drift roadmap item.
- No access-control engine in this batch. The plan can prepare boundary metadata and checks, but not implement a full permissions system.

## Proposed Conventions

### Index Lines

Every concept linked from `index.md` should have a one-line description in the link text or immediately following prose:

```md
- [Consent lifecycle](/processes/consent-lifecycle.md) - how consent state changes from connection through revocation.
```

This makes `index.md` the cheap retrieval layer: one read tells an agent what exists and where to drill down.

### Dated Overview

Concept pages should open with a dated overview sentence:

```md
As of 2026-07-20, consent lifecycle names the governed state model for customer consent from creation through expiry, revocation, and re-authentication.
```

This complements `timestamp:` and `last-affirmed:` by putting the date into the text an agent actually reads.

### Claim Receipts

Important factual claims may carry inline source receipts:

```md
- Re-authentication prompts should be measured separately from first-time consent prompts. [source: sources/reauth-analysis.md#L42]
```

For transcript-like sources, timestamp anchors are allowed:

```md
- Users described bank reconnection as a trust event, not a settings chore. [source: sources/interviews/raw-2026-07-02.md@12:35]
```

Receipts should point to local text-like files first. External URLs can be supported later by network-backed drift.

### Visible Supersession

Superseded claims should remain legible instead of disappearing:

```md
- ~~Screen scraping is the primary fallback for unsupported banks. [source: sources/legacy-connectivity.md#L18]~~
  Superseded 2026-07-20 by [open finance fallback policy](/processes/open-finance-fallback.md).
```

This body convention complements frontmatter `status: superseded`, `superseded-by:`, `supersedes:`, and `supersession-note:`.

### Source Layer

Bundles may contain `sources/` or `raw/` folders for evidence material:

```text
bundle/
  index.md
  facts/
  processes/
  sources/
    interviews/
    analyses/
  raw/
```

Source files are not necessarily concepts. They are evidence. Patrol should distinguish "not indexed" from "not meant to be indexed."

### Derived Artifacts

Generated files should say they are generated and where they come from:

```yaml
generated-from: bundle/index.md
generated-at: 2026-07-20T09:00:00Z
artifact-kind: cache
```

Derived artifacts should never be used as the only source of truth. If an artifact cannot be regenerated from checked-in source files, it is not a cache; it is source and should be governed like source.

Multiple canonical stores are a patrol smell. If both a markdown page and a generated JSON/search/index copy claim to be authoritative, Kernel Keeper should make one of them declare itself as derived or report the ambiguity.

### Archive State

Archived memories should remain in the read path with lifecycle metadata:

```yaml
status: archived
archived-at: 2026-07-20
archive-note: Replaced by the consolidated consent lifecycle concept.
```

Moving a file to `archive/` may be a storage convention, but it must not be the only signal. A patrol must be able to distinguish "de-emphasized" from "invisible."

### Compartment Hints

Kernel Keeper should leave room for future compartmentation without becoming an access-control system in this batch:

```yaml
compartment: public
```

or:

```yaml
compartment: restricted
redacted-view: facts/customer-research-redacted.md
```

The immediate value is not enforcement. It is avoiding accidental flattening: if a future index, search cache, or export includes restricted material without carrying the compartment label, patrol should be able to flag it.

### Recall Logs

Longer term, agent memory should leave enough retrieval evidence for patrol to learn where recall failed:

```yaml
retrieval-log: logs/recall/2026-07-20.md
```

This is not an analytics feature in the first batch. It is a future hook for checking that the cheap index actually routes agents to the pages they need, and for finding important pages that are never retrieved.

## Implementation Batch

### Phase 1: Documentation and Fixture

- Add a README section naming the wiki-memory doctrine:
  - cheap index first
  - full-page drilldown
  - dated overview
  - claim receipts
  - visible supersession
- Add a fixture bundle that demonstrates the conventions.
- Keep every convention optional in phase 1 except where existing checks already enforce it.

### Phase 2: Index Line Quality Check

Add a bundle check:

```text
index-line-quality
```

Findings:

- LOW: indexed concept link has no useful one-line description.
- LOW: duplicate or near-empty index descriptions.
- MED: index link text is only a filename-like label when the target title/description would be more informative.

Rules should be deterministic and conservative. This check should not become a prose-quality critic.

### Phase 3: Dated Overview Check

Add a bundle check:

```text
dated-overview
```

Findings:

- LOW: concept body does not start with an `As of YYYY-MM-DD, ...` overview sentence.
- MED: overview date is invalid or future-dated.
- MED: overview date is older than `last-affirmed:` or `timestamp:` in a way that implies stale prose.

Retired items should be quiet. Superseded items may use a supersession sentence instead.

### Phase 4: Claim Receipt Check

Add a bundle check:

```text
claim-receipts
```

Initial deterministic scope:

- Only inspect markdown bullets in meaning concepts.
- Recognize `[source: path]`, `[source: path#anchor]`, and `[source: path@timestamp]`.
- Resolve local source paths using existing bundle link semantics.
- Ignore external URLs in v1.

Findings:

- MED: source receipt points to no local text file.
- LOW: important-looking bullet has no receipt, where "important-looking" is limited to bullets containing decision words such as `must`, `should`, `policy`, `owner`, `threshold`, `SLO`, or `metric`.

The LOW heuristic must be conservative and easy to disable if noisy.

### Phase 5: Source Layer Semantics

Teach patrol that `sources/` and `raw/` files are evidence files:

- They should be valid local text-like files.
- They should not create `index-coverage` findings by default.
- They can be referenced by drift and claim receipt checks.
- They can have optional frontmatter, but should not require concept `type:`.

This prevents raw evidence from becoming a noise storm while still letting Kernel Keeper validate references into it.

### Phase 6: Drift Integration

Extend `kernel-keeper drift` job construction:

- Prefer explicit claim receipts and `source:` frontmatter when present.
- Continue falling back to resolved outbound local links.
- Include receipt paths in proposal evidence.
- Label proposals with relevant checks, for example `checks: [semantic-drift, claim-receipts]` when drift arises from sourced claims.

### Phase 7: Derived Artifact Integrity

Add checks that protect the "source vs cache" boundary:

```text
derived-artifacts
```

Findings:

- MED: generated artifact lacks `generated-from:` or equivalent provenance.
- MED: generated artifact points at a missing source.
- HIGH: a configured loader reads from a generated artifact when the source files are present.
- HIGH: a generated artifact is newer than source but cannot be regenerated by any documented command.

This is the Kernel Keeper version of "derived is cache, never food."

### Phase 8: Archive State Check

Shipped in v0.9c for bundle memory mode:

- `status: archived` is a lifecycle state.
- Archived items are excluded from staleness and ownerless noise, like retired items.
- Active links to archived items are handled by supersession integrity and require `supersession-note:`.

Add lifecycle support for:

```yaml
status: archived
```

Findings:

- LOW: archived item has no `archive-note:`.
- MED: item lives under an `archive/` path but has no archive lifecycle metadata.
- HIGH: archived item is removed from all indexes and has no replacement or retrieval path.

This makes archive a governed state, not accidental de-indexing.

### Phase 9: Effect Verification and Damage Meter

Shipped in v0.9d as a local baseline verifier, then extended with generator hooks and archive retrieval continuity:

- `--write-baseline` captures the governed surface before maintenance work.
- `--baseline` compares the current surface with that prior baseline.
- Missing or changed registered items and newly unresolvable evidence/path references contribute to the damage fraction.
- Repeatable `--generator <command>` hooks run before snapshot/compare without shell syntax.
- Archived items that had retrieval paths in the baseline contribute damage when they lose every current retrieval path and have no replacement or archive note.

The local verification mode checks whether maintenance actions have the intended effect:

```bash
kernel-keeper verify <bundle-or-estate-root> --baseline .kernel-keeper-baseline.json
```

Checks:

- Run explicit generators when requested, then reload and compare expected item counts.
- Confirm every source-backed concept still has resolvable evidence.
- Measure a "damage fraction": changed, missing, or newly unresolvable registered items divided by prior registered items.
- Refuse or exit non-zero when damage exceeds a configured threshold.

This should be deterministic. A successful exit from a generator is not evidence; the register surviving the generator is evidence.

The verification report should make the damage fraction visible even when it is below the failure threshold. A quiet slow drift is still useful evidence for the next patrol policy change.

### Phase 10: Compartment-Aware Index/Export Checks

Shipped in v0.9e for memory mode:

- `compartment:` activates the check.
- Public generated copies are generated/cache/index/export artifacts marked `visibility: public` or `audience: public`.
- `redacted-view:` must point at a known local safe file.

Prepare for future index/search/export copies by checking boundary metadata:

```text
compartment-boundaries
```

Findings:

- MED: restricted item is included in a public generated index/export.
- MED: generated index/export omits compartment labels from included items.
- HIGH: redacted view points at no known safe file.

This does not require Kernel Keeper to enforce access control. It only ensures derived copies do not silently erase the boundary.

### Phase 11: Recall Evidence

Shipped in v0.9e as an optional local retrieval-log check. A bundle opts in by declaring `retrieval-log:` frontmatter on a governed file such as `log.md`.

Once indexes and receipts are in use, add optional recall-log checks:

```text
recall-evidence
```

Findings:

- LOW: indexed concept is never retrieved across a configured recall-log window.
- LOW: repeated searches land on a derived artifact when a source concept is available.
- MED: recall log references a file that no longer exists.

This should stay optional. The first goal is memory integrity, not instrumentation.

## Test Plan

Unit tests:

- Index link with useful description is quiet.
- Bare index link produces LOW `index-line-quality`.
- Dated overview accepts valid `As of YYYY-MM-DD`.
- Invalid/future overview date produces MED.
- Claim receipt resolves local `.md`, `.txt`, `.csv`, `.json`, `.yml`, `.yaml` files.
- Broken claim receipt produces MED.
- External source receipts are skipped in v1.
- `sources/` and `raw/` files do not create index-coverage findings.
- Retired items stay quiet for overview and receipt noise.
- Generated artifact with `generated-from:` pointing at an existing source is quiet.
- Generated artifact with missing provenance produces MED.
- File under `archive/` without archive lifecycle metadata produces MED.
- `status: archived` item with an archive note remains discoverable and does not create ownerless/staleness noise.
- Restricted item included in a public generated index/export produces MED.
- Damage-meter fixture detects missing or newly unresolvable registered items.
- Recall-log fixture detects a missing retrieved file without requiring logs in ordinary bundles.

Integration tests:

- A fixture bundle with concepts plus `sources/` produces zero findings.
- A fixture bundle with missing receipts, broken source paths, and weak index descriptions produces deterministic LOW/MED findings.
- Drift jobs include claim receipt source files.
- Rebuild/verify fixture exits non-zero when a generated artifact drops registered items.
- Compartment fixture proves boundary metadata is preserved in generated index/export checks.

Regression:

- `npm run typecheck`
- `npm run build`
- `npm test -- --run`
- `npm pack --dry-run`
- tarball smoke install with `kernel-keeper --help`

## Rollout Order

1. Ship docs and fixture only.
2. Add `index-line-quality`, because it directly strengthens the two-read retrieval model.
3. Add `sources/` and `raw/` semantics before claim receipts, so evidence files do not create index noise.
4. Add dated overview. Shipped in v0.9a for invalid/future `As of YYYY-MM-DD` markers; missing markers remain quiet pending dogfood evidence.
5. Add claim receipts with conservative LOW heuristics.
6. Fold receipts into Drift Reviewer source selection.
7. Add derived-artifact checks. Shipped in v0.9b for generated/cache-like concept files with missing or broken `generated-from:` provenance.
8. Add archive lifecycle semantics. Shipped in v0.9c for `status: archived`, archive notes, archive-path metadata, and archived staleness/ownerless quieting. Verify-backed retrieval-path continuity shipped later with baseline comparison.
9. Add effect verification and a damage-fraction meter. Shipped in v0.9d with explicit baseline JSON creation/comparison and local-only damage checks.
10. Add compartment-aware generated index/export checks. Shipped in v0.9e for `compartment:`, public generated copies, and `redacted-view:`.
11. Add optional recall-log checks after the index and receipt conventions have real usage. Shipped in v0.9e for local `retrieval-log:` evidence.

## Network-Backed Drift

Shipped in v0.10 as an explicit `drift --fetch-sources` opt-in. Kernel Keeper fetches only declared HTTP(S) `source:` frontmatter in bundle memory mode, writes text-like responses plus metadata to `.kernel-keeper/drift-cache/`, and feeds the cached file paths into proposal evidence. Dry runs list planned fetches and make zero network/API calls.

Fetched-source cache reuse is explicit: `--fetch-cache-max-age-hours <n>` reuses cached content whose URL, timestamp, and checksum still validate within the requested freshness window. Without that flag, fetch mode treats the network as live input.

## Open Questions

- Should `As of YYYY-MM-DD` be required for every concept, or only recommended until dogfooding proves signal?
- Should receipt-less "important-looking" bullets be LOW by default, or behind a `--strict-memory` option?
- Should raw/source files support line anchors only, or also timestamp anchors as opaque text?
- Should source-layer files be allowed outside `bundle/` but inside repo root, matching current link resolution?
- Should `mine` generate claim receipts when evidence quotes come from notes?
- What names should Kernel Keeper use for generated artifact metadata: `generated-from:` and `artifact-kind: cache`, or something closer to existing provenance frontmatter?
- What damage-fraction threshold should block a rebuild by default?
- Should compartment checks be always-on, or only active when any item declares `compartment:`?
- What recall-log format is useful without turning Kernel Keeper into an analytics system?
