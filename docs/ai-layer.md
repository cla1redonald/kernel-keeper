# The AI layer

Deterministic checks find rot. The roster drafts the fix, so the owner's decision collapses to a yes or no. The constitution is structural, not aspirational:

**AI drafts, a named human elects, a deterministic clerk previews or writes the apply diff.**

Everything here sits behind `ANTHROPIC_API_KEY` except `apply`, `verify`, `glass`, `glass-demo` and `notion sync --dry-run`, which need no key.

```bash
export ANTHROPIC_API_KEY=...     # the only enabler; native fetch, no SDK, still zero-dep
node dist/cli.js propose <bundle> --out-dir proposals/                   # the Scribe
node dist/cli.js mine <notes-dir> --bundle <bundle> --out-dir proposals/ # the Gap-Miner
node dist/cli.js drift <bundle-or-estate> --out-dir proposals/           # the Drift Reviewer
node dist/cli.js apply <bundle-or-estate> --proposals proposals/         # the Clerk (dry-run by default; --write applies)
node dist/cli.js verify <bundle-or-estate> --baseline baseline.json      # the Damage Meter
node dist/cli.js glass <bundle-or-estate> --proposals proposals/ --by "Your Name" # the Glass review console
node dist/cli.js glass-demo                                              # seeded Glass demo
```

## The roles

- **The Scribe** (`propose`) turns patrol findings into drafted affirm-or-amend proposals, one per target file, `--min-severity med` by default. Each proposal carries the drafted frontmatter patch, body, journal line or index entry as immutable fenced blocks, decision tick-boxes, and an Amendment section. Record changes in the Amendment section, never by editing the draft: the draft-versus-amendment diff is future training signal.
- **The Gap-Miner** (`mine`) map-reduces a corpus of working notes into new-concept proposals for truths no register concept covers. It filters against the concept inventory and quotes evidence verbatim.
- **The Drift Reviewer** (`drift`) compares each registered item with the local text files it references (`.md`, `.yml`, `.yaml`, `.json`, `.csv`, `.txt`) and drafts semantic-drift proposals. In memory mode (`--memory`), valid `[source: ...]` receipts and `source:` frontmatter are preferred as evidence over ordinary links. External sources are skipped unless you pass `--fetch-sources`, which fetches only declared HTTP(S) `source:` frontmatter and caches text-like responses under `.kernel-keeper/drift-cache/`. Add `--fetch-cache-max-age-hours <n>` to reuse fresh cached files; without it, fetch mode treats the network as live input. Every drift proposal is `needs-human: true` and carries `checks: [semantic-drift]`.
- **The Clerk** (`apply`) previews or writes deterministic diffs for elected proposal files. Dry-run is the default; `--write` applies only eligible changes. Amend proposals can patch frontmatter and body and append bundle journal lines. New-concept proposals can create a full frontmatter-bearing file, append an `index.md` entry and append the journal line as one safe unit. New-procedure proposals can create authored skills, agents or commands. Procedure-estate writes append `.kernel-keeper/audit/<mode>-log.md` by default, so every change to a skill, agent or command keeps an election trail; `--no-audit-log` is the explicit opt-out. A proposal needs a real human election marker (`elected: true`, `status: elected`, or a checked Elect box), provenance with reviewed-surface hashes, a text target and existing evidence files. Stale, ambiguous, unsupported, third-party-plugin or already-applied proposals are refused or skipped before any write.
- **The Damage Meter** (`verify`) compares the current governed surface with a prior baseline JSON. It can run explicit no-shell `--generator` commands before the snapshot, then reports missing registered items, changed content, newly unresolvable evidence or path references, archived items that lost retrieval continuity, new items and the damage fraction. `--damage-threshold` controls when it exits `1`; the default is zero tolerance.
- **The Glass** (`glass`) starts a local browser review console over the same engine: review queue, proposal inbox, approve, reject and request-edit controls, deterministic apply preview, explicit write, and audit history. It gives a business reviewer a readable surface without Markdown, CLI or Git. New-procedure proposals render as promotion moments. See [demo/glass-demo-script.md](demo/glass-demo-script.md).
- **The seeded demo** (`glass-demo`) copies the Northwind memory lab into a temp folder, starts Glass against the command estate and loads the procedure-promotion proposal. It is the quickest path through scan, proposal, approve, apply and audit.

## Glass security model

Glass can write files (decisions and, through the Clerk, applied changes), so it is built to be driven only by the person sitting at the machine.

