-- rbx-pulse schema 0.1.0
--
-- The complete schema for a fresh database. `pulse db migrate` loads this file into an
-- empty database, then records every db/migrations/<version>.sql as already applied,
-- because this file always reflects the newest one. Existing databases never run this
-- file; they run the per-release migrations instead. See db/README.md.
--
-- Raw snapshots are the only source of truth. Every other table is rebuildable from them.

-- ---------------------------------------------------------------- players and sync

CREATE TABLE player (
  user_id            BIGINT PRIMARY KEY,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ,
  -- Open Cloud entry createTime of the primary datastore: effectively install date.
  entry_created_at   TIMESTAMPTZ,
  purged_at          TIMESTAMPTZ,
  -- Enrichment from the users API (`pulse enrich`).
  username           TEXT,
  display_name       TEXT,
  account_created_at TIMESTAMPTZ,
  locale             TEXT,
  premium            BOOLEAN,
  enriched_at        TIMESTAMPTZ
);

CREATE TABLE sync_run (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running',   -- running | paused | completed | failed
  config_hash  TEXT,
  -- Resumption state: per-datastore page tokens, counters, discovery mode and cutoff.
  cursor       JSONB NOT NULL DEFAULT '{}'::jsonb,
  stats        JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- One row per distinct content of a player's entry in a datastore.
CREATE TABLE snapshot (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES player(user_id) ON DELETE CASCADE,
  datastore           TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  body                JSONB NOT NULL,
  revision_id         TEXT,
  revision_created_at TIMESTAMPTZ,
  entry_created_at    TIMESTAMPTZ,
  observed_at         TIMESTAMPTZ NOT NULL,
  sync_run_id         BIGINT REFERENCES sync_run(id) ON DELETE SET NULL,
  -- sync: fetched by a sync run; backfill: reconstructed from Open Cloud revision history.
  source              TEXT NOT NULL DEFAULT 'sync'
);
CREATE INDEX snapshot_user_ds_observed ON snapshot (user_id, datastore, observed_at DESC);
CREATE INDEX snapshot_run ON snapshot (sync_run_id);
CREATE INDEX snapshot_revision ON snapshot (user_id, datastore, revision_id);

-- Every check of a key, whether or not the content changed.
CREATE TABLE observation (
  id           BIGSERIAL PRIMARY KEY,
  sync_run_id  BIGINT NOT NULL REFERENCES sync_run(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES player(user_id) ON DELETE CASCADE,
  datastore    TEXT NOT NULL,
  observed_at  TIMESTAMPTZ NOT NULL,
  changed      BOOLEAN NOT NULL,
  snapshot_id  BIGINT REFERENCES snapshot(id) ON DELETE SET NULL,
  revision_id  TEXT,
  -- ok | missing (a listed key vanished) | absent (a supplemental store has no entry for
  -- a player reached through the login index; expected) | error
  status       TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX observation_run ON observation (sync_run_id);
CREATE INDEX observation_user ON observation (user_id, datastore, observed_at DESC);

-- ---------------------------------------------------------------- profiles and facts

-- One row per distinct combination of component snapshots for a player, ordered by the
-- write time Roblox reports (revision time). observed_at is when we saw the state: the
-- last moment the previous state is known to have held, hence the lower bound for timing.
CREATE TABLE profile_version (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES player(user_id) ON DELETE CASCADE,
  version_no          INT NOT NULL,
  components          JSONB NOT NULL,                 -- {datastore: snapshot_id}
  max_snapshot_id     BIGINT NOT NULL,
  valid_from          TIMESTAMPTZ NOT NULL,
  valid_to            TIMESTAMPTZ,                    -- NULL = current version
  revision_created_at TIMESTAMPTZ,                    -- latest write among components
  observed_at         TIMESTAMPTZ,
  extracted_at        TIMESTAMPTZ,
  config_hash         TEXT,                           -- facts/segments/constants config the extraction used
  derived_hash        TEXT,                           -- facts/milestones/flags/constants config the derivation used
  UNIQUE (user_id, version_no)
);
CREATE INDEX profile_version_current ON profile_version (user_id) WHERE valid_to IS NULL;
CREATE INDEX profile_version_pending ON profile_version (id) WHERE extracted_at IS NULL;
CREATE INDEX profile_version_config ON profile_version (config_hash);
CREATE INDEX profile_version_underived ON profile_version (user_id) WHERE derived_hash IS NULL;

-- Long fact table. kind mirrors the fact's semantics; exactly one value column is set.
CREATE TABLE fact (
  id                 BIGSERIAL PRIMARY KEY,
  profile_version_id BIGINT NOT NULL REFERENCES profile_version(id) ON DELETE CASCADE,
  user_id            BIGINT NOT NULL REFERENCES player(user_id) ON DELETE CASCADE,
  key                TEXT NOT NULL,
  dim                TEXT NOT NULL DEFAULT '',        -- keyed facts: the map key; '' for scalars
  kind               TEXT NOT NULL,                   -- counter | gauge | boolean | timestamp | label
  num                DOUBLE PRECISION,
  bool               BOOLEAN,
  text               TEXT,
  ts                 TIMESTAMPTZ,
  valid_from         TIMESTAMPTZ NOT NULL,            -- denormalized from the version
  valid_to           TIMESTAMPTZ,
  UNIQUE (profile_version_id, key, dim)
);
CREATE INDEX fact_key_current ON fact (key, dim) WHERE valid_to IS NULL;
CREATE INDEX fact_user ON fact (user_id, key);

-- Events harvested from rolling activity logs and timestamped lists. Additive; deduplicated.
CREATE TABLE event (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES player(user_id) ON DELETE CASCADE,
  type                  TEXT NOT NULL,
  data                  TEXT NOT NULL DEFAULT '',
  ts                    TIMESTAMPTZ NOT NULL,
  first_seen_version_id BIGINT REFERENCES profile_version(id) ON DELETE SET NULL,
  attrs                 JSONB,                        -- optional structured payload; not part of the identity
  UNIQUE (user_id, type, data, ts)
);
CREATE INDEX event_type_ts ON event (type, ts);

-- Segment membership per profile version, so cohort composition is reconstructible
-- at any past point in time.
CREATE TABLE segment_membership (
  id                 BIGSERIAL PRIMARY KEY,
  profile_version_id BIGINT NOT NULL REFERENCES profile_version(id) ON DELETE CASCADE,
  user_id            BIGINT NOT NULL REFERENCES player(user_id) ON DELETE CASCADE,
  key                TEXT NOT NULL,
  member             BOOLEAN NOT NULL,                -- boolean segments: the value; label segments: label IS NOT NULL
  label              TEXT,                            -- label segments: the category
  valid_from         TIMESTAMPTZ NOT NULL,
  valid_to           TIMESTAMPTZ,
  UNIQUE (profile_version_id, key)
);
CREATE INDEX segment_membership_current ON segment_membership (key, label) WHERE valid_to IS NULL;
CREATE INDEX segment_membership_user ON segment_membership (user_id, key);
CREATE INDEX segment_membership_range ON segment_membership (key, valid_from, valid_to);

-- Which generated objects (views) exist and from which config.
CREATE TABLE applied_config (
  name       TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  body       JSONB
);

-- ---------------------------------------------------------------- derived

-- First profile version in which a milestone or flag condition held, with a bounded time.
CREATE TABLE milestone_event (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES player(user_id) ON DELETE CASCADE,
  key                TEXT NOT NULL,
  kind               TEXT NOT NULL,                   -- milestone | flag
  ordinal            INT NOT NULL,                    -- position in config (milestones are ordered)
  reached_lo         TIMESTAMPTZ,                     -- NULL = unknown lower bound
  reached_hi         TIMESTAMPTZ NOT NULL,
  precision          TEXT NOT NULL,                   -- exact | revision | interval
  profile_version_id BIGINT REFERENCES profile_version(id) ON DELETE CASCADE,
  config_hash        TEXT NOT NULL,
  UNIQUE (user_id, key)
);
CREATE INDEX milestone_event_key ON milestone_event (key, reached_hi);

-- Change of every counter/gauge fact between consecutive profile versions.
CREATE TABLE stat_delta (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES player(user_id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  dim             TEXT NOT NULL DEFAULT '',
  from_version_id BIGINT NOT NULL REFERENCES profile_version(id) ON DELETE CASCADE,
  to_version_id   BIGINT NOT NULL REFERENCES profile_version(id) ON DELETE CASCADE,
  from_at         TIMESTAMPTZ NOT NULL,               -- previous observation
  to_at           TIMESTAMPTZ NOT NULL,               -- this version's revision time (or observation)
  from_value      DOUBLE PRECISION NOT NULL,
  to_value        DOUBLE PRECISION NOT NULL,
  delta           DOUBLE PRECISION NOT NULL,
  per_day         DOUBLE PRECISION NOT NULL,          -- delta normalized by elapsed days
  reset           BOOLEAN NOT NULL DEFAULT false,     -- a counter went down
  UNIQUE (to_version_id, key, dim)
);
CREATE INDEX stat_delta_key_time ON stat_delta (key, to_at);
CREATE INDEX stat_delta_user ON stat_delta (user_id, key);

-- ---------------------------------------------------------------- fixed views
-- (v_player_current and v_player_history are generated from config by `pulse config apply`.)

-- Facts of each player's current profile version.
CREATE VIEW v_fact_current AS
  SELECT f.* FROM fact f WHERE f.valid_to IS NULL;

CREATE VIEW v_segment_current AS
  SELECT s.* FROM segment_membership s WHERE s.valid_to IS NULL;

-- When each player was last seen changing (i.e. last played, at sync resolution).
CREATE VIEW v_player_activity AS
  SELECT p.user_id,
         p.entry_created_at,
         max(o.observed_at) FILTER (WHERE o.changed) AS last_changed_at,
         max(o.observed_at) AS last_checked_at,
         count(*) FILTER (WHERE o.changed) AS times_changed
    FROM player p
    LEFT JOIN observation o ON o.user_id = p.user_id
   WHERE p.purged_at IS NULL
   GROUP BY p.user_id, p.entry_created_at;
