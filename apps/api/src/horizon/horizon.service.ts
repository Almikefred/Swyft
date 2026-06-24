import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { Horizon } from '@stellar/stellar-sdk';
import { PriceService, PriceEvent } from '../price/price.service';
import { PoolsService } from '../pools/pools.service';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  QUEUE_POOL_CREATED,
  QUEUE_POSITION_BURNED,
  QUEUE_POSITION_MINTED,
  QUEUE_SWAP_PROCESSED,
} from '../indexer/indexer.module';
import {
  PoolCreatedJobData,
  PositionBurnedJobData,
  PositionMintedJobData,
  QUEUE_NAMES,
  SwapProcessedJobData,
} from '../indexer/queues';

type IndexerJob =
  | { queue: typeof QUEUE_NAMES.POOL_CREATED; data: PoolCreatedJobData }
  | { queue: typeof QUEUE_NAMES.SWAP_PROCESSED; data: SwapProcessedJobData }
  | {
      queue: typeof QUEUE_NAMES.POSITION_MINTED;
      data: PositionMintedJobData;
    }
  | {
      queue: typeof QUEUE_NAMES.POSITION_BURNED;
      data: PositionBurnedJobData;
    };

/**
 * The relevant Horizon fields differ slightly between effect/event feeds and
 * test fixtures, so parsing accepts both snake_case and camelCase payloads.
 * Unknown or incomplete events are deliberately ignored rather than being
 * turned into poison jobs.
 */
export interface HorizonRecord extends EffectRecord {
  id?: string;
  type?: string;
  event_type?: string;
  eventType?: string;
  contract_id?: string;
  contractId?: string;
  transaction_hash?: string;
  transactionHash?: string;
  topics?: unknown[];
  topic?: unknown;
  data?: unknown;
  value?: unknown;
  details?: unknown;
  [key: string]: unknown;
}

export function toIndexerJob(record: HorizonRecord): IndexerJob | null {
  const payload = eventPayload(record);
  const name = normaliseEventName(
    stringValue(
      record.event_type ??
        record.eventType ??
        payload.event_type ??
        payload.eventType ??
        record.type ??
        record.topic ??
        record.topics?.[0],
    ),
  );
  const eventId = stringValue(record.id ?? record.paging_token);
  const poolId = stringValue(
    payload.poolId ??
      payload.pool_id ??
      payload.pool ??
      record.contract_id ??
      record.contractId,
  );
  if (!eventId || !poolId) return null;

  switch (name) {
    case 'poolcreated': {
      const tokenA = stringValue(
        payload.tokenA ?? payload.token_a ?? payload.token0,
      );
      const tokenB = stringValue(
        payload.tokenB ?? payload.token_b ?? payload.token1,
      );
      const fee = stringValue(
        payload.fee ?? payload.feeTier ?? payload.fee_tier,
      );
      if (!tokenA || !tokenB || !fee) return null;
      return {
        queue: QUEUE_NAMES.POOL_CREATED,
        data: {
          eventId,
          poolId,
          tokenA,
          tokenB,
          fee,
          sqrtPriceX96:
            stringValue(payload.sqrtPriceX96 ?? payload.sqrt_price_x96) ?? '0',
        },
      };
    }
    case 'swapprocessed':
    case 'swap': {
      const sender = stringValue(payload.sender);
      const recipient = stringValue(payload.recipient ?? sender);
      const amount0 = stringValue(payload.amount0 ?? payload.amount_0);
      const amount1 = stringValue(payload.amount1 ?? payload.amount_1);
      const sqrtPriceX96 = stringValue(
        payload.sqrtPriceX96 ?? payload.sqrt_price_x96,
      );
      const liquidity = stringValue(payload.liquidity);
      const tick = numberValue(payload.tick);
      if (
        !sender ||
        !recipient ||
        amount0 === undefined ||
        amount1 === undefined ||
        !sqrtPriceX96 ||
        !liquidity ||
        tick === undefined
      )
        return null;
      return {
        queue: QUEUE_NAMES.SWAP_PROCESSED,
        data: {
          eventId,
          poolId,
          sender,
          recipient,
          amount0,
          amount1,
          sqrtPriceX96,
          liquidity,
          tick,
          transactionHash: stringValue(
            record.transaction_hash ?? record.transactionHash,
          ),
          timestamp: stringValue(record.created_at),
        },
      };
    }
    case 'positionminted':
    case 'mint':
    case 'addliquidity':
      return positionJob(QUEUE_NAMES.POSITION_MINTED, eventId, poolId, payload);
    case 'positionburned':
    case 'burn':
    case 'removeliquidity':
      return positionJob(QUEUE_NAMES.POSITION_BURNED, eventId, poolId, payload);
    default:
      return null;
  }
}

