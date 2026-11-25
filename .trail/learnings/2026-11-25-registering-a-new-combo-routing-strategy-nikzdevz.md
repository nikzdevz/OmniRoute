---
title: Registering a new combo routing strategy (OmniRoute checklist)
author: Nikzdevz
date: 2026-11-25
branch: main
touches:
  - AGENTS.md
  - CLAUDE.md
  - README.md
  - skills/cli-a2a/SKILL.md
  - skills/cli-backup-sync/SKILL.md
  - skills/cli-batches/SKILL.md
  - skills/cli-chat/SKILL.md
  - skills/cli-compression/SKILL.md
  - skills/cli-contexts/SKILL.md
  - skills/cli-cost-usage/SKILL.md
---

## Decided
- New combo strategy = value in ROUTING_STRATEGY_VALUES + ROUTING_STRATEGIES (src/shared/constants/routingStrategies.ts); TypeScript then compile-enforces the strategyRegistry.ts traits entry and the applyStrategyOrdering.ts STRATEGY_ORDERERS entry.
- Docs contract: the PR writes the AUTO-COMBO.md table row AND the strategy names into the ARCHITECTURE.md / docs/guides/FEATURES.md inline lists; npm run release:refresh-derived rewrites only the COUNTS + derived-facts.json (its provider-reference step fails on Windows without symlink permission, after the counts are already written).
- tests/unit/combo/strategy-registry.test.ts: bump the CANONICAL count assertion, add the new strategy to the registry-era parity exclusion set, pin its traits with a dedicated test.
- DB migrations after legacy 241 must be YYYYMMDDHHMMSS_name.sql (check:migration-numbering); migrationRunner sorts by numeric version so timestamped files apply after legacy NNN files.

## Tried and ruled out
- Editing the locally replaced working-tree AGENTS.md to satisfy the docs-sync test: wrong move - the committed HEAD copy passes; the failure is environmental to the dirty checkout, not a code problem.

## Watch out
- The docs-sync AGENTS.md test reads the WORKING TREE: a locally modified AGENTS.md fails the local suite even though CI passes on a clean checkout.
- Pre-existing red checks that survive this change and must not be mistaken for regressions: check:migration-numbering (242_api_keys_max_concurrent.sql), check:docs-counts (i18n README mirrors still say 241 migrations), typecheck:core (providerPrefixCollision.ts + sse/services/model.ts).
