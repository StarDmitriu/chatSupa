#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config({ path: '.env' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

const DUE_PENDING_THRESHOLD = Number(
  process.env.CAMPAIGN_INVARIANT_DUE_PENDING_THRESHOLD || 250,
);
const EXHAUSTED_1H_THRESHOLD = Number(
  process.env.CAMPAIGN_INVARIANT_WA_EXHAUSTED_1H_THRESHOLD || 120,
);
const TG_PEER_ERRORS_1H_THRESHOLD = Number(
  process.env.CAMPAIGN_INVARIANT_TG_PEER_ERRORS_1H_THRESHOLD || 40,
);
const TG_EJECT_LOOKBACK_DAYS = Math.max(
  3,
  Number(process.env.CAMPAIGN_INVARIANT_TG_EJECT_LOOKBACK_DAYS || 14),
);
const TG_EJECT_FAILED_24H_THRESHOLD = Math.max(
  1,
  Number(process.env.CAMPAIGN_INVARIANT_TG_EJECT_FAILED_24H_THRESHOLD || 5),
);
const TG_EJECT_STREAK_DAYS_THRESHOLD = Math.max(
  1,
  Number(process.env.CAMPAIGN_INVARIANT_TG_EJECT_STREAK_DAYS_THRESHOLD || 2),
);
const TG_EJECT_TOP_LIMIT = Math.max(
  5,
  Number(process.env.CAMPAIGN_INVARIANT_TG_EJECT_TOP_LIMIT || 50),
);

