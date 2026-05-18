# Scaling Architecture

## Runtime roles

Backend now supports runtime capabilities through `APP_RUNTIME_ROLE`:

- `api`
- `worker`
- `scheduler`
- comma-separated combinations, for example `api,worker`
- `all` keeps the legacy monolithic behavior

Role behavior:

- `api`
  - starts the Nest HTTP server
  - serves frontend-facing REST endpoints
  - does not start BullMQ send workers
  - does not start the repeat watcher
- `worker`
  - starts Nest as a background application context
  - runs BullMQ send workers only
  - no HTTP listener
- `scheduler`
  - starts Nest as a background application context
  - runs campaign repeat / healing / scheduled TG sync loop
  - no HTTP listener

## Why this matters

The previous production layout packed these concerns into one process:

- HTTP API
- campaign scheduler
- BullMQ send workers
- WA/TG session runtime

That made scaling non-linear: adding more CPU/RAM still forced all subsystems to compete inside a single Node process.

The new split allows:

- independent CPU/RAM limits for API, worker and scheduler
- safe horizontal growth of sender workers
- keeping daily autonomous repeat scheduling isolated from request traffic

## Scheduler safety

`CampaignRepeatService` now uses a Redis leader lease:

- key: `runtime:scheduler:campaign-repeat` by default
- only the current lease owner executes repeat ticks
- accidental multiple scheduler replicas will not start duplicate repeat waves

Relevant env vars:

- `CAMPAIGN_REPEAT_LEADER_KEY`
- `CAMPAIGN_REPEAT_LEADER_TTL_MS`

## Recommended production shape

For a serious multi-user load target, use at minimum:

- `backend` as API
- `backend_worker` as sender runtime
- `backend_scheduler` as autonomous repeat/sync runtime
- `redis`
- `frontend`
- `nginx`

Further scale path:

1. Increase `CAMPAIGN_SEND_SHARD_COUNT`
2. Add more dedicated worker capacity
3. Keep scheduler singleton via Redis leader lease
4. Scale messenger-owner capacity with more worker/session runtime

## Daily autonomous campaigns

Daily repeat campaigns continue to rely on existing `campaigns.repeat_*` fields, but now the repeat engine is intended to live in the `scheduler` role instead of the public API role. This keeps repeat execution autonomous even when API traffic spikes.

## Messenger session ownership

WA and TG sessions now use Redis-backed per-account leases and shared runtime state:

- lease keys:
  - `runtime:session-lease:wa:{userId}`
  - `runtime:session-lease:tg:{userId}`
- shared state keys:
  - `runtime:session-state:wa:{userId}`
  - `runtime:session-state:tg:{userId}`

What this changes:

- send/sync/auth flows acquire the lease before opening or reusing a live messenger client
- `status` endpoints read shared state instead of silently auto-connecting and stealing the session
- read-only TG endpoints no longer auto-connect from a saved session
- idle owners release the session automatically after a configurable timeout

Relevant env vars:

- `WA_SESSION_LEASE_TTL_MS`
- `WA_SESSION_LEASE_RENEW_MS`
- `WA_SESSION_IDLE_RELEASE_MS`
- `TG_SESSION_LEASE_TTL_MS`
- `TG_SESSION_LEASE_RENEW_MS`
- `TG_SESSION_IDLE_RELEASE_MS`
- `TG_AUTH_PENDING_IDLE_RELEASE_MS`

This is the minimum ownership layer needed before adding more worker replicas. Without it, multiple API/worker/scheduler processes would race for the same auth keys and break reliability under load.

## Recommended first production tuning

For the current VPS tier, start with:

- `CAMPAIGN_SEND_SHARD_COUNT=20`
- `WA_SESSION_LEASE_TTL_MS=45000`
- `WA_SESSION_LEASE_RENEW_MS=15000`
- `WA_SESSION_IDLE_RELEASE_MS=300000`
- `TG_SESSION_LEASE_TTL_MS=45000`
- `TG_SESSION_LEASE_RENEW_MS=15000`
- `TG_SESSION_IDLE_RELEASE_MS=300000`
- `TG_AUTH_PENDING_IDLE_RELEASE_MS=900000`

Then scale in this order:

1. Increase worker CPU/RAM
2. Add more worker replicas or more worker capacity
3. Increase `CAMPAIGN_SEND_SHARD_COUNT`
4. Re-run load tests before changing lease timings

## Worker shard overlays

Production has ready Docker Compose overlays for larger sender capacity:

- `docker-compose.workers-256.yml`: 4 workers, 64 shards each
- `docker-compose.workers-512.yml`: 4 workers, 128 shards each
- `docker-compose.workers-1024.yml`: 8 workers, 128 shards each

Use them together with the base release compose file:

```bash
docker compose \
  -f docker-compose.release.yml \
  -f docker-compose.workers-512.yml \
  up -d --no-deps --force-recreate backend backend_worker backend_worker_2 backend_worker_3 backend_worker_4 backend_scheduler
```

For `1024`, use `docker-compose.workers-1024.yml` and include `backend_worker_5` ... `backend_worker_8` in the recreate command.

The worker process has a safety guard: if `CAMPAIGN_SEND_SHARD_COUNT` is above `CAMPAIGN_SEND_WORKER_MAX_UNPARTITIONED_SHARDS` (default `64`) and no `CAMPAIGN_SEND_WORKER_SHARD_START/END` range is configured, the worker refuses to start. This prevents an accidental single-container rollout with hundreds of BullMQ listeners.

Emergency override:

```env
CAMPAIGN_SEND_WORKER_ALLOW_UNPARTITIONED_LARGE_SHARDS=true
```

Use that only for a deliberate temporary rollout. Normal scaling should use explicit shard ranges.

## Capacity targets

- Small / current VPS: `CAMPAIGN_SEND_SHARD_COUNT=20`, one `backend_worker`.
- 100-300 active senders: `docker-compose.workers-256.yml`, then increase CPU/RAM if queues grow.
- 300-600 active senders: `docker-compose.workers-512.yml`.
- 600-1000 active senders: `docker-compose.workers-1024.yml`, enough CPU/RAM, Redis headroom, and close monitoring of messenger limits.

Scaling above this still should not require code changes, but it may require splitting workers onto separate hosts and pointing them to the same Redis/Supabase environment.
