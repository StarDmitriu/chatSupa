-- RLS для public.campaign_jobs (рекомендация Supabase Lint)
-- Бэкенд использует SUPABASE_SERVICE_ROLE_KEY и обходит RLS — доступ к таблице сохраняется.
-- Роли anon и authenticated лишаются прямого доступа; все запросы идут через наш API с service_role.

-- 1) Включить RLS (по умолчанию доступ запрещён, пока нет политик)
ALTER TABLE public.campaign_jobs ENABLE ROW LEVEL SECURITY;

-- 2) Запретить прямой доступ через anon/authenticated (доступ только через бэкенд с service_role)
REVOKE ALL ON TABLE public.campaign_jobs FROM anon, authenticated;

-- При необходимости вернуть права на SELECT/INSERT/UPDATE/DELETE только для роли, которой пользуется PostgREST:
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.campaign_jobs TO authenticated;
-- Тогда нужны политики (см. комментарии ниже). У нас бэкенд использует service_role и обходит RLS, поэтому REVOKE достаточно.
