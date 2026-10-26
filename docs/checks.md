# Checks

Every check follows fixed rules, and the patrol has no runtime dependencies. The report groups findings by owner. When the patrol cannot work out who owns something, the finding goes under "Needs an owner", because having no owner is a problem in its own right.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean. There are no findings at or above your `--fail-on` threshold. |
| `1` | Findings at or above the threshold (MED under `--fail-on med` or `any`, LOW under `--fail-on any`). |
| `2` | Any HIGH finding, regardless of threshold. |
| `64` | Malformed invocation (bad flag, non-numeric `--policy-days` or `--journal-days`). |
| `66` | The bundle or estate could not be loaded. |

`--json` prints the result as JSON instead of markdown. `--quiet` prints only the one-line summary, which is easier to read in CI logs. `kernel-keeper --help` lists every option.

## Knowledge bundles

A bundle is a register in the Team OS style. It is an OKF-style `bundle/` folder that holds linked concepts and definitions, an `index.md` and a `log.md` journal.

| Check | Severity | What it catches |
|---|---|---|
| `dangling-links` | HIGH | Internal links (`/metrics/x.md`, `../definitions/x.yml`, data samples) that resolve to nothing. An agent that follows one finds nothing there. |
| `pointer-integrity` | HIGH/MED/LOW | Definitions whose `concept:` back-reference points at no concept, and definitions no concept links to. Definition and concept must point at each other. |
| `frontmatter` | HIGH/MED/LOW | Missing frontmatter, missing `type` (the one OKF-required key), invalid or future `timestamp`/`last-affirmed`, missing title, description or timestamp. |
| `staleness` | MED | Concepts past the affirm-or-amend window (default 90 days, `--policy-days`). Uses a valid `last-affirmed` if present, else a valid `timestamp`. |
| `ownerless` | MED/LOW | Concepts with no resolvable owner (an `**Owner.**` line, frontmatter `owner:`, or a linked definition's `meta.owner`). Glossary terms are LOW because they inherit bundle ownership. |
| `stable-ids` | HIGH/MED | Optional `id:` values must be stable tokens and unique across the bundle. Missing IDs stay quiet. |
| `supersession-integrity` | HIGH/MED | Superseded concepts must point at a replacement. Active concepts must not link retired, superseded or archived items without `supersession-note:`. Duplicate replacement claims are flagged. |
| `journal` | HIGH/MED | `log.md` missing, undated, or silent past policy (default 30 days, `--journal-days`). A silent journal means changes are bypassing the register. |
| `index-coverage` | HIGH/LOW | `index.md` itself missing (HIGH, because it is the page agents are meant to read first), or concepts missing from it (LOW). |
| `orphans` | LOW | Concepts that nothing links to, so the only way to find them is to browse. |
| `unjournalled-change` | MED | A concept dated after the journal's newest entry, so the change bypassed the loop. Uses frontmatter dates, not file mtime, so it is safe across clones. |

### Memory mode (`--memory`)

You have to switch these checks on. [memory-doctrine.md](memory-doctrine.md) explains why they exist.

| Check | Severity | What it catches |
|---|---|---|
| `index-line-quality` | MED/LOW | Indexed concept links that give too little nearby context for an agent reading the index first. |
| `claim-receipts` | MED/LOW | Explicit `[source: ...]` receipts that are missing, outside the files the patrol loaded, or point at binary or media files. |
| `dated-overview` | MED | Invalid or future-dated `As of YYYY-MM-DD` overview markers in concept prose. Missing markers stay quiet. |
| `derived-artifacts` | MED | Generated or cache-like concept files that do not declare resolvable `generated-from:` provenance. |
| `archive-lifecycle` | MED/LOW | `status: archived` items without an `archive-note:`, and `archive/` paths that are not lifecycle-marked. |
| `compartment-boundaries` | HIGH/MED | When any item declares `compartment:`, public generated copies must not expose restricted items or drop compartment labels. `redacted-view:` must resolve. |
| `recall-evidence` | MED/LOW | When a bundle declares `retrieval-log:`, missing recalled files, unretrieved indexed concepts and repeated derived-artifact hits are reported. |

The patrol always skips `.git`, `node_modules`, `demo-views`, `.obsidian` and `dist`, wherever they occur.

## Procedure registers (`--register`)

The same patrol can run over the skills, agents, commands and plugins that your agents work from.

```bash
node dist/cli.js ~/.claude --register estate                 # skills/ agents/ commands/ plugins/ in one run
node dist/cli.js path/to/skills --register skills            # or one register at a time
node dist/cli.js ~/.claude --register estate --denylist retired-tools.txt
```

To find likely estate roots inside a repo container or vault:

```bash
node dist/cli.js discover-estates ~/code --max-depth 3
node dist/cli.js discover-estates ~/my-vault --json
```

Discovery only reports a folder if it holds register items that you wrote and that can be loaded. A plain Obsidian project with `INDEX.md` and `Synthesis.md` notes is skipped. A generic software `plugins/` implementation folder is not treated as an estate unless it contains nested skills, agents or commands.

| Check | Severity | What it catches |
|---|---|---|
| `agent-visibility` | HIGH/MED | An agent `.md` with no frontmatter (the agent registry ignores it without saying so), a missing description, or a filename that differs from the declared `name`. |
| `skill-shape` | HIGH/MED/LOW | A skill folder without `SKILL.md` (cannot be invoked; LOW rather than HIGH for a plugin's skill), or missing frontmatter or description (undiscoverable, authored skills only). |
| `deprecated-tools` | HIGH | Mentions of tool names on your denylist (`--denylist`, one per line), such as retired MCP endpoints that would make a skill fail partway through a run. Skipped without comment when no denylist is given. |
| `dangling-refs` | MED | Paths the item references (`~/...`, `$HOME/...`, relative links) that do not exist. Prose only: references inside code fences and inline code are treated as examples. MED because a missing path can be a runtime artefact the item legitimately describes. |
| `staleness` | MED | Items past the affirm-or-amend window, using a valid `last-affirmed:` if present, else file mtime. Invalid or future `last-affirmed` is reported. |
| `name-collisions` | MED | The same name claimed from two scopes, such as your own skill and a plugin's. Which one gets used is left to the resolver. Only reported when one of the items is yours. |
| `ownerless` | LOW | No `owner:` frontmatter. This is LOW on purpose, because plenty of estates belong to one person. Ownership starts to matter once the register is shared. |
| `stable-ids` | HIGH/MED | Optional `id:` values must be stable tokens and unique across the estate. |
| `supersession-integrity` | HIGH/MED | Superseded items must point at a replacement. Active authored items must not reference retired, superseded or archived items without `supersession-note:`. |
| `command-shape` | LOW | Commands without a description. |
| `plugin-shape` | LOW | A plugin containing no recognisable skills, agents or commands. |

### The third-party rule

Items under `plugins/` were written by someone else, so the patrol checks very little about them. A plugin skill is only checked for a missing `SKILL.md`, and that is reported as LOW rather than HIGH. Every plugin item also gets `name-collisions` and `deprecated-tools`. Keeping a marketplace plugin fresh, owned, fully described and free of broken references is the publisher's job. The patrol covers the items your organisation wrote and is answerable for. A plugin cache can hold hundreds of items, so this rule also keeps an estate report short enough to read.
