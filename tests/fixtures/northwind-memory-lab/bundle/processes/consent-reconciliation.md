---
type: Process
id: process:consent-reconciliation
title: Consent reconciliation
description: Procedure for reconciling consent export rows against customer state.
timestamp: 2026-07-20
last-affirmed: 2026-07-20
owner: Data Ops
---
# Consent reconciliation

As of 2026-07-20, consent reconciliation compares raw export rows with the consent lifecycle model.

**Owner.** Data Ops

1. Read [consent lifecycle](/facts/consent-lifecycle.md).
2. Compare rows in [consent export](/raw/consent-export.csv).
3. Record exceptions in the weekly ops journal.
