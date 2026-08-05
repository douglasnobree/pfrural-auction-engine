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
- `.github/workflows/deploy.yml` provides automatic deploys from `main` and manual dispatch through GitHub Actions. It preserves the VPS `.env` and production Compose file, deploys the exact triggering SHA, waits for PostgreSQL/RabbitMQ/Redis health, applies Prisma migrations in an isolated container before starting the new API/worker, then verifies readiness, AMQP and both process states. Failures include bounded service diagnostics without destructive cleanup.

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

- Manager transitions now immediately project the authoritative engine state back to the catalog CRUD when the external auction/lot ID is a valid catalog ObjectId. Auction `RUNNING` maps to `OPEN` and `FINISHED` maps to `CLOSED`; lot `PAUSED` remains paused, while `SOLD`, `UNSOLD`, `CANCELLED` and `OPEN` map to their compatible catalog states.
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
- The public page now distinguishes the operating mode: `LIVE` uses the authoritative engine board/stream, while real `TIMED` auctions render the CRUD catalog as a pre-bid index and send each participant to the individual lot screen for registration, manual bid and proxy ceiling. Catalog cards are filtered against engine `OPEN`/`CLOSING` lots when a snapshot exists, so paused lots remain hidden; an unpublished auction can still expose its public catalog so users can discover the lot pages.

- The individual public lot route now loads the authoritative engine snapshot and embeds a focused realtime bidding panel for that lot. It keeps WebSocket/polling reconciliation, registration persistence, fixed bid increments, proxy ceiling and friendly engine errors on the lot page instead of requiring the user to operate from the auction-wide board.
- The engine bidding window is explicit: `TIMED` scheduled/running executions accept pre-bids, `LIVE` accepts bids only while running, and paused/finished executions are rejected with `AUCTION_NOT_OPEN`. A future lot start does not block a valid scheduled `TIMED` pre-bid.

Validation for this change:

- `npm run lint`, `npm run db:validate`, `npm test -- --run`, `npm run build` passed in the engine.
- Targeted backend ESLint and `npx nest build` passed.
- Targeted frontend ESLint, `npx tsc --noEmit` and `npm run build` passed. Existing unrelated Next dynamic-render diagnostics and baseline-browser-mapping warnings remain.
- HTTP smoke created a 20-lot sandbox with exactly `1 OPEN`, `19 PAUSED`, and `0` closed lots; opening lot 2 changed it to `OPEN`; closing lot 1 produced `UNSOLD`; bidding R$ 200,00 on lot 2 as `Maria Smoke` and closing it produced `SOLD`, `winnerName: Maria Smoke`, and `winningAmountCents: 20000`.

- Corrigida uma duplicação no JSX do frontend: uma renderização legada do placar permanecia junto do novo placar filtrado e mostrava lotes `PAUSED`. Agora há uma única renderização pública, baseada em `activeLots`.

Validation for the pre-bid lot-screen change:

- Engine: `npm run lint`, `npx tsc -p tsconfig.json --noEmit` and `npm test` passed; 12 tests passed and 1 integration test remained skipped by its existing environment gate.
- Frontend: targeted ESLint and `npx tsc --noEmit` passed for the public auction, lot detail, runtime board and engine error mapping. `next build` was attempted but timed out while existing Next/Node processes were active in the local workspace; no TypeScript or ESLint error was reported.

The planning document was not modified.

## Business rules delivered on 2026-08-05

### Auction modes and bidding windows

- Added `AuctionMode` to the existing backend CRUD with `TIMED` as the backward-compatible default. The admin form now explicitly selects `Pré-lance / fechamento`, `Ao vivo` or `Shopping / reserva`.
- `TIMED` and `SHOPPING` accept registered participant bids during their configured pre-bid period and remain bid-capable while running. The lot start time does not incorrectly block a valid scheduled pre-bid. The migration backfills `pre_bid_enabled=true` for existing TIMED and SHOPPING executions.
- `LIVE` accepts pre-bids only when pre-bid dates are configured (`preBidEnabled` is derived from those dates), and accepts real-time bids after the engine transitions to `RUNNING`. Without pre-bid dates, a scheduled LIVE auction stays view-only until the manager starts it.
- The engine enforces `preBidStartsAt`, `preBidEndsAt` and the LIVE fallback cutoff at `auction.startsAt`, returning explicit `PREBID_NOT_STARTED`, `PREBID_CLOSED` or `AUCTION_NOT_OPEN` errors.
- CRUD publication sends mode and pre-bid dates to the PostgreSQL engine. CRUD `OPEN`/`CLOSED` changes and automatic lifecycle changes attempt idempotent engine `start`/`finish` commands; engine manager commands continue projecting the authoritative result back to CRUD.

### Participant access and delegated bids

