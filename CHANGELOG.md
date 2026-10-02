# Changelog

## Unreleased

- **Sync**: an incremental run falls back to a full listing when the last-login index
  is empty, missing, or newer than the cutoff, so the index can be configured before
  the game writes it. The mock server now lists a missing ordered datastore as empty,
  as Open Cloud does.

## 0.1.0 (2026-09-18)

First release.

- **Sync** of any number of DataStores through Open Cloud v2: hash-deduplicated
  snapshots, an observation per check, resumable runs, request pacing with a
  schedule window, Studio test player filtering, incremental runs via a game-written
  last-login OrderedDataStore, revision-history backfill, users API enrichment,
  right-to-erasure purge.
- **Profiles**: composite versions across datastores ordered by Roblox write time;
  supplemental datastores mounted into the document with per-store discovery mode.
- **Facts** in JSONata: scalar, keyed and event shapes; counter, gauge, boolean,
  timestamp and label semantics; DocumentService envelope support; helpers for Lua
  serialisation quirks; constants as bindings.
- **Derivation**: milestones and flags with bounded timing and precision, stat deltas
  with per-day rates and reset detection, segment membership per version.
- **Views**: generated wide current-state and history views, one column per fact and
  segment.
- **Grafana**: provisioned datasources per tenant and four config-agnostic dashboards
  (sync health, player state, progression, cohorts).
- **Demo**: a synthetic game with a sparse purchase store, a mock Open Cloud server,
  and `pulse demo seed`, which replays weeks of history into a separate demo database.
- **Schema management**: one `schema.sql` for fresh databases, one migration per release.
