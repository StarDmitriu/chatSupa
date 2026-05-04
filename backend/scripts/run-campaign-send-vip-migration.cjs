/**
 * Одноразовая миграция: users.campaign_send_vip
 * Запуск: node scripts/run-campaign-send-vip-migration.cjs
 */
require('dotenv').config();
const { Client } = require('pg');

const sql = `
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS campaign_send_vip boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.users.campaign_send_vip IS 'Higher priority for BullMQ campaign-send jobs (merged with env CAMPAIGN_VIP_USER_IDS).';
`;

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url || url.includes('ВАШ_ПАРОЛЬ')) {
    console.error('Set SUPABASE_DB_URL in .env');
    process.exit(1);
  }
  const c = new Client({
    connectionString: url,
    ssl: url.includes('supabase') ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  await c.query(sql);
  await c.end();
  console.log('OK: campaign_send_vip');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
