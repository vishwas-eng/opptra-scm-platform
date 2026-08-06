# Running cost

The workload is I/O-bound HTTP orchestration with a handful of concurrent users and a
few scheduled sweeps. It is not CPU-hungry, has no GPU, and, since the whitelist
removed the CAPTCHA problem, runs no headless browser. Almost all of the bill is the
VM sitting idle waiting for work, so that is where the savings are.

## Where the money goes (asia-south1, Mumbai)

| Item | Current | ~₹/month | Notes |
|---|---|---|---|
| VM `e2-medium` (2 vCPU, 4 GB) | on-demand, 24×7 | ~2,450 | The dominant cost |
| Boot disk 50 GB pd-balanced | | ~500 | Provisioned, not used |
| Static external IP | in use | ~250 | Non-negotiable, it is what UC whitelists |
| Egress | small | ~50 | JSON and a few PDFs |
| **Total** | | **~3,250** | ≈ $39 |

## The four changes worth making

### 1. Commit to the VM you keep, 1-year CUD (biggest single win)
A committed-use discount on the running VM is a ~37% cut for a 1-year commit, ~55% for
3 years, with **no technical change and no downtime**. If the platform is staying
(it is, nine automations depend on it), this is free money.

> `~2,450 → ~1,550/mo` (1yr) · `→ ~1,100/mo` (3yr)

### 2. Shrink the boot disk 50 GB → 20 GB
Nothing on the box needs 50 GB. Postgres holds runs and audit rows (kilobytes per run),
Redis is capped at 256 MB, and artifacts are streamed rather than kept. Check before
resizing, `df -h` and `docker system df`, and note a GCP boot disk can grow but
**never shrink**, so this is a decision to take at rebuild time, not in place.

> `~500 → ~200/mo`

### 3. Reconsider e2-medium → e2-small (2 GB), measure first
The plan already flagged 2 GB as "possible but tight during report sweeps". With
Postgres + Redis + api + worker + Caddy on one box, 2 GB is genuinely tight and the
failure mode is the OOM killer taking down Postgres mid-run. **Do not do this blind.**
Watch peak RSS across a full reports-digest sweep first; if peak stays under ~1.4 GB
there is room, otherwise stay on e2-medium and take the CUD instead.

> `~2,450 → ~1,200/mo` if it fits, but correctness first

### 4. Stop paying for staging around the clock
If a second environment exists, it does not need to be up at night. A start/stop
schedule on a non-production VM removes roughly two-thirds of its cost, and nothing in
the platform requires staging to be reachable when nobody is testing.

```bash
gcloud compute resource-policies create instance-schedule opptra-stg-hours \
  --region asia-south1 --vm-start-schedule '0 9 * * 1-5' \
  --vm-stop-schedule '0 21 * * 1-5' --timezone Asia/Kolkata
```

## What NOT to cut

- **The static IP.** It is what Unicommerce whitelists. Releasing it to save ₹250
  breaks every integration and getting a new one re-whitelisted costs days.
- **Postgres.** Moving to a managed instance (Cloud SQL) *raises* the bill several-fold
  for a database this small. Keep it in the compose stack and take nightly `pg_dump`s.
- **Redis persistence.** `appendonly yes` with `noeviction` is deliberate: BullMQ jobs
  are work that must survive a restart. Turning eviction on to save memory would
  silently drop queued automations.
- **The worker's concurrency of 1.** It is a correctness guarantee (facility-scoped
  session state), not a performance setting. Scaling it does not save money and would
  corrupt runs.

## Guardrails worth setting once

1. **Billing budget + alert** at ₹4,000/month, catches a runaway before the invoice.
   Billing → Budgets & alerts, scoped to this project.
2. **Delete unattached disks and old snapshots.** These accumulate silently after
   rebuilds and nobody notices a stopped resource still billing.
3. **Keep the daily request budgets** in PortalGuard (`dailyBudget`, default 5,000 per
   portal). They exist to protect the seller accounts, but they also cap the egress and
   compute a runaway loop could burn overnight.
4. **Log retention.** Pino writes to the container; `docker compose logs` grows without
   bound. Set `max-size`/`max-file` on the logging driver so disk usage is flat rather
   than a slow leak toward a full disk at 3 a.m.

## Realistic target

Taking the CUD, the smaller disk and log rotation, the three that carry no risk, lands at roughly **₹1,800–2,000/month (~$22)**, a ~40% reduction, with no change to how
the platform behaves. The e2-small move could take it to ~₹1,500 but only if the
measurements support it.
