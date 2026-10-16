import {
  getAmountsForLiquidity,
  tickToSqrtPriceX96,
} from '@swyft/sdk/position-math';
import { calculatePoolTvl } from './pool-tvl';

describe('calculatePoolTvl', () => {
  const position = {
    lowerTick: -200,
    upperTick: 200,
    liquidity: '1000000000000',
  };
  const currentSqrtPrice = (1n << 96n).toString();

  it('values each open position at its own range using integer amount math', () => {
    const result = calculatePoolTvl({
      currentSqrtPrice,
      positions: [position],
      price0: 2,
      price1: 3,
      decimals0: 6,
      decimals1: 7,
    });
    const { amount0, amount1 } = getAmountsForLiquidity({
      sqrtPriceX96: BigInt(currentSqrtPrice),
      sqrtPriceLowerX96: tickToSqrtPriceX96(position.lowerTick),
      sqrtPriceUpperX96: tickToSqrtPriceX96(position.upperTick),
      liquidity: BigInt(position.liquidity),
    });
    const expected =
      (Number(amount0) / 10 ** 6) * 2 + (Number(amount1) / 10 ** 7) * 3;
    expect(result).toBe(expected);
  });

  it('sums distinct ranges rather than applying aggregate pool liquidity once', () => {
    const result = calculatePoolTvl({
      currentSqrtPrice,
      positions: [
        position,
        { lowerTick: -100, upperTick: 100, liquidity: '1000000000000' },
      ],
      price0: 1,
      price1: 1,
      decimals0: 0,
      decimals1: 0,
    });
    const onePosition = calculatePoolTvl({
      currentSqrtPrice,
      positions: [position],
      price0: 1,
      price1: 1,
      decimals0: 0,
      decimals1: 0,
    });
    expect(result).toBeGreaterThan(onePosition);
  });

  it('returns zero only when there are no open positions', () => {
    expect(
      calculatePoolTvl({
        currentSqrtPrice,
        positions: [],
        price0: 1,
        price1: 1,
        decimals0: 7,
        decimals1: 18,
      }),
    ).toBe(0);
  });

  it.each([
    { price0: 0, price1: 1 },
    { price0: 1, price1: Number.NaN },
  ])('rejects missing or invalid USD prices', ({ price0, price1 }) => {
    expect(() =>
      calculatePoolTvl({
        currentSqrtPrice,
        positions: [position],
        price0,
        price1,
        decimals0: 7,
        decimals1: 7,
      }),
    ).toThrow('Pool USD prices are invalid');
  });

  it('rejects malformed position data rather than storing misleading TVL', () => {
    expect(() =>
      calculatePoolTvl({
        currentSqrtPrice,
        positions: [{ ...position, liquidity: '-1' }],
        price0: 1,
        price1: 1,
        decimals0: 7,
        decimals1: 7,
      }),
    ).toThrow('Indexed position liquidity is invalid');
  });

  it('does not silently round reserves that exceed Number.MAX_SAFE_INTEGER', () => {
    // A liquidity value near the Q64.96 range pushes the derived reserves well
    // past Number.MAX_SAFE_INTEGER, where a raw `Number(reserve)` conversion
    // would silently lose precision. The function must either compute the TVL
    // exactly within a documented tolerance or reject the input outright.
    const hugeLiquidity = (1n << 96n).toString();
    const hugePosition = {
      lowerTick: -200,
      upperTick: 200,
      liquidity: hugeLiquidity,
    };
    const { amount0, amount1 } = getAmountsForLiquidity({
      sqrtPriceX96: BigInt(currentSqrtPrice),
      sqrtPriceLowerX96: tickToSqrtPriceX96(hugePosition.lowerTick),
      sqrtPriceUpperX96: tickToSqrtPriceX96(hugePosition.upperTick),
      liquidity: BigInt(hugeLiquidity),
    });
    expect(amount0 > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(amount1 > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    const price0 = 2;
    const price1 = 3;
    const decimals0 = 6;
    const decimals1 = 7;

    let result: number | undefined;
    try {
      result = calculatePoolTvl({
        currentSqrtPrice,
        positions: [hugePosition],
        price0,
        price1,
        decimals0,
        decimals1,
      });
    } catch (error) {
      expect((error as Error).message).toBe('Computed pool TVL is invalid');
      return;
    }

    // If the function chooses to compute rather than reject, the result must
    // match the exact bigint-scaled value within a documented tolerance.
    const scale0 = 10n ** BigInt(decimals0);
    const scale1 = 10n ** BigInt(decimals1);
    const exact =
      (Number(amount0 / scale0) + Number(amount0 % scale0) / Number(scale0)) *
        price0 +
      (Number(amount1 / scale1) + Number(amount1 % scale1) / Number(scale1)) *
        price1;
    expect(result).toBeCloseTo(exact, 6);
  });
});
