#!/usr/bin/env node
const path = require('path');
const fs = require('fs');

// env
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });
} catch (_) {}

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

if (!url || !key) {
  console.error('SUPABASE_URL / SERVICE_ROLE_KEY не заданы');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const userId = process.argv[2] || '83faa8be-2ee2-45bf-88f7-d971c9d0d9d2';

(async () => {
  const { data, error } = await supabase
    .from('telegram_groups')
    .select('tg_chat_id, title, tg_type')
    .eq('user_id', userId)
    .or('title.is.null,title.eq("")')
    .limit(50);

  if (error) {
    console.error('Supabase error:', error);
    process.exit(1);
  }

  console.log('userId:', userId);
  console.log('groups with empty title:', data.length);
  for (const g of data) {
    console.log(JSON.stringify(g));
  }
})();
