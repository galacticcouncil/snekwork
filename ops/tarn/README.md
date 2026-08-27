# Deployment: tarn

The production deployment of snekwork, on `tarn.hydration.cloud`
(162.55.31.232, Xeon Gold 5412U 24c/48t, 251 GB RAM, Debian 13).

Live at **<https://snekwork.tarn.hydration.cloud>** — the SPA and its API
(`/api/*`) share that one origin, exactly as they do in local Compose.

## Shape of the deployment

The application runs as a **plain Compose project**, not a Swarm stack, even
though tarn is a Swarm node. `ingestion-supervisor` creates its historical
workers with `docker compose run` over the host docker socket, which Swarm has
no equivalent for, and the stack also relies on `profiles:`, `container_name:`
and `depends_on: {condition: service_completed_successfully}`. Compose
containers coexist with tarn's Swarm services without interfering.

Only the **public front door** is a Swarm stack ([`stack.yml`](stack.yml)),
because that is the one thing Compose cannot provide here — see
[Why the shim exists](#why-the-shim-exists).

```
/srv/snekwork                     git clone, this repo
/srv/snekwork/.env                credentials + RPC targets (mode 600, untracked)
/srv/snekwork/docker-compose.override.yml
                                  host override (untracked; reference copy:
                                  compose.override.example.yml)
/srv/snekwork-data/clickhouse     ClickHouse data — a bind on /, NOT a volume
```

| Port | Bind | Service |
| --- | --- | --- |
| 3000 | `127.0.0.1` | API |
| 5174 | `127.0.0.1` | Explorer UI |
| 18123 / 19000 | `127.0.0.1` | ClickHouse HTTP / native |

Nothing is published on a public interface. The only route in is traefik →
`snekwork_web` → the `explorer-ui` container.

## ClickHouse data must not be a named volume here

Docker's `data-root` on tarn is `/mnt/disk3/docker`, and **disk3 sits at ~93 %**
with prior ENOSPC history. An ENOSPC there does not just break snekwork — it
breaks *every* container on the box, including the Hydration collator and the
Polkadot archive node. So `clickhouse_data` is replaced with a bind mount on
`/` (~525 GB free) in the host override:

```yaml
services:
  clickhouse:
    volumes: !override
      - /srv/snekwork-data/clickhouse:/var/lib/clickhouse
```

`!override` is load-bearing: Compose **appends** list values by default, so a
plain `volumes:` entry would add a second mount rather than replace the first,
and ClickHouse would still be writing to the named volume on disk3.

The same override bind-mounts itself into `ingestion-supervisor` at
`/etc/snekwork/docker-compose.override.yml`. Without that, the workers the
supervisor creates are started from the compose file baked into its own image
and would not inherit any of the host settings — including the data bind.

Any future Compose workload on tarn with real data growth must do the same.

## Why the shim exists

`traefik_proxy` on tarn runs with `--providers.docker.swarmMode=true`. In that
mode the docker provider enumerates **Swarm services only** and never inspects
standalone containers, so labels on the `explorer-ui` Compose container are
dead weight — it can never be discovered.

The bridge is one tiny nginx Swarm service, `snekwork_web`:

```
internet ──▶ traefik (Host: snekwork.tarn.hydration.cloud, ACME TLS)
          ──▶ snekwork_web        swarm service, discoverable, nginx.conf
          ──▶ snekwork-explorer-ui  compose container, over the `gateway` overlay
          ──▶ snekwork-api          over the compose network
```

Both ends meet on tarn's **attachable** `gateway` overlay: the Compose
`explorer-ui` container joins it alongside the project network, and the shim
resolves it by container name through docker's embedded DNS. The shim proxies
and nothing else — no caching (the UI container already micro-caches `/api`),
no buffering (`/api/explorer/live` is a long-lived SSE stream), HTTP/1.1
upstream (below that the UI's gzip does not engage).

## Deploy / redeploy

Application:

```bash
cd /srv/snekwork
git pull
docker compose --profile worker build
docker compose up -d --no-deps <changed services>   # not clickhouse, not the supervisor's workers
```

Front door (only when the route or nginx.conf changes):

```bash
# configs are immutable in swarm — bump the version to change nginx.conf
docker config create snekwork_web_nginx_v1 ops/tarn/nginx.conf
docker stack deploy -c ops/tarn/stack.yml snekwork
```

Or via the `swarmpit-tarn` MCP (`create_config` / `create_stack`), which is the
preferred path for Swarm work on this host. **Do not** manage the application
itself through Swarmpit — it is not a Swarm stack.

## Bring-up

1. `docker compose up -d clickhouse schema-bootstrap api derivations explorer-ui`
2. **KSM/USD reference — required, one time.** Until it runs, every USD value
   is `null` by design and the stack looks broken while being perfectly healthy:
   ```bash
   docker compose run --rm --no-deps indexer src/scripts/backfill-ksm-reference.ts
   ```
3. `docker compose up -d raw-live ingestion-supervisor identity-snapshot \
      balance-snapshot referendum-proposals referendum-titles`

## Operating notes

- **RPC.** There is no Basilisk node in the fleet, so `RAW_RPC_URL` and friends
  currently point at public `rpc.basilisk.cloud` with deliberately conservative
  limits (`RAW_WORKERS=2`, `MAIN_WORKERS=2`, `RAW_RPC_RATE_LIMIT=25`,
  `MAIN_RATE_LIMIT=20`). The genesis backfill walks ~16.8M blocks *with state
  reads*. Repoint `.env` at a dedicated archive node when one exists — the
  supervisor reads the URL per worker, so no restart of completed ranges.
- **Disk.** `RAW_SNAPSHOT_EVERY_N_BLOCKS=1` writes one `raw_block_snapshots`
  row per block; upstream that table is the largest in the database and ~36 % of
  all growth. Measure during backfill rather than trusting an estimate. `N` is
  the one pure-config disk lever, and it must divide the 600-block pool-history
  MV grid (checked at startup).
- The usual safety rules from the root README apply: never wipe tables to fix
  ingestion, never hand-manage supervisor-owned workers, back up
  `/srv/snekwork-data/clickhouse` before schema or checkpoint maintenance.
