# Implementation status

Date: 2026-08-04

## Delivered

### Independent auction engine

- docker-compose.yml starts PostgreSQL 16, RabbitMQ 3.13 management and Redis 7.2 with named volumes, healthchecks and an isolated bridge network.
- prisma/schema.prisma is the source schema and prisma/migrations/20260804184455_initial/migration.sql is the deployable migration.
- PostgreSQL is the financial source of truth. Amounts are BIGINT cents in the database and decimal strings in JSON. Timestamps are UTC.
- Modes and state transitions cover SHOPPING, LIVE and TIMED.
- AuctionExecution, AuctionLotExecution, EffectiveBid, WinnerAward, Settlement, AuctionEventLog, ManagerAction, registrations and reservations are persisted in PostgreSQL.
- BiddingService implements manual TIMED bids, secret proxy ceilings, deterministic FIFO ties, concurrent lot locking, optimistic versions, anti-sniping extensions and idempotent close/settlement.
- BidOrigin records ONLINE, PROXY, FLOOR and PHONE. There is no scoreboard-edit command.
- OutboxEvent and ConsumerInbox provide transactional outbox/inbox. RabbitMQ uses publisher confirms, retry exchange/queues, dead-letter exchange and versioned envelopes.
- Redis is auxiliary only: rate limiting, presence and future fan-out. It is not used for the bid ledger.
- RealtimeGateway issues one-use hashed tickets, sends connected/snapshot/event/replayed, reports resync_required, and supports reconnect by snapshot.
- The worker publishes outbox events, consumes notification events and closes due lots idempotently.

### Existing backend integration

Changed under C:\dev\PrincesaRural\pfrural-backend:

- AuctionEngineClient centralizes internal HTTP contracts, correlation and idempotency headers.
- AuctionEngineIntegrationService maps catalog publication to engine execution/lots without mapping editable Mongo bid scoreboard fields.
- Existing AuctionsAdminController.publish synchronizes after the existing CRUD publication and keeps CRUD availability when the engine is temporarily unavailable.
- AuctionEngineController adds authenticated routes for snapshot, registration, bids, proxy bid, shopping reservation, realtime ticket, manager auction/lot commands, floor/phone bid, current lot and stream.
- AuctionEngineEventsConsumer consumes engine events with Mongo AuctionEngineInbox deduplication, retries and projection-only updates for safe 32-bit legacy read fields. It never treats Mongo as the ledger.
- Versioned bid/lot events carry both the engine UUID and externalLotId, allowing the backend projection to resolve the catalog lot without confusing internal ledger IDs with Mongo IDs.
- .env.example, Prisma client generation and amqplib dependencies were updated.

Main backend routes:

~~~text
GET  /api/auction-engine/auctions/:auctionId/snapshot
POST /api/auction-engine/auctions/:auctionId/registration
GET  /api/auction-engine/auctions/:auctionId/registration
POST /api/auction-engine/auctions/:auctionId/lots/:lotId/bids
PUT  /api/auction-engine/auctions/:auctionId/lots/:lotId/proxy-bid
POST /api/auction-engine/auctions/:auctionId/realtime/tickets
POST /api/auction-engine/manager/auctions/:auctionId/:action
POST /api/auction-engine/manager/auctions/:auctionId/lots/:lotId/:action
PUT  /api/auction-engine/manager/auctions/:auctionId/current-lot
PUT  /api/auction-engine/manager/auctions/:auctionId/stream
POST /api/auction-engine/sandbox/auctions
~~~

### Existing frontend integration

Changed under C:\dev\PrincesaRural\princesaruralfront:

