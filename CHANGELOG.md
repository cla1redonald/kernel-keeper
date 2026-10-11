# Changelog

Releases up to 0.7.0 were tagged in the original development repository. The 0.8.0 to 0.12.0 headings group the work that followed, which was previously recorded as one unreleased block. This public snapshot is 0.12.0.

## 0.12.0 - 2026-07-21

Glass review console and Notion approval surface.

- Added `glass`, a local browser review console: scan health cards, a filterable review queue, a proposal inbox with approve, reject and request-edit decisions, an apply page with deterministic preview and explicit write, and audit history.
- Added the Glass procedure-promotion showcase for `new-procedure` proposals, and `glass-demo`, a seeded walkthrough on the Northwind fixture.
- Added `notion sync --dry-run`, a deterministic export of the proposal inbox as Notion rows and page blocks, with no API calls.
- Added live `notion sync` with database contract validation, idempotent create or update by `Proposal ID`, and local `.kernel-keeper/notion-sync.json` state.
- Added `notion decisions` (Approved, Rejected, Request edit flow back into canonical proposal files, with stale reviewed-hash refusal) and `notion audit` (Clerk Applied and Refused outcomes written back to Notion).
- The CLI now loads a `.env` file from the working directory before checking for API keys.
- Clarified the Notion approval guidance shown to reviewers.

## 0.11.0 - 2026-07-20

Richer apply shapes and opt-in YAML.

- `apply` appends deterministic bundle index entries and creates complete elected new-concept proposals as one safe write unit.
- Added `new-procedure` proposals: elected estate proposals can create authored skills, agents and commands.
- Estate `apply --write` appends `.kernel-keeper/audit/<mode>-log.md` by default and refuses third-party plugin targets.
- `verify` gained no-shell `--generator` hooks and archive retrieval-continuity damage reporting.
- Added opt-in `--frontmatter-parser yaml`; the zero-dependency parser stays the default.
- Apply write mode refuses complex YAML frontmatter it cannot safely round-trip.
- Added the synthetic Northwind memory lab fixture.

## 0.10.0 - 2026-07-20

Network-backed drift.

- Added opt-in `drift --fetch-sources` for declared HTTP(S) `source:` frontmatter, cached as local evidence.
- Added `--fetch-cache-max-age-hours` for explicit reuse of fresh cached sources.

## 0.9.0 - 2026-07-20

Wiki-memory invariants and the damage meter.

- Added memory-mode checks: `dated-overview`, `derived-artifacts`, `archive-lifecycle`, `compartment-boundaries` and `recall-evidence`.
- Items with `status: archived` no longer create staleness or ownerless noise.
- Added `verify`, which compares the governed surface against a baseline and reports the damage fraction for bundles and estates.

## 0.8.0 - 2026-07-20

The Clerk can write.

- Added reviewed-surface hashes to proposal provenance, so `apply` refuses stale target or evidence content.
- `apply` recognises already-applied frontmatter, body, journal and index-entry proposals and skips them.
- Added `apply --write` for eligible elected proposals: dry-run stays the default, duplicate files are refused, and a refused proposal causes no partial writes.

## 0.7.0 - 2026-07-20

- Added wiki-memory evidence loading for text-like files under `sources/` and `raw/`. They resolve as link targets but are excluded from governed-concept checks.
- Added the opt-in `--memory` flag for patrol and drift, the `index-line-quality` and `claim-receipts` checks, and receipt-first evidence selection for memory-mode drift.

## 0.6.0 - 2026-07-19

- Added the Clerk: `apply`, a dry-run previewer for elected proposal diffs, with eligibility checks for human election markers, provenance, in-surface text targets, evidence and target collisions.

## 0.5.0 - 2026-07-19

- Added optional stable ID validation and supersession integrity checks across bundles and estates.
- Added the Drift Reviewer: `drift` drafts semantic-drift proposals from resolved local references.

## 0.4.4 - 2026-07-19

- Added `discover-estates` and the exported `discoverEstateRoots()`, tightened to skip ordinary Obsidian project folders, hidden archive folders and generic `plugins/` implementation directories.

## 0.4.3 - 2026-07-19

- Invalid or future dates now produce explicit findings instead of silently bypassing staleness and journal checks, in bundles and estates.
- Escaped file-fence delimiters and path attributes in AI prompts so untrusted content cannot break out of the data fence.
- Extra positional CLI arguments now fail fast.
