-- Per-user WhatsApp proxy settings (sticky by user/session).
create table if not exists public.wa_user_proxy_settings (
  user_id uuid primary key references public.users(id) on delete cascade,
  enabled boolean not null default false,
  proxy_url text null,
  fail_open_direct boolean not null default true,
  max_consecutive_failures integer not null default 6,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wa_user_proxy_settings_enabled
  on public.wa_user_proxy_settings (enabled);