- Added app/api/auction-engine/[...path]/route.ts using the current session/access-token pattern.
- Added hooks/actions/auctionEngineActions.ts and lib/auctions/engine-types.ts for snapshot, registration, bidding, proxy bid, reservation, realtime ticket and manager commands.
- Public auction pages render AuctionRuntimeBoard with authoritative prices, registration, manual bid, proxy ceiling, shopping reservation, WebSocket connection, reconnect and status messaging.
- Backoffice auction detail renders ManagerControlRoom with versioned start/pause/resume/finish and lot open/pause/sell commands.
- Added the WebSocket environment example and preserved existing Next/BFF/session conventions.
- The new controls use native buttons/labels, visible focus indicators, live status messages and disabled pending states.
- Corrected the public command identity contract: catalog/BFF commands use `externalLotId`; the engine UUID is kept for internal snapshots and event correlation. This removes the observed `LOT_NOT_FOUND` caused by sending the wrong identifier.
- Manager actions now disable invalid transitions, refresh the authoritative snapshot after each successful command and send the current optimistic version. Engine transition errors include `from`, `to` and `allowedTransitions`; backend HTTP errors preserve the engine status/code instead of collapsing all 409s into a generic 502.
- Added `EngineCommandFeedback` with Portuguese recovery guidance for `INVALID_AUCTION_TRANSITION`, `INVALID_LOT_TRANSITION`, `LOT_NOT_FOUND`, `VERSION_CONFLICT` and registration errors.
- Added frontend pages `/admin/leiloes/sandbox`, `/admin/leiloes/sandbox/:externalAuctionId` and `/leiloes/teste/:externalAuctionId`. The sandbox creates fresh TIMED executions with open lots and an approved participant, is idempotent through `ManagerAction`, and is disabled when `SANDBOX_ENABLED=false` or `NODE_ENV=production`.
- Backoffice navigation now separates catalog operations from the test environment; public/runtime cards show the catalog lot code, official price, next bid and current operational state.
- Production and sandbox now share `AuctionLiveExperience`: the same live-page composition renders the mock stream, official board and bidding controls. `AuctionRuntimeBoard` consumes WebSocket events and polls the public snapshot every 2.5 seconds, so a temporary ticket/auth failure no longer leaves a static first render or requires a full-page reload.
- Added `MockStreamPlayer` and stream data to the authoritative snapshot. Sandbox executions start with a `mock` stream in `LIVE`; manager control room can set the mock signal to `LIVE` or `ENDED`, and the public page reflects that state.
- Added an in-page activity feed for bid, lot, auction, connection and stream changes, plus live/polling connection metrics and visible press/hover states following the `/better-ui` guidance.

## Decisions and safety boundaries

- Prisma is used for all normal database access. The only raw SQL is the minimal SELECT ... FOR UPDATE inside lot-locking transactions because Prisma does not expose pessimistic locks directly.
- Existing Mongo currentBidCents, nextBidCents, currentBidderName and bidCount remain legacy/read projections only. They are not read by the engine and are not used for concurrency.
- Internal backend-to-engine authentication currently uses a shared development/service token plus actor headers. Production should replace this with managed service credentials or mTLS.
- The catalog integration is idempotent by external auction/lot IDs. Re-running publication updates the same execution instead of creating a second ledger.
- Public snapshot/bid commands require an engine publication. A catalog auction not yet synchronized must be surfaced as unavailable rather than silently falling back to Mongo scoreboard fields.

## Validation commands

Passed:

~~~powershell
# engine
docker compose up -d
$env:DATABASE_URL='postgres://auction_engine:change_this_postgres_password@localhost:5433/auction_engine'
npm install
npm run db:validate
npm run db:migrate
npm run db:seed:demo
npx tsc -p tsconfig.json --noEmit
npm run lint
npm test
$env:RUN_INTEGRATION_TESTS='true'
npm test -- --run src/api/app.integration.spec.ts

# backend
npm install
npm run prisma:generate
npm run build
npx jest --runInBand --forceExit --passWithNoTests
npx eslint src/modules/auctions/engine src/modules/auctions/controller/auctions-admin.controller.ts

# frontend
npm run test:sitemap
npx eslint "app/api/auction-engine/**/*.ts" "components/Auction/AuctionRuntimeBoard.tsx" "components/Backoffice/Auctions/ManagerControlRoom.tsx" "hooks/actions/auctionEngineActions.ts" "lib/auctions/engine-types.ts"
npm run build
~~~

Observed:

