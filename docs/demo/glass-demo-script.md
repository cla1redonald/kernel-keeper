# Glass Demo Script

Use this to show Kernel Keeper Glass without touching a real vault or repo.

## Start

```bash
npm run build
node dist/cli.js glass-demo --port 8787
```

Open the printed `glass-demo:` URL.

## Story

1. Open **Review Queue** to show that Glass scans the same governed surface as the CLI.
2. Open **Proposals** and select `P-northwind-promote-command`.
3. Point out the promotion card:
   - truth register = what the team believes
   - procedure estate = what agents are allowed to do
   - promotion = repeated learning becoming governed behaviour
4. Click **Approve**.
5. Open **Apply** and inspect the deterministic diff.
6. Click **Apply Approved**.
7. Show **Audit History** and the generated `customer-reconnection-insight.md` command in the printed temp demo root.

## Message

Kernel Keeper does not ask a business reviewer to use Markdown, CLI, or Git.
The kernel still uses deterministic files underneath, but Glass turns that kernel into a review console: findings, proposals, approvals, apply previews, writes, and audit trails.

## Notion Approval Surface

Use this to show the same loop as a business approval board.

```bash
node dist/cli.js notion sync tests/fixtures/northwind-memory-lab/estate \
  --register commands \
  --proposals tests/fixtures/northwind-memory-lab/proposals \
  --dry-run \
  --now 2026-07-21T12:00:00.000Z
```

The dry run prints the Notion database row and proposal page blocks without using a token.

For a live disposable Notion data source with the required properties:

```bash
NOTION_TOKEN=... node dist/cli.js notion sync <estate-root> --register commands --proposals <proposal-dir> --notion-database <data-source-id>
NOTION_TOKEN=... node dist/cli.js notion decisions <estate-root> --register commands --proposals <proposal-dir> --notion-database <data-source-id>
node dist/cli.js apply <estate-root> --register commands --proposals <proposal-dir> --write
NOTION_TOKEN=... node dist/cli.js notion audit <estate-root> --register commands --proposals <proposal-dir> --notion-database <data-source-id>
```

The reviewer does not need to touch Markdown. In Notion, open a proposal page and set the **Decision** property:

- `Approved` means the proposal is elected and may be applied by the Clerk.
- `Rejected` means the proposal must not be applied.
- `Request edit` means the proposal needs a human amendment first.
- Blank means the proposal is still under review.

The point is the same constitution in a business tool: Notion shows the proposal, the human records the decision there, Kernel Keeper syncs that decision into the canonical proposal, the Clerk previews and applies only elected changes, and the outcome is written back to Notion.
