# Removed from neckwork

Snekwork is a lightweight Basilisk fork of [hydration-neckwork](https://github.com/1xGiraffe/hydration-neckwork).
Everything listed here was **deleted outright** — no feature flags, no dead branches, no legacy fallbacks.
This file is the single reference for what snekwork deliberately does not do, and why.

Two kinds of removals:

- **Chain-absent** — the Basilisk runtime has no such pallet/precompile, so the feature cannot exist
  (no EVM, no Omnipool, no Stableswap, no DCA, no OTC, no Staking pallet, no Referrals, no HOLLAR/HSM,
  no money market).
- **Product-cut** — technically possible on Basilisk but cut to keep snekwork lightweight
  (login/users, notifications, user tags, public API, Preis, mempool indexing, Ocelloids enrichment,
  multi-chain identity lookup).

## Product surfaces

| Removed | Kind | Notes |
| --- | --- | --- |
| Preis (price-chart app) | product-cut | `preis-ui/` workspace, `/candles`, `/candles/volume-details`, `/market-stats` API routes, `marketStatsService`, `ohlcvService`. The `ohlc_*` ClickHouse tables stay — the explorer's own asset charts read them via `explorerService`. |
| Public API | product-cut | `api/src/public/**` (37 endpoints incl. CoinGecko/DefiLlama/DexScreener facades), `api-public` + `api-public-nginx` services, `public-nginx/`, `clickhouse/schema/006_public.sql`, `pool_swap_hourly` derivation. |
| Login / user accounts | product-cut | Wallet-signature auth, sessions, profiles, avatars, user lists/tags, invites, subscriptions, device-link/QR handoff, `user-backup` service, `clickhouse/schema/004_user.sql`, ViewerFold overlays. System/structural tags stay. |
| Notifications | product-cut | `api/src/notifications/**`, notification routes, web-push/Telegram channels, alert rules, inbox, UI bell/dialogs. |
| Mempool indexing | product-cut | `pendingHeadService`, `pendingActivity`, projected/includability UI threading. |
| Ocelloids XCM enrichment | product-cut | `xcmJourneyService`, cross-chain origin/destination resolution, per-journey external links. Local-hop XCM rendering stays. |
| Multi-chain identity lookup | product-cut | People-chain identity sources. Basilisk's own on-chain Identity pallet is the sole source. |
| EVM (everything) | chain-absent | `/contracts` feature, contract verification (Sourcify/verifier services), EVM wallet plumbing (EIP-6963, personal_sign, permits), `EVM.Log` ABI decoding, H160 aliasing, ERC-20/aToken registry, `evm-tx` receipts, `smart-contract-verifier` + `contract-backup` services, `clickhouse/schema/005_contracts.sql`. |
| Money market | chain-absent | Aave V3 indexing/snapshots, health factors, DefiSim, MM dashboards/positions, `mm-snapshot`/`mm-supplemental-snapshot`/`atoken-anchor` services, `clickhouse/schema/007_money_market_history.sql`. |
| /HDX dashboard | chain-absent | HDX supply/locks/flows/unlocks (`hdxService`, `Hdx.tsx`, `HdxCharts`). |
| /HOLLAR dashboard | chain-absent | HOLLAR peg/HSM/liquidity (`hollarService`, `Hollar.tsx`). |
| /Omnipool | chain-absent | Omnipool page, pricing (`price/omnipool.ts`), state readers, snapshots, LP reconstructions (`omnipool_position_owner_intervals`), pallet-account derivation. |
| Stableswap | chain-absent | Pricing (`price/stableswap.ts`), NAV/LP aliases, pool pages variants, `@galacticcouncil/math-stableswap` dependency. |
| /revenue | chain-absent | Revenue dashboards, flows, breakdowns (`revenueService`, `revenueStreams`, `clickhouse/schema/008_revenue.sql`, UI Revenue/RevenueFlow). |
| /security dashboards | chain-absent | Circuit breakers, Wormhole monitoring (`securityService`, `wormholeNtt*`), deposit lockdowns, MM solvency — all seven sections are Hydration-protocol-specific. |
| DCA | chain-absent | Schedule/execution pages, activity slugs, locks, `dcaSchedules`. |
| OTC | chain-absent | Order pages, place/pull/fill activity slugs. |
| Staking | chain-absent | Staking activity, lock reasons, GIGAHDX. |
| Referrals | chain-absent | Referral activity and rewards slugs. |
| Exchange-pallet trades | verified-dead | Basilisk's genesis-era intention-matching AMM (specs 16–76) emitted **zero events over its entire life** (verified by a complete genesis→2.14M block sweep). Its events are decoded in the swap catalogue for correctness but deliberately not admitted to the activity views: the AMM marker double-counts the XYK leg beside it, and direct-trade events carry no asset ids. |
| Snakewatch icon easter eggs | product-cut | The remote degen-emoji list and custom icon overrides were keyed to Hydration accounts; account emojis use the built-in deterministic fallback. |

## Replaced (not removed)

| Was | Is |
| --- | --- |
| USD pricing via stablecoin basket → LRNA → Omnipool → pool-graph BFS | KSM/USD reference persisted in ClickHouse (`ksm_usd_reference`: CoinGecko for the rolling year + live head; Binance daily klines for history beyond CoinGecko's 365-day free-tier limit) × the BSX/KSM XYK pool ratio. Priced assets are whitelisted to exactly BSX (0) and KSM (1); every other asset is deliberately unpriced. The BSX/USDT pool is not a pricing input. |
| SQD gateway + RPC ingestion | RPC-only ingestion (no SQD dataset exists for Basilisk); chain-identity guard aborts on a non-`basilisk` RPC. |
| Hydration SQD typegen (`v2.archive.subsquid.io/metadata/hydradx`) | Metadata-explorer over the Basilisk RPC (35 specs, 16→134), with the built-in `basilisk` old-types bundle plus the orml `AccountData` alias it lacks for the V13 era (blocks 1–395,663). |
| Hydration SS58 (63) / Polkadot SS58 (0) display | Basilisk SS58 (prefix 10041, canonical) + Kusama SS58 (prefix 2, secondary). |
| Polkadot-relay XCM counterparty table | Kusama-relay table (Asset Hub, Karura, Bifrost, Moonriver, …). |
| `hydration.subsquare.io` referendum titles | `basilisk.subsquare.io`. |
| Hydration OpenGov tracks | Basilisk's 8 tracks (root … tipper). |
| Hydration default-tag address book | Minimal Basilisk seed (treasury et al.) + auto-generated structural tags (XYK pool accounts, LM pots). |