- Engine unit tests: 9 passed; integration test: 1 passed, including snapshot, idempotent registration, idempotent bid and WebSocket snapshot/event. The identity unit tests cover trusted display-name normalization and the readable fallback label.
- Backend tests: 64 suites and 267 tests passed. Backend build and new auction integration lint passed.
- Frontend targeted lint passed, sitemap tests passed, TypeScript passed and `next build` passed. The build still emits existing dynamic-render/fetch diagnostics from unrelated routes during static collection; the new auction-engine routes compiled and appeared in the route manifest. The full frontend lint remains blocked by the existing repository baseline (264 errors/208 warnings) after adding the missing ESLint 9 flat config.
- Full backend lint remains blocked by the existing repository baseline (146 errors/117 warnings outside the new engine integration). The new files are clean.
- After the identity/registration changes, direct `npx nest build`, isolated backend lint, engine `npm run build`, engine lint, frontend targeted lint and frontend TypeScript all passed. A previous backend `npm run build` retry was blocked only by an existing watcher holding Prisma's Windows query-engine DLL; the backend source build itself passed with `npx nest build`.
- Manual live smoke test passed: engine health/readiness, direct and backend/BFF snapshots, registration/bid idempotency, manager stream, WebSocket connected/snapshot, outbox/RabbitMQ delivery and backend projection by externalLotId. Existing DLQ messages from the earlier ID-mapping test were left intact and were not purged.
- New runtime smoke passed: sandbox creation returned `RUNNING` with `OPEN` lots and a `mock/LIVE` stream; repeated `sandbox-repeat-20260804` returned the same external execution; BFF snapshot and `/leiloes/teste/:externalAuctionId` returned 200; a sandbox bid was accepted and repeated with the same idempotency key; invalid `start` on a running auction returned 409 `INVALID_AUCTION_TRANSITION` with allowed transitions; manager stream command changed the authoritative status to `ENDED`.
- The identity follow-up smoke passed after restarting the built API: backend registration GET returned empty before registration and `APPROVED` after idempotent registration; a backend bid returned `currentBidderName: LAPIS`; the public test page returned HTTP 200 after the authoritative snapshot update.

### Registration and bidder identity follow-up

- Added `GET /api/auction-engine/auctions/:auctionId/registration`. The frontend now reads the authoritative registration on mount, so a refresh restores `APPROVED` instead of resetting a local-only flag.
- Registration is scoped to the authenticated backend user. If a sandbox was created by another account, the same button now registers the currently logged-in account and reports a clear recovery message when a bid is attempted too early.
- Backend bid/proxy commands resolve the current user's `companyName` or `name` from the existing identity database and pass it through the authenticated internal contract. The engine persists the display name in `bid_request`, `bid_intent` and `proxy_bid`, including manual approval and proxy-lead changes.
- Public snapshots expose `currentBidderName`; legacy hash aliases are hidden from the public label when no real display name exists. New backend bids now show the real account name (for example, `LAPIS`) instead of `Participante ABC123`.
- Friendly error copy was updated for registration, session, permission, stale-state and transition failures. Technical code/reference remain available under “Ver detalhes técnicos”.
- Smoke validation: registration GET returned `null` before registration and `APPROVED` after the idempotent POST; a backend-authenticated bid returned `currentBidderAlias: LAPIS` and the snapshot returned `currentBidderName: LAPIS` after refresh.

### CRUD state projection and auction-screen follow-up

- Manager transitions now immediately project the authoritative engine state back to the catalog CRUD when the external auction/lot ID is a valid catalog ObjectId. `RUNNING` and `PAUSED` map to the existing catalog `OPEN` state; `FINISHED` maps to `CLOSED`; lot `SOLD`, `UNSOLD`, `CANCELLED` and `OPEN` map to their compatible catalog states.
- RabbitMQ auction/lot events carry `externalAuctionId` and `externalLotId`. The backend consumer applies the same projection inside its idempotent inbox transaction, so direct engine commands also converge the CRUD without making Mongo the ledger.
- The legacy Mongo bidder projection now prefers engine `currentBidderName` and falls back to the alias only when no trusted name is available.
- Public and sandbox experiences use the same runtime board. Video, realtime scoreboard and bid controls are rendered only while the authoritative engine snapshot is `RUNNING`; scheduled, paused, finished and unavailable executions show a friendly state panel instead of a stale live screen.
- Public auction and manager control-room content now occupies the available lateral space. TIMED lots expose four fixed bid buttons calculated from the engine `nextBidCents` and `incrementCents`, plus custom amount and secret proxy ceiling actions.
- After manager commands, or when a direct engine action is detected by polling, the control room refreshes both the engine snapshot and the server-rendered CRUD header. The public board continues polling and reconnecting through WebSocket, showing visual activity notifications without requiring F5.
- Fixed the public live-page sticky activity feed offset: it now remains below the 80px desktop platform header (`xl:top-24`) instead of being covered while the page scrolls.
- Fixed bid reconciliation: manual bids now publish the amount actually submitted when they lead without a runner; bid/proxy responses and `bid.accepted` events include `nextBidCents`; the frontend applies price, next bid, version and leadership immediately.
- Added an authenticated own-proxy endpoint and private UI state. A participant sees their active ceiling after submission and after refresh, while public snapshots and other participants never receive `proxyMaxBidCents`.
- Proxy ceilings remain automatic: the public price is the minimum effective amount required to lead, not the hidden ceiling. A user can raise the ceiling through the automatic-ceiling action; covered quick bids are visually disabled with an explanatory private-ceiling message.

