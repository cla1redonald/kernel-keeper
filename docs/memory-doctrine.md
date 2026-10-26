# Memory doctrine

Kernel Keeper treats an agent's memory as a wiki that people own and keep up to date, rather than something hidden inside a retrieval system. The markdown files are the record. Reports, indexes, exports and search caches are generated from those files, can be rebuilt at any time, and have to say which source files they came from. An agent is expected to read memory in a cheap and obvious way. It opens `index.md` first, then reads a few full pages, and each page shows its date, its owner, its sources and whether it has been replaced, so the person and the agent see the same thing.

You switch these checks on with `--memory`. [checks.md](checks.md) lists them, and [design/wiki-memory-invariants.md](design/wiki-memory-invariants.md) sets out the reasoning behind them.

With `--memory` on, Kernel Keeper does the following.

- It checks that each concept linked from the index has a useful description next to the link, and not just a bare filename.
- It validates `[source: ...]` receipts against local text files, so an important claim can point at evidence someone can open and read.
- It treats files under `sources/` and `raw/` as evidence, so they are not mistaken for concepts that need an owner and a date.
- `drift --memory` takes its evidence from explicit receipts and `source:` frontmatter first, and only falls back to ordinary outbound links when there are none.
- It flags an `As of YYYY-MM-DD` marker that is invalid or in the future. Pages with no marker are left alone until real use shows the check is worth having.
- A generated or cache-like page must point back to its source with `generated-from:`, so that a cache cannot quietly become the record.
- `status: archived` keeps a page out of the ownership and staleness checks. The rules about how it can still be found, and what replaced it, still apply.
- `verify` compares the register with an earlier baseline after a maintenance job and shows any damage, which is how you know the register survived the job.
- Optional `compartment:`, `redacted-view:` and `retrieval-log:` metadata stops public generated copies from exposing restricted pages, and shows whether agents are actually finding the pages listed in the index.

By default, frontmatter is read with a small built-in parser that handles single-line values, simple lists and `key: value` pairs. `--frontmatter-parser yaml` uses the optional `yaml` package instead, if it is installed beside the CLI. `apply --write` refuses any complex YAML frontmatter that it cannot write back safely.
