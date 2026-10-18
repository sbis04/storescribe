-- StoreScribe on Tiger Cloud (TimescaleDB). Runs on every boot, so everything is idempotent.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE SCHEMA IF NOT EXISTS storescribe;
SET search_path = storescribe, public;

-- A workspace is one browser (no sign-up). The id lives in the browser's storage.
CREATE TABLE IF NOT EXISTS workspaces (
  id         UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS apps (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  pitch        TEXT NOT NULL,
  details      TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  audience     TEXT NOT NULL DEFAULT '',
  features     TEXT NOT NULL DEFAULT '',          -- what Gemma saw in the screenshots
  seed_terms   TEXT[] NOT NULL DEFAULT '{}',
  ios_id       TEXT,                              -- for rank tracking once the app is live
  android_id   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apps_workspace ON apps (workspace_id, created_at DESC);

-- Every generated listing, per store and language, kept forever as a version you can compare and roll back to.
CREATE TABLE IF NOT EXISTS listing_versions (
  time       TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_id     BIGINT NOT NULL,
  version    INT NOT NULL,
  store      TEXT NOT NULL,                       -- ios | android
  locale     TEXT NOT NULL,
  fields     JSONB NOT NULL,
  issues     JSONB NOT NULL DEFAULT '[]',
  research   JSONB,                               -- competitor terms the draft was written against
  model      TEXT NOT NULL,
  tokens_in  INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  ms         INT NOT NULL DEFAULT 0
);
SELECT create_hypertable('storescribe.listing_versions', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS listing_versions_app ON listing_versions (app_id, version DESC, time DESC);

-- Daily rank of an app for a search term, from SerpApi. This is the time series the rank chart reads.
CREATE TABLE IF NOT EXISTS keyword_ranks (
  time    TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_id  BIGINT NOT NULL,
  store   TEXT NOT NULL,
  term    TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'us',
  rank    INT                                     -- NULL = not in the top results
);
SELECT create_hypertable('storescribe.keyword_ranks', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS keyword_ranks_app ON keyword_ranks (app_id, store, term, time DESC);

-- Metering: every model call and search, with its cost. A subscription is priced off this.
CREATE TABLE IF NOT EXISTS usage (
  time         TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id UUID NOT NULL,
  kind         TEXT NOT NULL,                     -- screens | draft | fix | translate | search | rank
  tokens_in    INT NOT NULL DEFAULT 0,
  tokens_out   INT NOT NULL DEFAULT 0,
  searches     INT NOT NULL DEFAULT 0,
  cost_usd     NUMERIC(12, 6) NOT NULL DEFAULT 0
);
SELECT create_hypertable('storescribe.usage', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS usage_daily
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 day', time) AS day,
       workspace_id,
       count(*) FILTER (WHERE kind = 'draft')     AS listings,
       count(*) FILTER (WHERE kind = 'translate') AS translations,
       sum(searches)                              AS searches,
       sum(tokens_in)                             AS tokens_in,
       sum(tokens_out)                            AS tokens_out,
       sum(cost_usd)                              AS cost_usd
FROM usage
GROUP BY day, workspace_id
WITH NO DATA;
SELECT add_continuous_aggregate_policy('storescribe.usage_daily',
  start_offset => INTERVAL '40 days', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes', if_not_exists => TRUE);
ALTER MATERIALIZED VIEW usage_daily SET (timescaledb.materialized_only = false);

CREATE TABLE IF NOT EXISTS serp_cache (
  store      TEXT NOT NULL,
  term       TEXT NOT NULL,
  country    TEXT NOT NULL,
  results    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store, term, country)
);

-- Rate limits and the daily spend cap live here so a redeploy doesn't reset them.
CREATE TABLE IF NOT EXISTS rate_hits (
  bucket TEXT NOT NULL,
  at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_hits_bucket_at ON rate_hits (bucket, at DESC);