@Injectable()
export class HorizonService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HorizonService.name);
  private readonly server: Horizon.Server;
  private readonly contractId: string;
  private cursor = 'now';
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly priceService: PriceService,
    private readonly poolsService: PoolsService,
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
    @Inject(QUEUE_POOL_CREATED)
    private readonly poolCreatedQueue: Queue<PoolCreatedJobData>,
    @Inject(QUEUE_SWAP_PROCESSED)
    private readonly swapProcessedQueue: Queue<SwapProcessedJobData>,
    @Inject(QUEUE_POSITION_MINTED)
    private readonly positionMintedQueue: Queue<PositionMintedJobData>,
    @Inject(QUEUE_POSITION_BURNED)
    private readonly positionBurnedQueue: Queue<PositionBurnedJobData>,
  ) {
    this.server = new Horizon.Server(
      process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    );
    this.contractId = process.env.POOL_CONTRACT_ID ?? '';
  }

  async onModuleInit() {
    if (!this.contractId) {
      this.logger.warn('POOL_CONTRACT_ID not set — Horizon indexer disabled');
      return;
    }
    const checkpoint = await this.prisma.indexerCursor.findUnique({
      where: { id: this.cursorId() },
    });
    this.cursor = checkpoint?.cursor ?? 'now';
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 5_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const page = await this.server
        .effects()
        .forAccount(this.contractId)
        .cursor(this.cursor)
        .order('asc')
        .limit(50)
        .call();

      for (const rawRecord of page.records as unknown as HorizonRecord[]) {
        if (this.stopped) return;
        const job = toIndexerJob(rawRecord);
        if (job) await this.enqueue(job);

        const priceEvent = this.toPrice(rawRecord);
        if (priceEvent) {
          this.priceService.broadcastPrice(priceEvent);
          await this.poolsService.handlePoolStateUpdate(priceEvent.poolId, {
            currentPrice: priceEvent.currentPrice,
          });
          await this.cache.publish(
            `prices:${priceEvent.poolId}`,
            JSON.stringify(priceEvent),
          );
        }

        // Only checkpoint after every side effect succeeds. If Horizon, Redis,
        // or the database is unavailable, the next poll replays this record.
        await this.saveCursor(rawRecord.paging_token);
      }
    } catch (err) {
      this.logger.warn(`Horizon poll error: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private async enqueue(job: IndexerJob): Promise<void> {
    const options = {
      // BullMQ rejects colons in custom IDs. Encoding also makes arbitrary
      // Horizon paging tokens safe while preserving stable deduplication.
      jobId: `horizon-${Buffer.from(job.data.eventId).toString('base64url')}`,
    };
    if (job.queue === QUEUE_NAMES.POOL_CREATED) {
      await this.poolCreatedQueue.add(job.queue, job.data, options);
    } else if (job.queue === QUEUE_NAMES.SWAP_PROCESSED) {
      await this.swapProcessedQueue.add(job.queue, job.data, options);
    } else if (job.queue === QUEUE_NAMES.POSITION_MINTED) {
      await this.positionMintedQueue.add(job.queue, job.data, options);
    } else {
      await this.positionBurnedQueue.add(job.queue, job.data, options);
    }
  }

  private async saveCursor(cursor: string): Promise<void> {
    this.cursor = cursor;
    await this.prisma.indexerCursor.upsert({
      where: { id: this.cursorId() },
      update: { cursor },
      create: { id: this.cursorId(), cursor },
    });
  }

  private cursorId(): string {
    return `horizon:${this.contractId}`;
  }

  private toPrice(r: EffectRecord): PriceEvent | null {
    if (!r.amount) return null;
    const price = Number(r.amount);
    if (!Number.isFinite(price) || price < 0) return null;
    return {
      poolId: this.contractId,
      currentPrice: r.amount,
      sqrtPrice: Math.sqrt(price).toFixed(7),
      tick: r.tick ?? 0,
      liquidity: r.liquidity ?? '0',
      timestamp: new Date(r.created_at).getTime(),
    };
  }
}

function eventPayload(record: HorizonRecord): Record<string, unknown> {
  for (const value of [record.data, record.value, record.details]) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === 'string') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // A non-JSON event payload is simply not one of our indexer events.
      }
    }
  }
  return record;
}

function positionJob(
  queue:
    | typeof QUEUE_NAMES.POSITION_MINTED
    | typeof QUEUE_NAMES.POSITION_BURNED,
  eventId: string,
  poolId: string,
  payload: Record<string, unknown>,
): IndexerJob | null {
  const tokenId = stringValue(
    payload.tokenId ??
      payload.token_id ??
      payload.positionId ??
      payload.position_id,
  );
  const owner = stringValue(payload.owner);
  const tickLower = numberValue(payload.tickLower ?? payload.tick_lower);
  const tickUpper = numberValue(payload.tickUpper ?? payload.tick_upper);
  const liquidity = stringValue(payload.liquidity);
  const amount0 = stringValue(payload.amount0 ?? payload.amount_0);
  const amount1 = stringValue(payload.amount1 ?? payload.amount_1);
  if (
    !tokenId ||
    !owner ||
    tickLower === undefined ||
    tickUpper === undefined ||
    liquidity === undefined ||
    amount0 === undefined ||
    amount1 === undefined
  )
    return null;
  return {
    queue,
    data: {
      eventId,
      poolId,
      tokenId,
      owner,
      tickLower,
      tickUpper,
      liquidity,
      amount0,
      amount1,
    },
  } as IndexerJob;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function normaliseEventName(value: string | undefined): string | undefined {
  return value?.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface EffectRecord {
  paging_token: string;
  amount?: string;
  tick?: number;
  liquidity?: string;
  created_at: string;
}
