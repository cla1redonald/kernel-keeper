# Usage

These examples assume you have built Kernel Keeper locally.

```bash
git clone https://github.com/cla1redonald/kernel-keeper && cd kernel-keeper
npm ci && npm run build
```

## Patrol a repo

```bash
node dist/cli.js path/to/your-repo          # repo root containing bundle/, or the bundle folder itself
node dist/cli.js . --out patrol-report.md --fail-on med
node dist/cli.js . --memory                 # opt into the wiki-memory checks
node dist/cli.js ~/.claude --register estate # skills, agents, commands and plugins
```

[checks.md](checks.md) lists the exit codes and the main flags, and `--help` lists the rest.

## Snapshot and verify

Before a generator or other automated job does maintenance on a register, take a snapshot of it. When the job has finished, compare the register with the snapshot.

```bash
node dist/cli.js verify . --write-baseline .kernel-keeper-baseline.json
node dist/cli.js verify . --baseline .kernel-keeper-baseline.json --damage-threshold 0
```

## CI recipe (GitHub Actions)

This workflow runs the patrol every Monday morning, and runs it again as a gate on any pull request that touches `bundle/**`. It builds Kernel Keeper in a folder outside the workspace, so the patrol does not walk over Kernel Keeper's own files.

```yaml
name: kernel patrol
on:
  schedule: [{ cron: "0 7 * * 1" }]   # Monday morning patrol
  pull_request: { paths: ["bundle/**"] }
jobs:
  patrol:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: build kernel-keeper
        run: |
          git clone --depth 1 https://github.com/cla1redonald/kernel-keeper "$RUNNER_TEMP/kernel-keeper"
          npm ci --prefix "$RUNNER_TEMP/kernel-keeper"
          npm run build --prefix "$RUNNER_TEMP/kernel-keeper"
      - run: node "$RUNNER_TEMP/kernel-keeper/dist/cli.js" . --out patrol-report.md --fail-on high
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: patrol-report, path: patrol-report.md }
```

For a skills repo, use the same job with `--register skills --fail-on high`. In a skills repo a HIGH finding means an agent will hit a dead end partway through a run, which is a fair reason to fail the build.

## Notifications (optional)

Kernel Keeper does not send notifications. It writes its report and exits, and passing the result on is the job of whatever runs it on a schedule. There are recipes you can copy in [`examples/notify/`](../examples/notify/).

- `github-action-slack.yml` posts the one-line summary to Slack through an incoming webhook and attaches the report to the run.
- `github-action-teams.yml` does the same for Microsoft Teams, as an Adaptive Card sent through a Teams Workflows webhook.
- `github-action-email.yml` emails the full digest, and only does so when the patrol finds something.
- `local-notify.sh` wraps a patrol for cron, launchd or hooks on your own machine. Turn on whichever channels you want with `SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`, `PATROL_MAIL_TO` or `PATROL_MACOS_NOTIFY=1`, and point `KERNEL_KEEPER_CLI` at `dist/cli.js`.

## Library use

```ts
import { patrol, renderMarkdown, exitCode } from "./dist/index.js"; // or "kernel-keeper" if you link the build
const result = patrol("path/to/repo", { policyDays: 90, journalDays: 30 });
console.log(renderMarkdown(result, "my-kernel", new Date()));
```

For richer frontmatter, pass `{ frontmatterParser: "yaml" }` to `patrol`, `patrolEstate`, `loadBundle` or `loadEstate`, or use `--frontmatter-parser yaml` on the CLI. You only need to install the optional `yaml` package if your register uses multiline scalars, anchors, flow collections or nested frontmatter.

## Boundaries in detail

- Neither walker follows symlinks. A symlinked file or directory is skipped. That includes a symlinked `SKILL.md` inside a plugin cache, which is treated as missing rather than read through. A link could point outside the repo or create a loop, and the patrol must never take in anything the register does not itself contain.
- Plugins are walked to a depth of 6 levels. If a plugin keeps its skills or commands deeper than that, it is reported as a plugin with no recognisable shape (`plugin-shape`, LOW) instead of being walked further.
- If an estate cannot be loaded (`No estate found`, `No such path`), the exit code is `66`, the same as for a bundle.
- Only YAML files under a `definitions/` folder count as governed definitions. Linter or editor config files elsewhere in the repo do not produce pointer-integrity findings.
- Link targets are percent-decoded, so `my%20file.md` resolves to `my file.md`. A real filename that contains text shaped like `%XX` will be resolved to the wrong file, so keep `%` out of concept filenames.
- Frontmatter is read with a simple parser by default, and full YAML is something you opt into. See [memory-doctrine.md](memory-doctrine.md).
