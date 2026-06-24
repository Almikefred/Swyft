import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Worker, Job, QueueEvents } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import {
  QUEUE_NAMES,
  makeQueueOptions,
  PoolCreatedJobData,
  SwapProcessedJobData,
  PositionMintedJobData,
  PositionBurnedJobData,
  FeesCollectedJobData,
} from './queues';

@Injectable()
export class IndexerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerWorker.name);
  private readonly prisma = new PrismaClient();
  private readonly workers: Worker[] = [];
  private readonly queueEvents: QueueEvents[] = [];
  private _isLoading = false;
  private _isReady = false;

  get isLoading(): boolean {
    return this._isLoading;
  }

  async onModuleInit() {
    this._isLoading = true;
    const connection = makeQueueOptions().connection;

    this.workers.push(
      this.makeWorker<PoolCreatedJobData>(QUEUE_NAMES.POOL_CREATED, (job) =>
        this.handlePoolCreated(job),
      ),
      this.makeWorker<SwapProcessedJobData>(QUEUE_NAMES.SWAP_PROCESSED, (job) =>
        this.handleSwapProcessed(job),
      ),
      this.makeWorker<PositionMintedJobData>(
        QUEUE_NAMES.POSITION_MINTED,
        (job) => this.handlePositionMinted(job),
      ),
      this.makeWorker<PositionBurnedJobData>(
        QUEUE_NAMES.POSITION_BURNED,
        (job) => this.handlePositionBurned(job),
      ),
      this.makeWorker<FeesCollectedJobData>(QUEUE_NAMES.FEES_COLLECTED, (job) =>
        this.handleFeesCollected(job),
      ),
    );

    for (const name of Object.values(QUEUE_NAMES)) {
      const qe = new QueueEvents(name, { connection });
      qe.on('failed', ({ jobId, failedReason }) => {
        this.logger.error(
          `[DLQ] queue=${name} jobId=${jobId} reason=${failedReason}`,
        );
      });
      this.queueEvents.push(qe);
    }

    this._isReady = true;
    this.logger.log('Indexer workers ready');
    void this.logQueueDepths();
    this._isLoading = false;
    setInterval(() => void this.logQueueDepths(), 60_000);
  }

  async onModuleDestroy() {
    await Promise.all([
      ...this.workers.map((w) => w.close()),
      ...this.queueEvents.map((qe) => qe.close()),
    ]);
    await this.prisma.$disconnect();
    this._isLoading = false;
    this.logger.log('Indexer workers shut down gracefully');
  }

  private makeWorker<T>(
    queueName: string,
    handler: (job: Job<T>) => Promise<void>,
  ): Worker<T> {
    const { connection } = makeQueueOptions();
    const guardedHandler = async (job: Job<T>) => {
      if (!this._isReady) {
        this.logger.warn(
          `queue=${queueName} jobId=${job.id} skipped — indexer not ready`,
        );
        return;
      }
      return handler(job);
    };
    const worker = new Worker<T>(queueName, guardedHandler, { connection });

    worker.on('completed', (job) => {
      this.logger.log(`completed queue=${queueName} jobId=${job.id}`);
    });
    worker.on('failed', (job, err) => {
      const attempts = job?.attemptsMade ?? 0;
      this.logger.warn(
        `failed queue=${queueName} jobId=${job?.id} attempt=${attempts} err=${err.message}`,
      );
    });

    return worker;
  }

  private async logQueueDepths() {
    for (const worker of this.workers) {
      const counts = await worker.client
        .then(async (client) => {
          const waiting = await client.llen(`bull:${worker.name}:wait`);
          const active = await client.llen(`bull:${worker.name}:active`);
          return { waiting, active };
        })
        .catch(() => null);

      if (counts) {
        if (counts.waiting === 0 && counts.active === 0) {
          this.logger.debug(
            `queue=${worker.name} is empty — no events to process`,
          );
        } else {
          this.logger.log(
            `queue=${worker.name} waiting=${counts.waiting} active=${counts.active}`,
          );
        }
      }
    }
  }

  /**
   * Returns true when all required string fields on a job payload are
   * non-empty. Logs a warning and skips persistence for empty payloads so
   * a malformed event never crashes the worker or breaks downstream consumers.
   */
  private guardEmptyData(
    jobId: string | undefined,
    data: Record<string, unknown>,
  ): boolean {
    const empty = Object.entries(data).filter(
      ([, v]) => v === null || v === undefined || v === '',
    );
    if (empty.length > 0) {
      this.logger.warn(
        `Skipping job ${jobId ?? 'unknown'} — empty fields: ${empty.map(([k]) => k).join(', ')}. ` +
          'Check the upstream event emitter; no data was persisted for this event.',
      );
      return false;
    }
    return true;
  }

  private async handlePoolCreated(job: Job<PoolCreatedJobData>) {
    const d = job.data;
    if (!this.guardEmptyData(job.id, d as unknown as Record<string, unknown>))
      return;
    const feeTier = Number(d.fee);
    if (!Number.isSafeInteger(feeTier) || feeTier < 0) {
      this.logger.warn(
        `Skipping job ${job.id ?? 'unknown'} — invalid pool fee: ${d.fee}`,
      );
      return;
    }

    // The event log remains the audit trail while the transaction maintains
    // the query-facing Pool and Token projections in lockstep.
    await this.prisma.$transaction([
      this.prisma.token.upsert({
        where: { address: d.tokenA },
        update: {},
        create: this.unknownToken(d.tokenA),
      }),
      this.prisma.token.upsert({
        where: { address: d.tokenB },
        update: {},
        create: this.unknownToken(d.tokenB),
      }),
      this.prisma.pool.upsert({
        where: { id: d.poolId },
        update: {
          token0Address: d.tokenA,
          token1Address: d.tokenB,
          feeTier,
          currentSqrtPrice: d.sqrtPriceX96,
        },
        create: {
          id: d.poolId,
          token0Address: d.tokenA,
          token1Address: d.tokenB,
          feeTier,
          currentSqrtPrice: d.sqrtPriceX96,
          currentTick: 0,
          liquidity: '0',
          tvl: '0',
          volume24h: '0',
          feeApr: '0',
        },
      }),
      this.prisma.poolCreated.upsert({
        where: { eventId: d.eventId },
        update: {},
        create: {
          eventId: d.eventId,
          poolId: d.poolId,
          tokenA: d.tokenA,
          tokenB: d.tokenB,
          fee: d.fee,
          sqrtPriceX96: d.sqrtPriceX96,
        },
      }),
    ]);
  }

  private async handleSwapProcessed(job: Job<SwapProcessedJobData>) {
    const d = job.data;
    if (!this.guardEmptyData(job.id, d as unknown as Record<string, unknown>))
      return;
    await this.prisma.$transaction([
      this.prisma.swap.upsert({
        where: { eventId: d.eventId },
        update: {},
        create: {
          eventId: d.eventId,
          poolId: d.poolId,
          senderAddress: d.sender,
          recipientAddress: d.recipient,
          amount0: d.amount0,
          amount1: d.amount1,
          sqrtPriceAfter: d.sqrtPriceX96,
          tickAfter: d.tick,
          transactionHash: d.transactionHash ?? d.eventId,
          ...(d.timestamp ? { timestamp: new Date(d.timestamp) } : {}),
        },
      }),
      this.prisma.pool.update({
        where: { id: d.poolId },
        data: {
          currentSqrtPrice: d.sqrtPriceX96,
          currentTick: d.tick,
          liquidity: d.liquidity,
        },
      }),
      this.prisma.swapProcessed.upsert({
        where: { eventId: d.eventId },
        update: {},
        create: {
          eventId: d.eventId,
          poolId: d.poolId,
          sender: d.sender,
          recipient: d.recipient,
          amount0: d.amount0,
          amount1: d.amount1,
          sqrtPriceX96: d.sqrtPriceX96,
          liquidity: d.liquidity,
          tick: d.tick,
        },
      }),
    ]);
  }

  private async handlePositionMinted(job: Job<PositionMintedJobData>) {
    const d = job.data;
    if (!this.guardEmptyData(job.id, d as unknown as Record<string, unknown>))
      return;
    await this.prisma.$transaction([
      this.prisma.position.upsert({
        where: { poolId_tokenId: { poolId: d.poolId, tokenId: d.tokenId } },
        update: {
          ownerAddress: d.owner,
          lowerTick: d.tickLower,
          upperTick: d.tickUpper,
          liquidity: d.liquidity,
          closedAt: null,
        },
        create: {
          poolId: d.poolId,
          tokenId: d.tokenId,
          ownerAddress: d.owner,
          lowerTick: d.tickLower,
          upperTick: d.tickUpper,
          liquidity: d.liquidity,
        },
      }),
      this.prisma.positionMinted.upsert({
        where: { eventId: d.eventId },
        update: {},
        create: {
          eventId: d.eventId,
          poolId: d.poolId,
          owner: d.owner,
          tickLower: d.tickLower,
          tickUpper: d.tickUpper,
          liquidity: d.liquidity,
          amount0: d.amount0,
          amount1: d.amount1,
        },
      }),
    ]);
  }

  private async handlePositionBurned(job: Job<PositionBurnedJobData>) {
    const d = job.data;
    if (!this.guardEmptyData(job.id, d as unknown as Record<string, unknown>))
      return;
    await this.prisma.$transaction([
      this.prisma.position.upsert({
        where: { poolId_tokenId: { poolId: d.poolId, tokenId: d.tokenId } },
        update: {
          ownerAddress: d.owner,
          lowerTick: d.tickLower,
          upperTick: d.tickUpper,
          liquidity: d.liquidity,
          closedAt: d.liquidity === '0' ? new Date() : null,
        },
        create: {
          poolId: d.poolId,
          tokenId: d.tokenId,
          ownerAddress: d.owner,
          lowerTick: d.tickLower,
          upperTick: d.tickUpper,
          liquidity: d.liquidity,
          ...(d.liquidity === '0' ? { closedAt: new Date() } : {}),
        },
      }),
      this.prisma.positionBurned.upsert({
        where: { eventId: d.eventId },
        update: {},
        create: {
          eventId: d.eventId,
          poolId: d.poolId,
          owner: d.owner,
          tickLower: d.tickLower,
          tickUpper: d.tickUpper,
          liquidity: d.liquidity,
          amount0: d.amount0,
          amount1: d.amount1,
        },
      }),
    ]);
  }

  private unknownToken(address: string) {
    return {
      address,
      symbol: 'UNKNOWN',
      name: address,
      decimals: 7,
    };
  }

  private async handleFeesCollected(job: Job<FeesCollectedJobData>) {
    const d = job.data;
    if (!this.guardEmptyData(job.id, d as unknown as Record<string, unknown>))
      return;
    await this.prisma.feesCollected.upsert({
      where: { eventId: d.eventId },
      update: {},
      create: {
        eventId: d.eventId,
        poolId: d.poolId,
        recipient: d.recipient,
        amount0: d.amount0,
        amount1: d.amount1,
      },
    });
  }
}
