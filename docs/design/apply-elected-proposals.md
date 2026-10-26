# Design note: Applying elected proposals (the Clerk)

*Design note. This records why the feature is shaped the way it is, and was written while it was being built. The current behaviour is described in [../checks.md](../checks.md), [../memory-doctrine.md](../memory-doctrine.md) and [../ai-layer.md](../ai-layer.md); version numbers refer to [CHANGELOG.md](../../CHANGELOG.md).*

Status: v0.8 added a safe write mode for elected amendments that pass the eligibility checks. Later releases added index entries in bundles, creation of new concepts, an audit history for estates, and creation of new skills, agents and commands in the authored part of an estate, each under the same rules.

## Goal

Finish the loop with a clerk, which is plain code with no AI in it:

```bash
kernel-keeper apply <bundle-or-estate-root> --proposals DIR
```

Agents still only draft proposals, and people still decide which ones to elect. `apply` reads the elected proposal files and checks that each one still matches what the reviewer saw. It then prints the diff, or applies it, and refuses anything ambiguous or stale.

The product reason follows the rule that runs through the rest of Kernel Keeper. Something a team keeps learning should be able to become a skill, agent or command that agents reuse, but only after a person has elected it and the clerk has applied it. That lets a team show a lesson turning into behaviour without letting an agent install things nobody has checked.

## Scope

- Apply proposal files written by the existing AI proposal chokepoint.
- Only consider proposals with a real human election marker. The drafted journal line carries `decision: elected`, but that is the line to paste later, not proof of election by itself.
- Support bundle roots and procedure estates, with `--register estate|skills|agents|commands`.
- Default to `--dry-run`; require `--write` for filesystem changes. Shipped in v0.8 for eligible deterministic amendments.
- Emit unified diffs in dry-run mode. This is shipped.
- Preserve current out-dir safety and provenance assumptions.

## Proposal Eligibility

A proposal is eligible only when all of these are true:

- The proposal parses cleanly.
- It has `needs-human: true`.
- It has a real human election marker: `elected: true`, `status: elected`, or a checked Elect box.
- It has provenance with prompt hash and evidence files.
- Its target file is inside the loaded bundle or estate surface, or is a supported new-procedure path in an authored estate register.
- Its target file is text-like, and exists unless the proposal is an eligible new-concept or new-procedure creation.
- Its referenced evidence files still exist.
- Its prompt hash or equivalent reviewed-surface hash still matches the current target/evidence content.

Anything else is skipped or refused with a clear reason.

## Apply Semantics

The proposal shapes Kernel Keeper already writes:

- Frontmatter patch: update, add, or remove simple scalar keys in the existing frontmatter block. Dry-run preview and write mode are shipped.
- Body draft: replace the markdown body after frontmatter when present. Dry-run preview and write mode are shipped.
- Journal line: append elected proposal line to bundle `log.md` when bundle mode is active. Dry-run preview and write mode are shipped.
- Index entry: insert only when the target index location is deterministic; otherwise refuse.
- Estate audit line: append elected procedure-register writes to `.kernel-keeper/audit/<mode>-log.md` by default. `--no-audit-log` is explicit, and third-party/plugin cache targets are refused.
- New procedure: create a complete authored estate file when `kind: new-procedure` targets `skills/<name>/SKILL.md`, `agents/<name>.md`, or `commands/<name>.md` in estate mode. Single-register modes accept their local shape, such as `<name>.md` for `--register commands`.

No fuzzy matching. If the expected frontmatter block, body boundary, or log file cannot be identified deterministically, refuse and tell the human what to fix.

## CLI

```bash
kernel-keeper apply <bundle-or-estate-root> --proposals DIR [options]
```

Options:

- `--register <kind>`: `estate|skills|agents|commands`
- `--dry-run`: print planned unified diffs; default
- `--write`: apply changes
- `--proposal <id>`: apply one proposal id
- `--check <name>`: filter proposals by check
- `--no-audit-log`: estate write-mode escape hatch for suppressing `.kernel-keeper/audit/<mode>-log.md`
- `--json`: machine-readable summary

Exit codes should mirror the rest of the CLI:

- `0`: no failures
- `1`: one or more eligible proposals refused or failed
- `64`: usage error
- `66`: IO/load error

## Refusal Cases

Refuse rather than guessing when:

- More than one proposal tries to edit the same target in one run.
- A proposal is not elected.
- The proposal was already applied.
- Target or evidence content changed since review.
- The target is binary/media or outside the loaded root.
- The target is a third-party plugin item rather than an authored estate item.
- A new-procedure target is outside the supported authored skill/agent/command shapes.
- A new-procedure body has no deterministic frontmatter or no `description:`.
- A frontmatter patch would require parsing richer YAML than Kernel Keeper supports.
- A body replacement would erase content not represented in the reviewed draft.
- An index insertion links to a different target than the proposal target.

## Tests

Unit tests:

- Parses elected vs unelected proposal files.
- Rejects malformed proposal frontmatter.
- Rejects missing provenance.
- Rejects stale target/evidence hashes.
- Applies scalar frontmatter patches.
- Applies body draft replacements.
- Appends bundle journal lines once.
- Appends estate audit lines by default.
- Creates elected new-procedure skill/agent/command files.
- Skips already-applied proposals idempotently.
- Refuses multiple proposals for one target.

CLI tests:

- `apply --dry-run` prints a unified diff and writes nothing.
- `apply --write` modifies only eligible targets.
- `apply --proposal <id>` limits the run.
- `apply --check semantic-drift` filters proposals.
- Bad proposals dir exits `64` or `66` consistently with existing commands.

Regression:

- `npm run typecheck`
- `npm run build`
- `npm test -- --run`
- `npm pack --dry-run`
- tarball smoke install with `kernel-keeper apply --help`

## Open Design Questions

- Whether a future AI verb should draft `new-procedure` proposals directly from repeated notes/operator feedback, or whether that stays a proposal shape emitted by other tools.

## Remaining Implementation

- Keep refusal messages specific enough that a human can repair or amend the proposal without reading the code.
