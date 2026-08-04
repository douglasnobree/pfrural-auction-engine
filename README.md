# Princesa Rural Auction Engine

Serviço independente para execução transacional de leilões `TIMED`, `LIVE` e `SHOPPING`. O PostgreSQL é o livro de lances e a autoridade de tempo, ordem, preço, vencedor e auditoria. Redis é somente auxiliar; RabbitMQ transporta eventos pelo padrão transactional outbox/inbox.

## Estado desta entrega

O scaffold é executável e inclui:

- API HTTP com comandos idempotentes, snapshots e contratos versionados;
- worker de outbox, timers de fechamento e consumidor RabbitMQ com publisher confirms, retry e DLQ;
- WebSocket para eventos, sequência por lote e reconexão por snapshot;
- lances `TIMED` manuais e proxy bid com teto privado, empate determinístico e anti-sniping;
- fechamento idempotente, `winner_award` e settlement pendente;
- registros de origem `ONLINE`, `PROXY`, `FLOOR` e `PHONE`;
- comandos auditados de manager para `LIVE`, stream, lote corrente e venda/retirada;
- reserva transacional inicial para `SHOPPING`;
- Prisma ORM com migration PostgreSQL versionada e testes de domínio/integrados;
- sandbox de desenvolvimento idempotente para criar uma execução TIMED nova em um clique, sem misturar dados do catálogo.

O backend Nest existente publica o catálogo no engine por contrato idempotente, expõe o BFF HTTP em `/api/auction-engine`, consome eventos RabbitMQ com inbox deduplicado e mantém somente projeções compatíveis para leitura. O frontend usa Server Actions/session, BFF, páginas públicas, control room, ticket WebSocket e reconexão. Veja `IMPLEMENTATION_STATUS.md` para os limites que continuam dependentes de infraestrutura externa.

## Desenvolvimento local

Requisitos: Node.js 22+, npm 10+ e Docker Compose.

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d
npm run db:migrate
npm run db:seed:demo
npm test
npm run lint
npm run build
```

Em terminais separados:

```powershell
npm run dev:api
npm run dev:worker
```

API: `http://localhost:4100`, health: `GET /health`, readiness: `GET /ready`. RabbitMQ management: `http://localhost:15672` (`auction_engine`/`change_this_rabbitmq_password`). PostgreSQL local: porta `5433`; Redis: porta `6379`.

O seed cria um leilão `TIMED` e um lote aberto. Em desenvolvimento a identidade usa `x-user-id` e `x-actor-role`; isso é rejeitado em produção quando `AUTH_MODE=mock`.

## Contratos principais

Todos os comandos de mutação exigem `Idempotency-Key` e aceitam `X-Correlation-Id`. Valores monetários são strings de centavos no JSON, por exemplo `"125000"` = R$ 1.250,00. Timestamps são ISO-8601 UTC.

```text
GET  /v1/auctions/:auctionId/snapshot
POST /v1/auctions/:auctionId/registrations
POST /v1/lots/:lotId/bids
PUT  /v1/lots/:lotId/proxy-bid
GET  /v1/lots/:lotId/bids
POST /v1/realtime/tickets
POST /v1/shopping-lots/:lotId/reservations
POST /v1/internal/sandbox/auctions  (somente serviço interno; SANDBOX_ENABLED=true)
```

Manager/control room:

```text
POST /v1/manager/auctions/:id/start|pause|resume|finish
POST /v1/manager/lots/:id/open|pause|resume|announce|sell|withdraw
POST /v1/manager/lots/:id/floor-bids
POST /v1/manager/bids/:id/approve|reject
PUT  /v1/manager/auctions/:id/current-lot
PUT  /v1/manager/auctions/:id/stream
```

WebSocket: `ws://localhost:4100/ws?ticket=<one-use-ticket>&auctionId=<id>&since=<lot-sequence>`. O ticket é curto, de uso único e armazenado apenas como hash. O servidor envia `connected`, `snapshot`, `event` e `replayed`; se o histórico não cobrir a sequência solicitada, envia `resync_required`. O cliente deve buscar o snapshot autoritativo.

## Criar uma rodada de teste rapidamente

Com o engine e o backend locais, abra no backoffice `/admin/leiloes/sandbox` e clique em `Criar agora`. A tela cria uma execução TIMED isolada, com lotes abertos e o usuário atual aprovado automaticamente. Cada nova rodada recebe um ID externo próprio; repetir a mesma requisição com a mesma `Idempotency-Key` devolve a execução anterior.

Para testar por HTTP diretamente no engine:

```powershell
$headers = @{
  'X-Internal-Token' = 'local-development-token'
  'X-User-Id' = 'sandbox-user'
  'Idempotency-Key' = 'sandbox-manual-20260804'
}
Invoke-RestMethod -Method Post -Uri http://localhost:4100/v1/internal/sandbox/auctions `
  -Headers $headers -ContentType 'application/json' `
  -Body (@{ label = 'minha rodada'; participantId = 'sandbox-user'; lotCount = 3 } | ConvertTo-Json)
```

O retorno fornece `externalAuctionId` para abrir `/leiloes/teste/<externalAuctionId>` e o control room em `/admin/leiloes/sandbox/<externalAuctionId>`. A sandbox aceita de 1 a 50 lotes; o primeiro começa `OPEN` e todos os demais começam `PAUSED`. O público só vê o lote ativo e os lotes já encerrados no histórico inferior; a control room mantém a fila completa para o manager abrir o próximo lote.

## Integração com os repositórios existentes

O backend atual continua dono de identidade, catálogo, mídia e CRUD. A rota existente `PATCH /api/auctions/:id/publish` sincroniza a execução no engine com idempotência; indisponibilidade do engine é registrada sem quebrar a publicação CRUD. As rotas integradas ficam em `/api/auction-engine/*`, com autenticação/session atual, comandos HTTPS idempotentes e consumidor RabbitMQ para projeção/inbox.

O frontend adiciona o proxy `app/api/auction-engine/[...path]`, Server Actions, tipos/hooks de runtime, página pública compartilhada entre produção e sandbox, player mock de transmissão, board de habilitação/lance/proxy/reserva e control room de manager. O WebSocket entrega eventos e uma consulta automática de segurança mantém a tela atualizada; a resposta HTTPS e o snapshot continuam autoritativos.