Latest visual/state smoke:

- Sandbox execution `sandbox-63b43b44-4106-4d00-8c5f-3c32cebd15b9` was created as `RUNNING`, then finished directly in the engine; the public test route returned 200 and switched to “A transmissão ainda não está disponível” without a page reload.
- The catalog Mongo database had no local auction records available for a destructive-free end-to-end projection fixture, so the ObjectId CRUD update path was validated by compilation/targeted lint and the live sandbox path by HTTP smoke. A real catalog fixture should be used in staging to verify the persisted `OPEN` ↔ `CLOSED` projection.

## Pending external integration

- The backend event consumer currently logs winner/settlement/notification events and updates the safe legacy projection. A product-specific outbound email/WhatsApp/push adapter still needs the final notification provider contract and recipient policy; no fake delivery was introduced.
- Payment/settlement execution, invoices and collection remain downstream responsibilities. The engine creates the settlement state/event but does not charge money.
- Live streaming provider provisioning is represented by an idempotent manager stream command; provider credentials/webhooks are not available in the inspected repositories.
- Production auth, TLS, secrets management, RabbitMQ HA and observability exporters need deployment-specific configuration.
- Automated load/chaos testing, browser E2E and a full multi-instance WebSocket soak test were not run in this environment.
- Sandbox history is intentionally not listed from PostgreSQL yet: each click creates an isolated execution and returns direct public/control-room links. A searchable test-run index and cleanup policy can be added after the team defines retention; no destructive delete/reset was introduced.

### Lot sequencing and public history follow-up

- New sandbox executions now accept up to 50 lots, start the first lot as `OPEN`, and create every following lot as `PAUSED`. Paused sandbox lots have no expiration until a manager opens them; opening/resuming a lot with no schedule assigns a safe 30-minute window.
- Catalog publication now sends the first lot as `OPEN` and the remaining lots as `PAUSED`. Explicit `QUEUED`, `OPEN` and `PAUSED` values are accepted by the versioned internal publish contract. Existing execution statuses are preserved on idempotent re-publication.
- The authoritative snapshot now includes `winnerName`, `winningAmountCents` and `closedAt` for completed lots. Closing remains idempotent and emits the final winner/value in the lot event payload; the bid ledger is unchanged and remains PostgreSQL-backed.
- The public runtime board renders only active non-paused lots. `PAUSED` and `QUEUED` lots remain available to the manager control room but are hidden from the public board. `SOLD`, `UNSOLD` and `CANCELLED` lots move into a lower “Lotes encerrados” history with status, final amount and winner/unsold result.
- The public page no longer renders stale catalog lot cards. With an authoritative engine snapshot it renders only the engine board; without a published execution it shows an unavailable state instead of exposing CRUD cards, so paused lots cannot reappear through a legacy fallback.

Validation for this change:

- `npm run lint`, `npm run db:validate`, `npm test -- --run`, `npm run build` passed in the engine.
- Targeted backend ESLint and `npx nest build` passed.
- Targeted frontend ESLint, `npx tsc --noEmit` and `npm run build` passed. Existing unrelated Next dynamic-render diagnostics and baseline-browser-mapping warnings remain.
- HTTP smoke created a 20-lot sandbox with exactly `1 OPEN`, `19 PAUSED`, and `0` closed lots; opening lot 2 changed it to `OPEN`; closing lot 1 produced `UNSOLD`; bidding R$ 200,00 on lot 2 as `Maria Smoke` and closing it produced `SOLD`, `winnerName: Maria Smoke`, and `winningAmountCents: 20000`.

- Corrigida uma duplicação no JSX do frontend: uma renderização legada do placar permanecia junto do novo placar filtrado e mostrava lotes `PAUSED`. Agora há uma única renderização pública, baseada em `activeLots`.

The planning document was not modified.
