# The AI layer

The patrol finds the problems. The AI roles on this page draft a fix for each one, so the owner only has to decide yes or no. The order is built into the code rather than left to good behaviour. An AI role writes a draft, a named person has to elect it, and only then can the Clerk, which is plain code with no AI in it, preview the change or write it.

Everything on this page needs `ANTHROPIC_API_KEY`, apart from `apply`, `verify`, `glass`, `glass-demo` and `notion sync --dry-run`, which run without a key.

```bash
export ANTHROPIC_API_KEY=...     # the only setting needed; uses native fetch, no SDK, still no dependencies
node dist/cli.js propose <bundle> --out-dir proposals/                   # the Scribe
node dist/cli.js mine <notes-dir> --bundle <bundle> --out-dir proposals/ # the Gap-Miner
node dist/cli.js drift <bundle-or-estate> --out-dir proposals/           # the Drift Reviewer
node dist/cli.js apply <bundle-or-estate> --proposals proposals/         # the Clerk (dry-run by default; --write applies)
node dist/cli.js verify <bundle-or-estate> --baseline baseline.json      # the Damage Meter
node dist/cli.js glass <bundle-or-estate> --proposals proposals/ --by "Your Name" # the Glass review console
node dist/cli.js glass-demo                                              # seeded Glass demo
```

## The roles

### The Scribe (`propose`)

The Scribe turns patrol findings into drafted proposals to affirm or amend a page. It writes one proposal per target file, and by default only for findings of MED or above (`--min-severity med`). Each proposal holds the drafted frontmatter patch, body, journal line or index entry in fenced blocks that are not to be edited, followed by tick-boxes for the decision and an Amendment section. If you want to change the draft, write your change in the Amendment section and leave the draft as it was. The difference between the draft and the amendment is kept, because it shows where the AI got things wrong and can be used later to improve it.

### The Gap-Miner (`mine`)

The Gap-Miner works through a folder of working notes in batches and drafts proposals for new concepts, covering things the notes treat as true that no page in the register covers yet. It checks each candidate against the list of concepts the register already has, and quotes its evidence word for word.

### The Drift Reviewer (`drift`)

The Drift Reviewer compares each item in the register with the local text files it refers to (`.md`, `.yml`, `.yaml`, `.json`, `.csv`, `.txt`), and drafts a proposal wherever the item and its sources no longer say the same thing. With `--memory`, it uses valid `[source: ...]` receipts and `source:` frontmatter as evidence before it looks at ordinary links.

It skips external sources unless you pass `--fetch-sources`. That fetches only the HTTP(S) addresses declared in `source:` frontmatter, and caches text responses under `.kernel-keeper/drift-cache/`. Add `--fetch-cache-max-age-hours <n>` to reuse cached files that are newer than that. Without it, every fetch goes to the network. Every drift proposal is marked `needs-human: true` and carries `checks: [semantic-drift]`.

### The Clerk (`apply`)

The Clerk shows, or writes, the exact changes for proposal files that a person has elected. It only shows them unless you pass `--write`, and then it applies only the eligible ones.

An amend proposal can patch the frontmatter and body of a page and add a line to the bundle journal. A new-concept proposal can create a complete file with frontmatter, add an entry to `index.md` and add the journal line, and those three changes are written together or not at all. A new-procedure proposal can create a skill, agent or command in the part of the estate your organisation writes.

When the Clerk writes to a procedure estate, it also adds a line to `.kernel-keeper/audit/<mode>-log.md` by default, so every change to a skill, agent or command has a record of who elected it. You can turn that off with `--no-audit-log`, but only by asking for it.

To be applied, a proposal needs a real election by a person (`elected: true`, `status: elected` or a ticked Elect box), provenance that includes hashes of what the reviewer saw, a text file as its target, and evidence files that still exist. A proposal that is stale, ambiguous, of an unsupported kind, aimed at a third-party plugin or already applied is refused or skipped before anything is written.

### The Damage Meter (`verify`)

