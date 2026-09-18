# Initial design decisions

Date: 2026-09-17. Status: in force, except where noted.

1. **Stack.** TypeScript on Node 22+, Postgres 16, Grafana, all in docker-compose. Chosen
   for a single-operator, run-it-locally tool with no hosted component.
2. **Expression language.** JSONata for every user-defined extraction, condition and
   label. One language, sandboxed, expressive enough for map/filter/reduce over nested
   records, and testable against a record file without a database.
3. **Storage shape.** One long `fact` table plus generated wide views, instead of a table
   per config. Config changes never require schema migrations.
4. **Milestone timing.** A bounded interval with a precision tag, never a single guessed
   timestamp. Weekly syncs cannot know when a change happened; pretending otherwise
   would mislead every time-to-milestone chart.
5. **Sync budget.** A hard requests-per-minute ceiling, a fraction of the header-reported
   budget, and an optional schedule window. Conservative by default because the budget
   is shared with the live game. Observed the same day: the rate-limit headers report
   the API key's limit, not the universe's DataStore throttle, so the ceiling is the
   operative safeguard. Recorded in `src/sync/limiter.ts`.
6. **Revision-history backfill.** Deferred at first. *Superseded 2026-09-17:* implemented
   as `pulse backfill` once the first real sync showed how much recent history the
   30-day revision window holds.

Development ran in phases, each verified against a synthetic demo game and the
operator's real dev universe: skeleton and expression sandbox; sync; profiles and
facts; milestones, flags and stat deltas; segments and cohorts; operations
(scheduling, incremental sync, backfill, enrichment); supplemental datastores. The
result is described in `docs/ARCHITECTURE.md` and the changelog.
