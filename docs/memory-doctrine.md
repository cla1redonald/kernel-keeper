# Memory doctrine

Kernel Keeper treats agent memory as a governed wiki, not a hidden retrieval product. Markdown is the canonical register. Generated reports, indexes, exports and search caches are rebuildable artefacts that must keep provenance back to source. The intended read path is cheap and explicit: read `index.md`, then drill into a few full pages whose dates, owners, receipts and supersession state are visible to the human and the agent.

Opt in with `--memory`. The checks it enables are listed in [checks.md](checks.md). The full design reasoning is in [design/wiki-memory-invariants.md](plans/wiki-memory-invariants.md).

- **Index-first retrieval:** `--memory` checks whether indexed concept links have useful nearby context, not just a bare filename.
- **Claim receipts:** explicit `[source: ...]` receipts are validated against local text-like evidence, so important claims can point at inspectable proof.
- **Source layers:** `sources/` and `raw/` hold evidence without being mistaken for governed concepts.
- **Receipt-aware drift:** `drift --memory` prefers explicit receipts and `source:` frontmatter before falling back to ordinary outbound links.
- **Dated overviews:** invalid or future-dated `As of YYYY-MM-DD` markers are flagged. Missing markers stay quiet until real usage shows the signal is worth it.
- **Derived artefacts:** generated or cache-like concepts must point back to source with `generated-from:`, so caches do not become accidental truth.
- **Archive as state:** `status: archived` keeps de-emphasised memory quiet for ownerless and staleness checks while preserving explicit retrieval and supersession rules.
- **Effect verification:** `verify` proves the register survived a maintenance action by comparing against a prior baseline and making damage visible.
- **Compartments and recall evidence:** optional `compartment:`, `redacted-view:` and `retrieval-log:` metadata protects generated public copies and shows whether indexed memory is actually being found.

Frontmatter parsing is the zero-dependency subset by default: single-line scalars, simple lists and `key: value` pairs. `--frontmatter-parser yaml` uses the optional `yaml` package if it is installed beside the CLI. `apply --write` refuses complex YAML frontmatter it cannot safely round-trip.