The Damage Meter compares the register as it is now with a baseline JSON file taken earlier. It can first run `--generator` commands that you name, without a shell, and then take its snapshot. It reports registered items that have gone missing, content that has changed, evidence or path references that no longer resolve, archived items that can no longer be reached, new items, and the damage fraction. `--damage-threshold` sets the point at which it exits `1`. The default is zero, so any damage at all fails.

### Glass (`glass`)

Glass opens a review console in your browser. It runs on your machine and uses the same engine as the CLI. It has the review queue, an inbox of proposals with approve, reject and request-edit controls, a preview of exactly what apply will change, a separate step to write it, and the audit history. A business reviewer can work through proposals there without Markdown, the command line or Git. A new-procedure proposal is shown as a promotion, where a lesson becomes something agents will do. See [demo/glass-demo-script.md](demo/glass-demo-script.md).

### The seeded demo (`glass-demo`)

`glass-demo` copies the Northwind memory lab into a temporary folder, starts Glass on its command estate and loads the procedure-promotion proposal. It is the quickest way to see the scan, a proposal, approval, apply and the audit trail in one sitting.

## Glass security model

Glass writes files. It records decisions and, through the Clerk, applies changes, so it is built to be used only by the person sitting at the machine.

- Each server reviews one source. `root`, `register`, `memory` and `proposals` are fixed on the `glass` command line, and no page or form carries them. A request that names a different `root`, `proposals`, `register` or `memory` gets `400`. To review another source, start another server.
- It listens on loopback only. `--host` must be `127.0.0.1`, `localhost` or `::1`. Glass has no login.
- Every request must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>`, which defeats DNS rebinding. A request with an `Origin` header must carry the server's own origin. Requests with no `Origin`, such as those from `curl`, are accepted. Anything else gets `403`.
- A random CSRF token is generated when the server starts and embedded in every POST form it renders. A POST without the token gets `403`. The token is never put in a URL.
- Elections are signed by the reviewer fixed at startup. That is `--by` if you gave it, otherwise `KERNEL_KEEPER_REVIEWER`, otherwise `git config user.name`, and otherwise `reviewer`. The page shows the name in a read-only field, and any `by` value posted to it is ignored.
- Pages are sent with a CSP that allows no scripts and no framing, plus `X-Frame-Options: DENY` and `Cache-Control: no-store`.

## Procedure promotion

A proposal with `kind: new-procedure` may create `skills/<name>/SKILL.md`, `agents/<name>.md` or `commands/<name>.md`, and nothing else. The rules are deliberately narrow. The file must be markdown with frontmatter that includes a `description:`. It must sit in a part of the register your organisation writes, it must carry provenance and evidence for what the reviewer saw, and a person must have elected it. `apply --write --register estate` creates the file and adds the line to the estate audit log in one write. Targets in a plugin cache are refused.

This is how something the team has learned becomes something agents do, with a person's approval and a record at every step. The lesson is drafted as a proposal, a person elects it, the Clerk creates the skill, agent or command, and the audit log records that it happened. The bundle holds what the team believes, and the procedure estate holds what agents are allowed to do with it.

## Notion approval surface

`notion sync`, `notion decisions` and `notion audit` show the proposal inbox as rows in a Notion database, with a page for each proposal, so a reviewer can make decisions without leaving Notion.

```bash
node dist/cli.js notion sync <bundle-or-estate> --proposals proposals/ --dry-run
NOTION_TOKEN=... node dist/cli.js notion sync <bundle-or-estate> --proposals proposals/ --notion-database <id>
NOTION_TOKEN=... node dist/cli.js notion decisions <bundle-or-estate> --proposals proposals/ --notion-database <id>
NOTION_TOKEN=... node dist/cli.js notion audit <bundle-or-estate> --proposals proposals/ --notion-database <id>
```

The reviewer records a decision in the page's **Decision** property. `Approved` elects the draft, `Rejected` refuses it, `Request edit` sends it back to be amended, and leaving it blank means it is still under review.

`--dry-run` makes no API calls. A live publish needs `NOTION_TOKEN` and `--notion-database <id>`, which is the Notion data source ID in the current API. It checks that the database has the properties it expects, creates or updates rows by `Proposal ID`, and keeps its sync state locally in `.kernel-keeper/notion-sync.json`. `notion decisions` writes ordinary Glass decision markers into the proposal files, and only does so when the reviewed hash still matches. `notion audit` copies the Clerk's Applied and Refused outcomes back into Notion, without running apply itself.

For local use, copy `.env.example` to `.env` and fill in the keys. The CLI loads `.env` from the current working directory before it checks for keys, and `.env` files are ignored by git.

## Provenance and safety

- Every output records its provenance. That is who proposed it, the model, a `prompt-sha256` you can reproduce (the same inputs always build the same prompt), the list of evidence files, hashes of the reviewed files so stale content can be refused, and the token usage. `--dry-run` prints exactly the prompts behind that hash and makes no API calls.
- Proposals cannot be written into the register, because a single point in the code writes every proposal and it enforces this. Pointing `--out-dir` inside the bundle is a hard error (64). Pointing it inside the repo root needs `--allow-in-repo`, because otherwise proposal files there would be picked up when links are resolved. Proposal IDs are deterministic and carry no date, so running again skips proposals that already exist instead of filling the inbox with copies.
- The threat model treats notes and bundle content as untrusted, and does not count an instruction in a prompt as a safeguard. So there are four layers of defence, and each one assumes the layer before it has failed.
  1. **Prompt mitigation.** Content is fenced, any fence delimiters inside it are escaped, and the prompt says fenced text is data and never an instruction. This makes it less likely that a model is talked round, but it guarantees nothing.
  2. **Validator** (`validateDraft` in `src/ai/proposal.ts`, run by the single point that writes proposals). The validator, not the model, decides everything that carries authority, and the model's output only supplies the wording. The proposal id must be the deterministic `P-<hash>`, so a model cannot choose which file it is written to. The kind must be one the drafting agent is allowed to produce, and no agent may draft `new-procedure`. `needs-human` is set to `true` for every agent except the gap-miner, whose value is set in code. The target must be a plain relative path that stays inside the bundle or estate root after symlinks are resolved. Single-line fields (summary, journal line, index entry, patch values, evidence file names) may not contain a newline or a control character. No model text may contain a decision checkbox line or a reserved draft heading (`### Journal line` and the like), and prose and drafted bodies may not contain a code fence, because any of these would let the model forge an election or a draft block. Each refusal is logged against the cluster with its reason. Agents build drafts from named fields and never by spreading the model's reply, so an extra `id` or `target` key in the reply is ignored.

  Every value written into the proposal's YAML frontmatter goes through `yamlScalar` or `yamlListItem`. A value with a newline or a YAML-significant character is double-quoted with JSON escapes so that it stays on one line. A value starting `---` is refused, and so is any list item the reader cannot represent. No model string is passed to a shell, used as a URL, or used as a path outside the root.
  3. **Apply plan confinement.** The Clerk checks every proposal file again, whatever produced it. It refuses an amend or new-procedure proposal without `needs-human`, a target outside the root, a reviewed-surface hash that no longer matches, and any planned write that would land outside the loaded root.
  4. **Human election.** Nothing is applied until a named person elects the proposal. The worst a poisoned note can do is produce a plausible-looking draft, which the reviewer then declines.

  `tests/ai-injection.test.ts` runs a stubbed model that obeys an injected instruction, and shows layers 2 and 3 refusing what it produces.
- `propose` and `drift` print an estimate of input tokens before any call, and the usage totals afterwards. `mine` also takes `--max-calls` (default 25) and stops before spending anything if the run would need more calls than that.
- If some proposals fail, the ones that succeeded are still written, the failures are reported and the exit code is `1`. A missing key or a bad out-dir exits `64`. If the API is still unavailable after retries, the exit code is `69`.
