---
type: Proposal
id: P-northwind-promote-command
proposer: procedure-promoter
model: manual-fixture
prompt-sha256: 824ca4cd00264683194243e3566cd76a1feaca97551caf39efbe09c6a12bc865
reviewed-surface-sha256: ef35b729b335464afbd8e4167a1231837fee7098553f4bc424a6f5cf3ec1030c
reviewed-surface: [patrol.md:b7f6a2d2b2ecc511c8fae104a09398a3eae0a2e37af8da231aca8aac706329d1]
target: customer-reconnection-insight.md
kind: new-procedure
checks: [procedure-gap]
confidence: high
needs-human: true
evidence: [patrol.md]
generated-at: 2026-07-20T10:00:00.000Z
usage-tokens: 0+0
status: pending
elected: false
---
# Proposal P-northwind-promote-command - Promote repeated customer reconnection lesson

> Drafted by **the Drift Reviewer** - a human elects; nothing below applies itself. The Draft blocks are **immutable**: record any changes under Amendment, never by editing the draft.

## Rationale
Repeated support reviews showed that reconnection should be treated as a trust event and turned into a governed command.

## Evidence
- `patrol.md`: "Run kernel-keeper against the synthetic memory lab before release."

## Draft (immutable)
### New procedure: customer-reconnection-insight.md
```markdown
---
description: Capture customer reconnection as a trust event.
owner: Product Ops
id: command:customer-reconnection-insight
---
# Customer Reconnection Insight

Use this when support, research, or product notes repeat the pattern that reconnection is a trust event rather than a settings chore.

1. Gather the customer quote or receipt.
2. Link it to the truth register item it supports.
3. Draft the smallest governed update or proposal.

```
### Journal line (paste into log.md on election)
```markdown
- **2026-07-20** - promoted customer reconnection insight command [proposal: P-northwind-promote-command] [decision: elected] [by: Claire]
```

## Decision
- [ ] Elect - apply as drafted
- [ ] Amend - record changes under Amendment, then elect
- [ ] Reject

Judge: ______   Date: ______

## Amendment
