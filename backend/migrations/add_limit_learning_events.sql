-- Persistent "limit learning" events (WA/TG)
-- Run in Supabase SQL Editor. Safe to run multiple times.

create table if not exists public.limit_learning_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  user_id uuid not null,
  channel text not null check (channel in ('wa', 'tg')),

  -- e.g. 'wa_rate_limit', 'tg_flood_wait'
  event_type text not null,

  -- optional numeric signal (e.g. flood-wait seconds, retry-after seconds)
  seconds integer,

  -- optional context fields for analysis
  campaign_id uuid,
  job_id uuid,
  group_jid text,
  template_id uuid,

  -- label from code-path (e.g. 'text_only', 'image', etc.)
  label text,

  -- short error message (truncated in app before insert)
  error text
);

create index if not exists idx_limit_learning_events_user_time
  on public.limit_learning_events (user_id, created_at desc);

create index if not exists idx_limit_learning_events_channel_time
  on public.limit_learning_events (channel, created_at desc);

create index if not exists idx_limit_learning_events_type_time
  on public.limit_learning_events (event_type, created_at desc);

comment on table public.limit_learning_events is
  'Accumulated observations of external rate limits (WA rate-overlimit/retry-after, TG FLOOD_WAIT, etc.) for weekly analysis.';

