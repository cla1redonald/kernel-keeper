# Glass Demo Script

Use this script to show Kernel Keeper Glass without touching a real vault or repo.

## Start

```bash
npm run build
node dist/cli.js glass-demo --port 8787
```

Open the `glass-demo:` URL that it prints.

## Story

1. Open **Review Queue**. Glass is scanning exactly the same files and running the same checks as the CLI.
2. Open **Proposals** and select `P-northwind-promote-command`.
3. Point out the promotion card. It shows something the team keeps relearning being turned into a command that agents will follow. The truth register holds what the team believes. The procedure estate holds what agents are allowed to do. A promotion moves a lesson from the first into the second.
4. Click **Approve**.
5. Open **Apply** and look through the diff. It is worked out by plain code, so it will be the same every time.
6. Click **Apply Approved**.
7. Show **Audit History**, then show the new `customer-reconnection-insight.md` command in the temporary demo folder whose path was printed at the start.

## Message

A business reviewer does not have to use Markdown, the command line or Git to work with Kernel Keeper. Underneath, everything is still kept in plain files and changed by plain code. Glass puts a review console on top of those files, where the reviewer can see the findings and proposals, approve them, preview what apply will change, write it, and read the audit trail afterwards.

## Notion Approval Surface

Use this to show the same loop running as an approval board in a business tool.

```bash
node dist/cli.js notion sync tests/fixtures/northwind-memory-lab/estate \
  --register commands \
  --proposals tests/fixtures/northwind-memory-lab/proposals \
  --dry-run \
  --now 2026-07-21T12:00:00.000Z
```

The dry run prints the Notion database row and the proposal page blocks it would create, without using a token.

For a live run against a disposable Notion data source that has the required properties:

```bash
NOTION_TOKEN=... node dist/cli.js notion sync <estate-root> --register commands --proposals <proposal-dir> --notion-database <data-source-id>
NOTION_TOKEN=... node dist/cli.js notion decisions <estate-root> --register commands --proposals <proposal-dir> --notion-database <data-source-id>
node dist/cli.js apply <estate-root> --register commands --proposals <proposal-dir> --write
NOTION_TOKEN=... node dist/cli.js notion audit <estate-root> --register commands --proposals <proposal-dir> --notion-database <data-source-id>
```

The reviewer does not need to touch Markdown. In Notion, they open a proposal page and set its **Decision** property.

- `Approved` means the proposal is elected and the Clerk may apply it.
- `Rejected` means the proposal must not be applied.
- `Request edit` means a person has to amend the proposal first.
- Blank means the proposal is still under review.

The rules are the same as everywhere else in Kernel Keeper, only now they run through Notion. Notion shows the proposal and the reviewer records the decision there. Kernel Keeper copies that decision into the proposal file, which remains the record. The Clerk previews the change and applies only what was elected, and the result is written back to Notion.
