-- Soft quarantine for Telegram groups (auto-heal friendly, reversible).
alter table if exists public.telegram_groups
  add column if not exists quarantine_until timestamptz null,
  add column if not exists quarantine_reason text null;

create index if not exists idx_telegram_groups_user_quarantine_until
  on public.telegram_groups (user_id, quarantine_until);