- Public registration lookup is now optional for anonymous visitors. The page can render normally; clicking a bid/reservation action invokes the authenticated action, which redirects an anonymous visitor to `/login` and lets an authenticated visitor complete auction registration.
- Every bid origin (`ONLINE`, `PROXY`, `FLOOR`, `PHONE`) requires an `APPROVED` auction registration for the target participant.
- Manager FLOOR/PHONE commands resolve the target user's `companyName`/`name` in the backend, pass it through the trusted internal contract, persist it in the engine ledger and keep the manager as `actorId`. The displayed leader is therefore the registered target, not a random alias.
- LIVE `MANUAL_FIFO` approval applies only to online/proxy requests. Trusted manager FLOOR/PHONE commands are not incorrectly held in the public approval queue.

### Frontend behavior

- Runtime lot controls now use the authoritative mode/window and retain the fixed increment buttons, custom bid and secret proxy ceiling. A bid click while participation is not enabled starts the registration/authentication flow instead of silently disabling the action.
- LIVE pre-bid/catalog cards are available before the stream; the LIVE stream area is reserved for that mode and uses the mock provider until a real provider is configured. TIMED and SHOPPING use the same lot-level bid flow without a stream.
- Snapshot types expose `preBidEnabled`, `preBidStartsAt` and `preBidEndsAt`; CRUD catalog types expose the auction mode.

### Validation in this round

Passed:

~~~text
Engine: npm run db:validate, npm test (14 passed, 1 existing integration skipped), npm run lint, npm run build
Backend: npm run prisma:generate, npx tsc -p tsconfig.json --noEmit, targeted ESLint, npm test -- --runInBand (64 suites / 267 tests), npm run build
Frontend: npx tsc --noEmit, targeted ESLint, npm run build
~~~

The full frontend lint remains a repository-wide baseline issue outside the auction changes (263 errors and 208 warnings in unrelated files). No planning document was changed. Prisma Mongo uses `db push`/deployment schema synchronization as before; the new PostgreSQL engine field uses the safe migration `prisma/migrations/20260805110000_prebid_rules/migration.sql`.

## Remaining operational work

- Run the new engine migration in staging/production before publishing auctions with pre-bid fields.
- Verify one real Mongo catalog auction with a valid ObjectId through publish → automatic OPEN → engine start → manager finish → CRUD CLOSED; local validation covered compilation and the existing sandbox path but did not mutate a production-like catalog fixture.
- Keep external settlement/payment collection and real streaming provider provisioning behind their existing downstream contracts; no fake financial settlement or provider credentials were introduced.

### Correções desta rodada: semântica de formatos e experiência pública

- `SHOPPING` agora é tratado pelo engine como a mesma janela de pré-lance de `TIMED`; a nomenclatura comercial não remove mais os controles de lance. Reserva transacional continua disponível apenas como opção complementar quando o lote possui `fixedPriceCents`.
- `LIVE` permanece o único formato com transmissão. O frontend reserva a área de transmissão para todo leilão LIVE e usa o mock enquanto o provedor real não estiver configurado; `TIMED` e `SHOPPING` não renderizam transmissão.
- O catálogo público exibe somente lotes `OPEN`/`CLOSING`; lotes pausados continuam ocultos. Lotes `SOLD`/`UNSOLD`/`CANCELLED` são exibidos abaixo, com resultado, valor final e vencedor quando disponível.
- A página pública de catálogo agora mostra preço atual/próximo lance e direciona ao lote com `Dar lance`. A página individual mantém os botões fixos, valor personalizado, teto automático e cadastro diretamente abaixo do preço, com atualização por snapshot/WebSocket/polling sem F5.
- O lookup de participação, ticket de realtime e consulta de teto automático não redirecionam visitantes anonimamente. O login/cadastro só é solicitado quando a pessoa executa um comando que exige autenticação.
- O formulário administrativo passou a explicar os três formatos, indicar transmissão obrigatória/opcional, validar a ordem das datas de pré-lance e explicar a agenda antes do salvamento.
- A projeção compatível do backend passou a preservar `PAUSED` no CRUD de lotes, sem transformar pausa em `OPEN`; o ledger autoritativo continua exclusivamente no PostgreSQL do engine.

Validation after these corrections:

~~~text
Engine: npm test (15 passed, 1 existing integration skipped), npm run lint, npm run build
Backend: npx prisma generate, npx tsc -p tsconfig.json --noEmit, npm test -- --runInBand (64 suites / 267 tests), npm run build
Frontend: npx tsc --noEmit, targeted ESLint, npm run build
~~~

### Correção de publicação do lote de pré-lance

- Diagnóstico confirmado no leilão real de teste `Teste lance` (`/leiloes/lance/lotes/teste`): a API do engine falhava ao publicar a execução com `P2022`, porque a coluna `auction_execution.pre_bid_enabled` ainda não existia no banco PostgreSQL em uso. O frontend recebia esse cenário como “lote não publicado”, embora o cadastro e as datas do CRUD estivessem corretos.
- A migration segura `prisma/migrations/20260805110000_prebid_rules/migration.sql` foi aplicada no banco local. A execução passou a ser publicada como `SCHEDULED`, o lote como `OPEN`, com próximo lance de R$ 1,00 e pré-lance habilitado.
- O backend agora faz reconciliação idempotente ao carregar uma página pública: publica novamente o catálogo no engine quando necessário e sincroniza uma transição CRUD `OPEN`. Isso recupera leilões existentes que foram cadastrados antes da migration ou cuja primeira publicação falhou, sem usar Mongo como ledger.
- Redis deve estar disponível junto do engine para registro, rate limit, presença e realtime. O container local `pfrural-auction-redis` foi iniciado durante a validação.

