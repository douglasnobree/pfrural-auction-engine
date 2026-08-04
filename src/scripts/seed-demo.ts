import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const now = new Date();

async function main(): Promise<void> {
  const timed = await prisma.auctionExecution.upsert({
    where: { externalAuctionId: 'demo-timed' },
    update: { status: 'RUNNING' },
    create: { externalAuctionId: 'demo-timed', title: 'Demo Timed Auction', mode: 'TIMED', status: 'RUNNING', regulationVersion: 'demo-v1', startsAt: now },
  });
  const timedLot = await prisma.auctionLotExecution.upsert({
    where: { auctionId_externalLotId: { auctionId: timed.id, externalLotId: 'demo-timed-lot-1' } },
    update: { status: 'OPEN', endsAt: new Date(Date.now() + 30 * 60 * 1000) },
    create: { auctionId: timed.id, externalLotId: 'demo-timed-lot-1', lotNumber: 1, title: 'Demo Timed Lot', status: 'OPEN', startingBidCents: 10000n, incrementCents: 500n, endsAt: new Date(Date.now() + 30 * 60 * 1000), extensionWindowSeconds: 30, extensionSeconds: 30, maxExtensions: 5 },
  });
  const live = await prisma.auctionExecution.upsert({
    where: { externalAuctionId: 'demo-live' },
    update: { status: 'RUNNING' },
    create: { externalAuctionId: 'demo-live', title: 'Demo Live Auction', mode: 'LIVE', status: 'RUNNING', regulationVersion: 'demo-v1', approvalMode: 'MANUAL_FIFO', startsAt: now },
  });
  await prisma.auctionLotExecution.upsert({
    where: { auctionId_externalLotId: { auctionId: live.id, externalLotId: 'demo-live-lot-1' } },
    update: { status: 'OPEN' },
    create: { auctionId: live.id, externalLotId: 'demo-live-lot-1', lotNumber: 1, title: 'Demo Live Lot', status: 'OPEN', startingBidCents: 50000n, incrementCents: 1000n },
  });
  const shopping = await prisma.auctionExecution.upsert({
    where: { externalAuctionId: 'demo-shopping' },
    update: { status: 'RUNNING' },
    create: { externalAuctionId: 'demo-shopping', title: 'Demo Shopping', mode: 'SHOPPING', status: 'RUNNING', regulationVersion: 'demo-v1', startsAt: now },
  });
  await prisma.auctionLotExecution.upsert({
    where: { auctionId_externalLotId: { auctionId: shopping.id, externalLotId: 'demo-shopping-lot-1' } },
    update: { status: 'OPEN', availableQuantity: 1 },
    create: { auctionId: shopping.id, externalLotId: 'demo-shopping-lot-1', lotNumber: 1, title: 'Demo Shopping Lot', status: 'OPEN', fixedPriceCents: 75000n, quantity: 1, availableQuantity: 1 },
  });
  await prisma.auctionRegistration.upsert({ where: { auctionId_userId: { auctionId: timed.id, userId: 'user-demo' } }, update: { status: 'APPROVED' }, create: { auctionId: timed.id, userId: 'user-demo', status: 'APPROVED', termsVersion: 'demo-v1' } });
  console.log(JSON.stringify({ timedAuctionId: timed.id, timedLotId: timedLot.id, liveAuctionId: live.id, shoppingAuctionId: shopping.id }));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
