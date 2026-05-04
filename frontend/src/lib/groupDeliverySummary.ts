export type GroupDeliverySummary = {
  templatesIncluded?: number
  sent: number
  failed: number
  total: number
  successRate: number
  lastSentAt: string | null
  lastFailedAt: string | null
  topReasons: Array<{ reason: string; count: number }>
}

type Channel = 'wa' | 'tg'
export type GroupDeliverySummaryMeta = {
  cacheHit: boolean
  fetchedAtMs: number
}

const CACHE_TTL_MS = 45_000
const cache = new Map<string, { expiresAt: number; summaries: Record<string, GroupDeliverySummary> }>()

function hashIds(ids: string[]): string {
  let h = 5381
  for (const id of ids) {
    for (let i = 0; i < id.length; i += 1) {
      h = ((h << 5) + h) ^ id.charCodeAt(i)
    }
  }
  return Math.abs(h >>> 0).toString(16)
}

export async function fetchGroupDeliverySummary(params: {
  backendUrl: string
  token: string
  channel: Channel
  groupJids: string[]
  lookbackDays?: number
  includeTemplatesIncluded?: boolean
  bypassCache?: boolean
  signal?: AbortSignal
}): Promise<{ summaries: Record<string, GroupDeliverySummary>; meta: GroupDeliverySummaryMeta }> {
  const uniq = Array.from(
    new Set(params.groupJids.map((x) => String(x || '').trim()).filter(Boolean)),
  ).slice(0, 2000)
  if (!uniq.length) {
    return {
      summaries: {},
      meta: { cacheHit: false, fetchedAtMs: Date.now() },
    }
  }
  const sorted = [...uniq].sort()
  const lookbackDays = Number.isFinite(Number(params.lookbackDays))
    ? Number(params.lookbackDays)
    : 14
  const includeTemplatesIncluded = params.includeTemplatesIncluded === true
  const key = `${params.channel}:${lookbackDays}:${includeTemplatesIncluded ? 1 : 0}:${sorted.length}:${hashIds(sorted)}`
  const now = Date.now()
  const cached = cache.get(key)
  if (!params.bypassCache && cached && cached.expiresAt > now) {
    return {
      summaries: cached.summaries,
      meta: { cacheHit: true, fetchedAtMs: now },
    }
  }

  const res = await fetch(`${params.backendUrl}/campaigns/group-delivery-summary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.token ? { Authorization: `Bearer ${params.token}` } : {}),
    },
    body: JSON.stringify({
      channel: params.channel,
      groupJids: uniq,
      lookbackDays,
      includeTemplatesIncluded,
    }),
    signal: params.signal,
  })
  const json: any = await res.json().catch(() => null)
  if (!res.ok || !json?.success) {
    return { summaries: {}, meta: { cacheHit: false, fetchedAtMs: now } }
  }
  const summaries = (json.summaries || {}) as Record<string, GroupDeliverySummary>
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, summaries })
  return {
    summaries,
    meta: { cacheHit: false, fetchedAtMs: Date.now() },
  }
}