const TG_EJECT_REASONS = [
  'CHANNEL_INVALID',
  'CHAT_WRITE_FORBIDDEN',
  'USER_BANNED_IN_CHANNEL',
  'CHANNEL_PRIVATE',
];

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function dayKey(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function run() {
  const violations = [];
  const warnings = [];

  const overlapRaw =
    String(process.env.CAMPAIGN_REPEAT_ALLOW_OVERLAP || '').toLowerCase() === 'true';
  const overlapUnsafe =
    String(process.env.CAMPAIGN_REPEAT_OVERLAP_FORCE_UNSAFE || '').toLowerCase() ===
    'true';
  if (overlapRaw && !overlapUnsafe) {
    violations.push({
      code: 'repeat_overlap_invariant',
      message:
        'CAMPAIGN_REPEAT_ALLOW_OVERLAP=true without CAMPAIGN_REPEAT_OVERLAP_FORCE_UNSAFE=true',
    });
  }

  const nowIso = new Date().toISOString();
  const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Большой duePending по running кампаниям.
  const runningRes = await supabase
    .from('campaigns')
    .select('id,user_id,channel,status,paused')
    .eq('status', 'running')
    .eq('paused', false)
    .limit(200);
  if (runningRes.error) {
    violations.push({
      code: 'supabase_running_campaigns_error',
      message: runningRes.error.message,
    });
  } else {
    for (const camp of runningRes.data || []) {
      const dueRes = await supabase
        .from('campaign_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', camp.id)
        .eq('status', 'pending')
        .lte('scheduled_at', nowIso);
      const due = dueRes.count || 0;
      if (due > DUE_PENDING_THRESHOLD) {
        violations.push({
          code: 'due_pending_runaway',
          campaignId: camp.id,
          userId: camp.user_id,
          channel: camp.channel,
          duePending: due,
          threshold: DUE_PENDING_THRESHOLD,
        });
      } else if (due > Math.floor(DUE_PENDING_THRESHOLD * 0.6)) {
        warnings.push({
          code: 'due_pending_elevated',
          campaignId: camp.id,
          userId: camp.user_id,
          channel: camp.channel,
          duePending: due,
        });
      }
    }
  }

  // Всплеск exhausted за час.
  const exhaustedRes = await supabase
    .from('campaign_jobs')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'failed')
    .eq('channel', 'wa')
    .eq('error', 'wa_connectivity_retry_exhausted')
    .gte('sent_at', oneHourAgoIso);
  const exhausted1h = exhaustedRes.count || 0;
  if (exhausted1h > EXHAUSTED_1H_THRESHOLD) {
    violations.push({
      code: 'wa_exhausted_spike_1h',
      exhausted1h,
      threshold: EXHAUSTED_1H_THRESHOLD,
    });
  }

  // TG peer errors за час: CHANNEL_INVALID / PEER_ID_INVALID.
  const [tgChannelInvalid1hRes, tgPeerInvalid1hRes, tgFailed1hRes] =
    await Promise.all([
      supabase
        .from('campaign_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'failed')
        .eq('channel', 'tg')
        .gte('sent_at', oneHourAgoIso)
        .ilike('error', '%CHANNEL_INVALID%'),
      supabase
        .from('campaign_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'failed')
        .eq('channel', 'tg')
        .gte('sent_at', oneHourAgoIso)
        .ilike('error', '%PEER_ID_INVALID%'),
      supabase
        .from('campaign_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'failed')
        .eq('channel', 'tg')
        .gte('sent_at', oneHourAgoIso),
    ]);
  const tgChannelInvalid1h = tgChannelInvalid1hRes.count || 0;
  const tgPeerInvalid1h = tgPeerInvalid1hRes.count || 0;
  const tgPeerErrors1h = tgChannelInvalid1h + tgPeerInvalid1h;
  const tgFailed1h = tgFailed1hRes.count || 0;
  const tgPeerErrorRate1h = tgFailed1h > 0 ? tgPeerErrors1h / tgFailed1h : 0;
  if (tgPeerErrors1h > TG_PEER_ERRORS_1H_THRESHOLD || tgPeerErrorRate1h > 0.2) {
    violations.push({
      code: 'tg_peer_errors_spike_1h',
      tgPeerErrors1h,
      tgChannelInvalid1h,
      tgPeerInvalid1h,
      tgFailed1h,
      tgPeerErrorRate1h,
      threshold: TG_PEER_ERRORS_1H_THRESHOLD,
    });
  }

  // processing=0 при наличии due_pending в running TG-кампаниях.
  for (const camp of runningRes.data || []) {
    if (String(camp.channel || '') !== 'tg') continue;
    const [dueRes, processingRes] = await Promise.all([
      supabase
        .from('campaign_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', camp.id)
        .eq('status', 'pending')
        .lte('scheduled_at', nowIso),
      supabase
        .from('campaign_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', camp.id)
        .eq('status', 'processing'),
    ]);
    const due = dueRes.count || 0;
    const processing = processingRes.count || 0;
    if (due > 0 && processing === 0) {
      warnings.push({
        code: 'tg_due_pending_without_processing',
        campaignId: camp.id,
        userId: camp.user_id,
        duePending: due,
      });
    }
  }

  // Daily TG eject candidates report (groups likely to fail repeatedly).
  const tgLookbackFromIso = isoDaysAgo(TG_EJECT_LOOKBACK_DAYS);
  const tg24hFromIso = isoDaysAgo(1);
  const tgJobsLookbackRes = await supabase
    .from('campaign_jobs')
    .select('group_jid,status,error,sent_at,channel')
    .eq('channel', 'tg')
    .not('group_jid', 'is', null)
    .gte('sent_at', tgLookbackFromIso)
    .limit(50000);

  const dailyEjectCandidates = [];
  if (tgJobsLookbackRes.error) {
    warnings.push({
      code: 'tg_eject_candidates_fetch_error',
      message: tgJobsLookbackRes.error.message,
    });
  } else {
    const perGroup = new Map();
    for (const row of tgJobsLookbackRes.data || []) {
      const groupJid = String(row.group_jid || '').trim();
      if (!groupJid) continue;
      if (!perGroup.has(groupJid)) {
        perGroup.set(groupJid, {
          failed24h: 0,
          sent24h: 0,
          reasons24h: Object.fromEntries(TG_EJECT_REASONS.map((r) => [r, 0])),
          failuresByDay: new Map(), // day -> failed
          sentByDay: new Map(), // day -> sent
        });
      }
      const bag = perGroup.get(groupJid);
      const sentAt = String(row.sent_at || '');
      const dk = dayKey(sentAt);
      if (!dk) continue;
      const status = String(row.status || '').toLowerCase();
      const err = String(row.error || '');
      const is24h = sentAt >= tg24hFromIso;

      if (status === 'failed') {
        bag.failuresByDay.set(dk, (bag.failuresByDay.get(dk) || 0) + 1);
        if (is24h) {
          bag.failed24h += 1;
          for (const reason of TG_EJECT_REASONS) {
            if (err.includes(reason)) bag.reasons24h[reason] += 1;
          }
        }
      } else if (status === 'sent') {
        bag.sentByDay.set(dk, (bag.sentByDay.get(dk) || 0) + 1);
        if (is24h) bag.sent24h += 1;
      }
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (const [groupJid, bag] of perGroup.entries()) {
      let streakDays = 0;
      for (let i = 0; i < TG_EJECT_LOOKBACK_DAYS; i += 1) {
        const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().slice(0, 10);
        const failed = Number(bag.failuresByDay.get(key) || 0);
        const sent = Number(bag.sentByDay.get(key) || 0);
        if (failed > 0 && sent === 0) streakDays += 1;
        else break;
      }

      const sentZeroFailedPositive = bag.sent24h === 0 && bag.failed24h > 0;
      const failedTooHigh = bag.failed24h >= TG_EJECT_FAILED_24H_THRESHOLD;
      const streakTooLong = streakDays >= TG_EJECT_STREAK_DAYS_THRESHOLD;
      const candidate = sentZeroFailedPositive && (failedTooHigh || streakTooLong);
      if (!candidate) continue;

      dailyEjectCandidates.push({
        groupJid,
        failed24h: bag.failed24h,
        sent24h: bag.sent24h,
        sentZeroFailedPositive,
        streakDays,
        reasons24h: bag.reasons24h,
        candidateAction:
          streakDays >= TG_EJECT_STREAK_DAYS_THRESHOLD
            ? 'quarantine_or_manual_review'
            : 'manual_review',
      });
    }

    dailyEjectCandidates.sort((a, b) => {
      if (b.streakDays !== a.streakDays) return b.streakDays - a.streakDays;
      return b.failed24h - a.failed24h;
    });
  }

  const topEject = dailyEjectCandidates.slice(0, TG_EJECT_TOP_LIMIT);
  const topReasonsAgg = Object.fromEntries(TG_EJECT_REASONS.map((r) => [r, 0]));
  for (const item of topEject) {
    for (const reason of TG_EJECT_REASONS) {
      topReasonsAgg[reason] += Number(item.reasons24h?.[reason] || 0);
    }
  }

  const morningSummaryLines = [
    `Campaign invariant check: ${violations.length ? 'VIOLATIONS' : 'OK'}`,
    `Warnings: ${warnings.length}, Violations: ${violations.length}`,
    `WA exhausted 1h: ${exhausted1h}`,
    `TG peer errors 1h: ${tgPeerErrors1h} (rate ${(tgPeerErrorRate1h * 100).toFixed(1)}%)`,
    `TG eject candidates (top ${TG_EJECT_TOP_LIMIT}): ${topEject.length}`,
    `Reasons in candidates (24h): CHANNEL_INVALID=${topReasonsAgg.CHANNEL_INVALID}, CHAT_WRITE_FORBIDDEN=${topReasonsAgg.CHAT_WRITE_FORBIDDEN}, USER_BANNED_IN_CHANNEL=${topReasonsAgg.USER_BANNED_IN_CHANNEL}, CHANNEL_PRIVATE=${topReasonsAgg.CHANNEL_PRIVATE}`,
  ];
  if (topEject.length) {
    const top3 = topEject.slice(0, 3).map((x) => `${x.groupJid} [failed24h=${x.failed24h}, streak=${x.streakDays}d]`);
    morningSummaryLines.push(`Top candidates: ${top3.join('; ')}`);
  }

  const report = {
    ok: violations.length === 0,
    checkedAt: new Date().toISOString(),
    thresholds: {
      duePending: DUE_PENDING_THRESHOLD,
      waExhausted1h: EXHAUSTED_1H_THRESHOLD,
      tgPeerErrors1h: TG_PEER_ERRORS_1H_THRESHOLD,
    },
    summary: {
      waExhausted1h: exhausted1h,
      tgPeerErrors1h,
      tgPeerErrorRate1h,
      dailyEjectCandidatesCount: dailyEjectCandidates.length,
      dailyEjectCandidatesTopCount: topEject.length,
    },
    thresholdsEject: {
      lookbackDays: TG_EJECT_LOOKBACK_DAYS,
      failed24h: TG_EJECT_FAILED_24H_THRESHOLD,
      streakDays: TG_EJECT_STREAK_DAYS_THRESHOLD,
      topLimit: TG_EJECT_TOP_LIMIT,
    },
    daily_eject_candidates: topEject,
    morningSummary: morningSummaryLines.join('\n'),
    warnings,
    violations,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(violations.length ? 2 : 0);
}

run().catch((e) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        fatal: String(e?.message || e),
      },
      null,
      2,
    ),
  );
  process.exit(3);
});