- **One source per server.** `root`, `register`, `memory` and `proposals` are fixed by the `glass` command line. Pages and forms never carry them, and a request that names a different `root`, `proposals`, `register` or `memory` gets `400`. To review another source, start another server.
- **Loopback only.** `--host` must be `127.0.0.1`, `localhost` or `::1`. Glass has no login.
- **Host and Origin.** Every request must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>` (this defeats DNS rebinding). A request with an `Origin` header must carry the server's own origin. Requests with no `Origin`, such as `curl`, are accepted. Anything else gets `403`.
- **CSRF token.** A random token is generated at startup and embedded in every POST form the server renders. A POST without it gets `403`. The token is never put in a URL.
- **Reviewer.** Elections are signed by the reviewer fixed at startup: `--by`, else `KERNEL_KEEPER_REVIEWER`, else `git config user.name`, else `reviewer`. The page shows it as a read-only field, and a posted `by` is ignored.
- **Browser headers.** Pages are sent with a CSP that allows no scripts and no framing, plus `X-Frame-Options: DENY` and `Cache-Control: no-store`.

## Procedure promotion

A proposal with `kind: new-procedure` may create `skills/<name>/SKILL.md`, `agents/<name>.md` or `commands/<name>.md`. The shape is deliberately narrow. The file must be frontmatter-bearing markdown with a `description:`, must live in an authored register path, must carry reviewed-surface provenance and evidence, and must be elected by a human. `apply --write --register estate` creates the file and appends the estate audit log as one write unit. Plugin cache targets are refused.

This is the governed version of turning a lesson into behaviour: lesson, proposal, election, skill or agent or command, audit trail. The bundle records what the team believes. The procedure estate records what agents are allowed to do with that belief.

## Notion approval surface

`notion sync`, `notion decisions` and `notion audit` render the proposal inbox as Notion database rows and proposal pages, so a reviewer can decide without leaving Notion.

```bash
node dist/cli.js notion sync <bundle-or-estate> --proposals proposals/ --dry-run
NOTION_TOKEN=... node dist/cli.js notion sync <bundle-or-estate> --proposals proposals/ --notion-database <id>
NOTION_TOKEN=... node dist/cli.js notion decisions <bundle-or-estate> --proposals proposals/ --notion-database <id>
NOTION_TOKEN=... node dist/cli.js notion audit <bundle-or-estate> --proposals proposals/ --notion-database <id>
```

The reviewer sets the page's **Decision** property: `Approved` elects the draft, `Rejected` refuses it, `Request edit` sends it back for amendment, and blank means still under review. `--dry-run` makes no API calls. A live publish needs `NOTION_TOKEN` and `--notion-database <id>` (the Notion data source ID in the current API). It validates the database contract, creates or updates by `Proposal ID`, and stores local sync state under `.kernel-keeper/notion-sync.json`. `notion decisions` writes ordinary Glass decision markers only when the reviewed hash still matches. `notion audit` reflects Clerk Applied and Refused outcomes back into Notion without running apply itself.

For local use, copy `.env.example` to `.env` and fill in the keys. The CLI loads `.env` from the current working directory before it checks keys, and `.env` files are git-ignored.

## Provenance and safety

- **Provenance on every output:** proposer, model, a reproducible `prompt-sha256` (prompt assembly is pure), the evidence file list, reviewed-surface hashes for stale-content refusal, and token usage. `--dry-run` prints exactly the prompts that hash, with zero API calls.
- **Proposals cannot enter the register.** There is one write chokepoint. `--out-dir` inside the bundle is a hard error (64). Inside the repo root it needs `--allow-in-repo`, because proposal files would otherwise enter link-resolution scope. Proposal IDs are deterministic (no date), so re-runs skip instead of spamming the inbox.
- **Threat model:** corpus and bundle content is untrusted data. It is fenced, fence delimiters inside content are escaped, and prompts mark repository content as data, not instructions. A poisoned note can at worst produce a plausible-looking proposal, which is exactly why election exists.
- **Cost guards:** `propose` and `drift` print an input-token estimate before any call and print usage totals afterwards. `mine` also takes `--max-calls` (default 25) and aborts before spending if the run would need more.
- **Failure semantics:** partial failure is first-class. Successes are written, failures are reported, and the exit code is `1`. A missing key or bad out-dir exits `64`. An API that stays unavailable after retries exits `69`.