Validation of the created test auction:

~~~text
GET /api/auctions/public/lance                         -> 200
GET /api/auctions/public/lance/lots/teste/snapshot     -> SCHEDULED / OPEN / nextBidCents=100
POST /v1/internal/registrations                         -> 200
POST /v1/lots/{engineLotId}/bids                        -> 200
GET /leiloes/lance/lotes/teste                          -> 200, “Dar lance” presente
                                                          mensagem “não publicado” ausente
Backend: npx tsc -p tsconfig.json --noEmit, npm test -- --runInBand (64 suites / 267 tests), npm run build
~~~

Production requirement: execute `npx prisma migrate deploy` in the auction-engine container before publishing or opening auctions with pre-lance. If the existing test auction was created while the migration was missing, opening its public page once triggers the idempotent reconciliation; the manager can then continue the normal opening workflow.

The placeholder image shown in the test screenshot is independent of bidding: that CRUD lot has no image registered. The bidding controls are now released by the engine publication state.

## Global auction eligibility and delegated bidding — 2026-08-05

### Delivered

- Added the optional, backward-compatible Mongo user flag `auctionEnabled`. This is the single global manual eligibility decision: an enabled registered user may join any auction; disabling the user blocks bid, proxy, reservation and assisted manager commands in every auction.
- Auction registration is still recorded per execution for terms/audit, but it is no longer the source of the manual eligibility decision. A new request starts as `PENDING`; when the backend confirms the global flag, the engine creates or reconciles the execution registration as `APPROVED`.
- Added a manager participant tab with pending requests, user identity and one global eligibility switch. The admin can also search any registered user by name, company or email and enable or block that person before any auction-specific request. Reloading does not reset the state because the decision is persisted on the backend user, not in React or Redis.
- Added idempotent manager registration approval/suspension endpoints and versioned `registration.requested`, `registration.approved` and `registration.suspended` outbox events.
- Added manager search across registered users by name, company or email. The control room can select an enabled user, an open lot, the `PHONE` or `FLOOR` origin and an amount, then place a bid in that person's name. PostgreSQL records the selected participant as bidder and the authenticated admin as actor; the public leader therefore shows the real user's display name.
- Split control-room behavior by auction mode. `TIMED`/`SHOPPING` show pre-bid operation and direct idempotent closing without live stream/start controls. Only `LIVE` exposes stream and start/pause/resume operations.
- Direct finishing from `SCHEDULED` is allowed only for `TIMED`/`SHOPPING`; open lots are closed idempotently first so winners and settlement events are produced before the auction finishes.
- Publication now opens every `TIMED`/`SHOPPING` lot for pre-bids. `LIVE` keeps the sequential first-open/rest-paused policy. Public pages keep the reference layout: centered catalog, focused lot page, bid controls directly below the official price and stream only while a LIVE execution is actually running.
- Public bid controls now distinguish checking, pending manual validation, globally suspended and approved states with friendly messages, polling/realtime reconciliation and F5 persistence.

### Validation

~~~text
Auction engine:
  npm run lint
  npx tsc -p tsconfig.json --noEmit
  npm test
  npm run build

Backend:
  npm run prisma:generate
  npx tsc -p tsconfig.json --noEmit
  npm test -- --runInBand
  npm run build

Frontend:
  npx eslint <auction changed files>
  npx tsc --noEmit
  npm run build

HTTP smoke:
  GET http://localhost:4100/health                  -> 200
  GET http://localhost:4000/api/docs               -> 200
  GET http://localhost:3000/leiloes/lance/lotes/teste -> 200
~~~

Engine tests passed with 19 tests and one existing environment-gated integration test skipped. Backend passed 64 suites / 267 tests. Frontend production build completed successfully.

### Operational notes

- `npx prisma db push --config=./prisma.config2.ts` was not forced because the existing Mongo database contains duplicate values for the unrelated `auction_engine_inbox.eventId` unique index. `auctionEnabled` is optional with a default and Mongo stores it on the first eligibility update, so this feature requires a generated Prisma client but no destructive Mongo migration.
- Existing users with no `auctionEnabled` field are intentionally treated as not enabled until an admin validates them.
- Desktop visual automation reached the running Chrome instance, but Windows was locked and screenshots exposed only the lock screen. Accessibility/HTTP verification completed without changing a real user's global flag. Perform the final pixel review after unlocking the local browser or in staging.
- The planning document remains unchanged. Mongo remains CRUD/profile storage only; all bids, ordering, winners and settlement records remain authoritative in PostgreSQL.
