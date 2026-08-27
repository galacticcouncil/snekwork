# Snekwork

Snekwork is a lightweight ClickHouse-backed block explorer for Basilisk. It combines a block-level USD price indexer, a raw on-chain data lake, an API, and the explorer UI. See [REMOVED.md](REMOVED.md) for what this fork deliberately does not do.

## Product surfaces

- **Explorer:** blocks, extrinsics, events, assets, holders, accounts, identities, tags, proxies, multisigs, and portfolio history.
- **Activity:** transfers, swaps, cross-chain activity, liquidity, and governance votes.
- **Charts:** block-level USD prices and OHLCV candles, rendered on the explorer's own asset pages.
- **API:** Fastify endpoints for explorer data, prices, and indexer status.

## Quick start

The containerized stack requires Docker with Compose. Local development additionally requires Node.js 22+.

```bash
git clone https://github.com/galacticcouncil/snekwork.git
cd snekwork
docker compose up --build -d
```

Local services:

| Service | URL | Purpose |
| --- | --- | --- |
| Explorer | <http://localhost:5174> | Live chain explorer |
| API | <http://localhost:3000> | Explorer and price API |
| ClickHouse HTTP | <http://localhost:18123> | Local database endpoint |

The live pipelines start immediately. Historical ingestion continues in the background, so a fresh installation fills older explorer and price history over time.

Useful status commands:

```bash
docker compose ps
docker logs -f snekwork-ingestion-supervisor
docker exec -it snekwork-clickhouse clickhouse-client \
  --database=price_data --password "${CLICKHOUSE_PASSWORD:-dev}"
```

## Architecture

```text
Basilisk RPC
     │
     ├─ raw-live + supervised backfill ── raw chain and derived tables
     └─ live + historical price indexers ─ prices and OHLCV
                                        │
                                    ClickHouse
                                        │
                                 Fastify API (:3000)
                                        │
                                   Explorer UI (:5174)
```

