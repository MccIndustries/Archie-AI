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
-- name/email/phone/contact_name are captured from the GHL "Portal Optin"
-- form via the signup webhook (server/routes/webhooks.js) -- email is
-- unique so a duplicate form submission is recognized and skipped rather
-- than creating a second row.
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  email text unique,
  phone text,
  contact_name text,
  ghl_location_id text unique,
  ghl_api_token text,
  ghl_calendar_id text,
  ghl_pipeline_id text,
  notes text
);

-- Migration for a pre-existing clients table created before this change:
-- alter table clients alter column ghl_location_id drop not null;
-- alter table clients alter column ghl_api_token drop not null;
-- alter table clients add column if not exists email text unique;
-- alter table clients add column if not exists phone text;
-- alter table clients add column if not exists contact_name text;

-- Sticky notes shown in the portal for a contact -- covers both notes added
-- directly on a contact AND notes added from a specific job (source/job_id
-- tell those apart so the UI can show a "Job" badge + link-back for the
-- latter). Every write here is mirrored in realtime to the contact's real
-- GHL note (ghl_note_id keeps the two in sync for later edits/deletes) --
-- GHL has no separate "opportunity note" concept, only contact notes, so
-- job-sourced notes are mirrored there too, prefixed with the job's case
-- number so they're identifiable from inside GHL itself.
create table if not exists contact_notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  location_id text not null,
  contact_id text not null,
  job_id text,               -- set only when source = 'job'
  source text not null default 'contact', -- 'contact' | 'job'
  body text not null,
  created_by text,
  ghl_note_id text
);

create index if not exists contact_notes_contact_id_idx on contact_notes (contact_id);
create index if not exists contact_notes_job_id_idx on contact_notes (job_id);
create index if not exists contact_notes_location_id_idx on contact_notes (location_id);

-- Which conversations a tenant has starred. GHL's own conversation search
-- endpoint doesn't expose or filter by "starred" at all (confirmed live --
-- only the single-conversation GET reflects it, and re-fetching that per
-- conversation just to know starred status doesn't scale) -- this table is
-- the actual source of truth for the "Starred" filter tab. Every
-- star/unstar here is still mirrored to GHL's own PUT /conversations/:id
-- (best-effort) purely so the shop's real GHL account stays consistent.
create table if not exists starred_conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  location_id text not null,
  conversation_id text not null,
  contact_id text,
  created_by text,
  unique (location_id, conversation_id)
);

create index if not exists starred_conversations_location_id_idx on starred_conversations (location_id);

-- Saved contact filters ("Smart Lists" in GHL's own terminology) -- a
-- named, reusable set of the same filters already supported by the
-- Contacts tab (tags/date range/search query), stored as-is in `filters`
-- and re-applied client-side when clicked.
create table if not exists smart_lists (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  location_id text not null,
  name text not null,
  filters jsonb not null default '{}'::jsonb,
  created_by text
);

create index if not exists smart_lists_location_id_idx on smart_lists (location_id);
