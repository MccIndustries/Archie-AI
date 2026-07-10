-- Run this once in the Supabase SQL editor for the project used by FlowSuite.

-- location_id tags every row with which client's GHL location it belongs
-- to. FlowSuite is one single shared deployment serving every client --
-- this column (and the app-level filtering on it) is what keeps one
-- client's data from ever showing up in another client's session despite
-- sharing tables. The tenant for a request is resolved from the logged-in
-- user's `clients` row (see below), not from any deployment-level env var.
create table if not exists sync_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  location_id text,
  user_email text,
  action text not null,        -- e.g. 'contact.create', 'contact.tags.add', 'job.stage.move'
  entity_type text not null,   -- 'contact' | 'job'
  entity_id text,
  request jsonb,
  success boolean not null,
  error text
);

create index if not exists sync_log_created_at_idx on sync_log (created_at desc);
create index if not exists sync_log_location_id_idx on sync_log (location_id);

-- Portal users are created via Supabase Auth (email/password) directly --
-- e.g. in the Supabase dashboard under Authentication > Users, or via
-- supabase.auth.admin.createUser() -- no separate app-level users table
-- is needed for this pass.

-- Job paperwork/photos uploaded from the intake form. The files themselves
-- live in the "job-files" Storage bucket (created automatically by the
-- server); this table just indexes them by job (GHL opportunity ID).
create table if not exists job_files (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  location_id text,
  job_id text not null,
  path text not null,
  content_type text,
  uploaded_by text,
  category text  -- e.g. 'Photos', 'Insurance Documents', 'Paperwork', or a free-typed custom category
);

create index if not exists job_files_job_id_idx on job_files (job_id);
create index if not exists job_files_location_id_idx on job_files (location_id);

-- Central registry of every client onboarded onto FlowSuite. Managed by
-- the Admin portal (Supabase Auth user tagged app_metadata.role='admin').
-- This is the LIVE source of GHL credentials for the single shared
-- deployment -- requireAuth resolves each logged-in user's client row
-- (via app_metadata.client_id) on every request, so saving values here
-- takes effect immediately, no redeploy. A freshly created account has
-- neither ghl_location_id nor ghl_api_token yet (both null) until the
-- Admin portal fills them in, hence both are nullable.
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  ghl_location_id text unique,
  ghl_api_token text,
  ghl_calendar_id text,
  ghl_pipeline_id text,
  notes text
);

-- Migration for a pre-existing clients table created before this change:
-- alter table clients alter column ghl_location_id drop not null;
-- alter table clients alter column ghl_api_token drop not null;