- `src/` contains the price and raw-data indexers, ingestion utilities, and maintenance scripts.
- `clickhouse/schema/` is the single declarative schema (tables + materialized views), applied once to an empty database by the `schema-bootstrap` service — see [Database model](#database-model). There are no migrations.
- `api/` serves indexed data through cached read models; Compose snapshot services refresh bounded current-state datasets.
- `explorer-ui/` is the block explorer.
- `ops/` contains the ingestion supervisor image.

Historical raw ranges are finalized only after block counts and parent links validate. The supervisor promotes completed raw ranges into the price index and maintains the live pipelines. Writes and checkpoints are designed for replay and crash recovery.

## Configuration

Docker Compose provides working defaults. Override them in an untracked `.env` file when needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | `https://rpc.basilisk.cloud` | Price indexer RPC |
| `RAW_LIVE_RPC_URL` | `https://rpc.basilisk.cloud` | Live raw-indexer RPC |
| `RAW_RPC_URL` | `https://rpc.basilisk.cloud` | Historical raw-worker RPC |
| `IDENTITY_RPC_URL` | `https://rpc.basilisk.cloud` | Identity snapshot RPC |
| `SUBSQUARE_BASE_URL` | `https://basilisk.subsquare.io` | Source of referendum titles |
| `CLICKHOUSE_HOST` | `http://localhost:18123` outside Compose | ClickHouse HTTP endpoint |
| `CLICKHOUSE_PASSWORD` | empty outside Compose; `dev` in Compose | ClickHouse password |
| `CLICKHOUSE_VOLUME_NAME` | see `docker-compose.yml` | Docker volume containing ClickHouse data |
| `RAW_WORKERS` | `6` | Concurrent raw historical workers |
| `RANGE_SIZE` | `1000` | Blocks per raw historical range |
| `MAIN_WORKERS` | `3` | Concurrent historical price workers |
| `MAIN_MAX_RANGES` | `3` | Raw ranges consumed per price batch |

Every RPC endpoint must serve Basilisk. Both indexers read `state_getRuntimeVersion`
at startup and abort unless `specName` is `basilisk`, because the generated codecs in
`src/types` would otherwise decode another chain into plausible-looking wrong rows.

Ingestion is RPC-only and permanently so: SQD publishes no Basilisk archive, so there
is no gateway URL or API key.

See [`docker-compose.yml`](docker-compose.yml) for service-specific tuning variables. Keep credentials in `.env`, never in tracked files.

### Host-specific Compose overrides

For changes that are not simple environment values—such as ports, networks,
volumes, commands, or build settings—create a gitignored
`docker-compose.override.yml` beside `docker-compose.yml`. Docker Compose loads
and merges it automatically:

```yaml
services:
  clickhouse:
    ports: !override
      - "127.0.0.1:28123:8123"

  ingestion-supervisor:
    environment:
      RAW_WORKERS: ${RAW_WORKERS:-2}
```

Compose normally appends list values such as `ports`; `!override` replaces the
tracked list instead. Inspect the fully merged configuration before starting it:

```bash
docker compose config
docker compose up --build -d
```

The ingestion supervisor starts historical `indexer` and `raw-indexer` workers
through Compose from inside its container. If the override changes either worker
service, mount the file into the supervisor so those dynamically created workers
inherit it:

```yaml
services:
  ingestion-supervisor:
    volumes:
      - ./docker-compose.override.yml:/etc/snekwork/docker-compose.override.yml:ro
```

Keep credentials in `.env`; do not put them in the override file.

## Querying prices

The query views support point-in-time prices, continuous block ranges, timestamp lookup, and OHLCV at 5-minute, 15-minute, 30-minute, 1-hour, 4-hour, 1-day, 1-week, and 1-month intervals.

```sql
SELECT *
FROM price_data.price_at_block(asset_id=5, block_height=7000000);

SELECT *
FROM price_data.ohlc_1h_query(
  asset_id=5,
  start_time='2026-01-01 00:00:00',
  end_time='2026-01-31 23:59:59'
);
```

See the [ClickHouse query guide](clickhouse/docs/QUERY_GUIDE.md) for the complete SQL reference.

## Development

Install each workspace, then run the repository-wide checks:

```bash
npm ci
npm --prefix api ci
npm --prefix explorer-ui ci
npm run check:all
```

Browser tests are separate because they require the relevant services:

```bash
npm --prefix explorer-ui run test:e2e
```

Common indexer commands:

```bash
npm start -- --help
npm run start:raw -- --help
npm run detect-gaps
npm run snapshot:balances -- --dry-run
```

### Runtime types

`src/types/` is generated from Basilisk runtime metadata by
[`typegen.json`](typegen.json), which reads a spec-version index that is not tracked
(it is ~19 MB). Regenerate both after a runtime upgrade introduces a shape this
indexer decodes:

```bash
npx squid-substrate-metadata-explorer --rpc wss://rpc.basilisk.cloud --out typegen/basiliskVersions.jsonl
npm run typegen
```

Both inputs are build artifacts and untracked. The type bundle comes from
[`src/basiliskTypesBundle.ts`](src/basiliskTypesBundle.ts) — the bundle shipped by
`@subsquid/substrate-runtime` plus the orml-tokens alias it is missing — and supplies
the definitions the pre-V14 metadata of specs 16 and 19 (blocks 1–395,663) cannot
describe on its own. The same module is what the processors pass to
`.setTypesBundle()`, so generation and ingestion cannot drift apart.

Generated version modules are named for the Basilisk spec version that introduced the
shape (`v16`, `v25`, … `v128`), and the decode call sites select among them with the
metadata-driven `.is(block)` probes rather than block-height comparisons. The era
boundaries those probes correspond to are named in
[`src/chainEras.ts`](src/chainEras.ts), for logging and comments only — never for
branching.

`npm run typegen` also re-applies the one local edit to the generated
`src/types/support.ts` (`src/scripts/patch-typegen-support.ts`), so regeneration
cannot silently drop it. Everything under `src/types/` is otherwise generated: edit
`typegen.json` and regenerate rather than editing it by hand.

## Database model

The blockchain is the source of truth; every table is a reproducible projection of
it, so the database is disposable and rebuildable — **there are no migrations**.

- **Schema is declarative.** `clickhouse/schema/*.sql` defines every table and
  materialized view (MV). The `schema-bootstrap` service applies it — in numeric
  order, idempotently (`CREATE ... IF NOT EXISTS`) — to an empty database **before**
  ingestion starts. Because the MVs exist first, every MV-backed read model populates
  itself as raw data is indexed, in any order, with **no backfill**.
- **Derived data comes from three places.** Most read models are MVs (automatic). The
  few an MV cannot express — per-trade netting (`account_trade_volume`) and the stateful
  LP-history reconstructions — are recomputed continuously and idempotently by the
  `derivations` service. A small set of current-state snapshots (account-directory
  values) are refreshed on API timers.
- **To change a model, edit the declaration and rebuild the projection** — drop the
  table/MV and let it refill from raw, or reset the derived layer and let it rebuild.
  Never write an in-place migration; there is no version ledger.

Fresh-install order (enforced by Compose `depends_on`):
`schema-bootstrap` → ingestion (raw) → `derivations` → `api`. Applying the schema to a
non-empty database is a safe no-op, so redeploying never risks existing data.

## Operational safety

- Keep ClickHouse data and checkpoints together; do not wipe tables to resolve an ingestion problem.
- Let `ingestion-supervisor` own its dynamically created historical workers. Do not manually start or stop those containers.
- Use bounded, explicit block ranges and distinct pipeline IDs for manual backfills.
- Change a model by editing `clickhouse/schema/` and rebuilding that projection from raw; never patch derived data in place, and never wipe raw to fix a derived model.
- Back up the ClickHouse volume before production schema or checkpoint maintenance.

## License

ISC
