import { QUEUE_NAMES } from '../indexer/queues';
import { HorizonRecord, toIndexerJob } from './horizon.service';

describe('toIndexerJob', () => {
  const base: Pick<
    HorizonRecord,
    'paging_token' | 'created_at' | 'contract_id'
  > = {
    paging_token: '12345',
    created_at: '2026-06-24T12:00:00.000Z',
    contract_id: 'pool-contract',
  };

  it('maps pool_created into the pool-created queue payload', () => {
    const job = toIndexerJob({
      ...base,
      event_type: 'pool_created',
      data: {
        token_a: 'token-a',
        token_b: 'token-b',
        fee_tier: 3000,
        sqrt_price_x96: '42',
      },
    });

    expect(job).toEqual({
      queue: QUEUE_NAMES.POOL_CREATED,
      data: {
        eventId: '12345',
        poolId: 'pool-contract',
        tokenA: 'token-a',
        tokenB: 'token-b',
        fee: '3000',
        sqrtPriceX96: '42',
      },
    });
  });

  it('maps a swap_processed event and preserves its transaction metadata', () => {
    const job = toIndexerJob({
      ...base,
      id: 'event-2',
      eventType: 'swap_processed',
      transaction_hash: 'tx-abc',
      data: {
        sender: 'sender',
        recipient: 'recipient',
        amount_0: '100',
        amount_1: '-99',
        sqrt_price_x96: '99',
        liquidity: '1000',
        tick: 12,
      },
    });

    expect(job).toEqual({
      queue: QUEUE_NAMES.SWAP_PROCESSED,
      data: expect.objectContaining({
        eventId: 'event-2',
        poolId: 'pool-contract',
        transactionHash: 'tx-abc',
        timestamp: base.created_at,
      }),
    });
  });

  it.each([
    ['position_minted', QUEUE_NAMES.POSITION_MINTED],
    ['position_burned', QUEUE_NAMES.POSITION_BURNED],
  ] as const)('maps %s using the position token ID', (eventType, queue) => {
    const job = toIndexerJob({
      ...base,
      event_type: eventType,
      data: {
        token_id: '7',
        owner: 'owner',
        tick_lower: -60,
        tick_upper: 60,
        liquidity: '0',
        amount_0: '10',
        amount_1: '20',
      },
    });

    expect(job).toEqual({
      queue,
      data: expect.objectContaining({ tokenId: '7', liquidity: '0' }),
    });
  });

  it('ignores incomplete and unrelated records', () => {
    expect(toIndexerJob({ ...base, type: 'account_credited' })).toBeNull();
    expect(
      toIndexerJob({
        ...base,
        event_type: 'swap_processed',
        data: { sender: 'sender' },
      }),
    ).toBeNull();
  });
});
