export { calculateSwapQuote, EMPTY_QUOTE, isEmptyQuote } from './quote';
export type {
  SwapQuoteParams,
  SwapQuote,
  LocalSwapQuoteParams,
  LocalSwapQuote,
  PoolStateWithTicks,
} from './quote';

export {
  buildBurnTx,
  buildCollectTx,
  estimateRemoveAmounts,
  estimateRemoveAmountsAsync,
  ValidationError,
} from './liquidity';
export type {
  BurnTxParams,
  CollectTxParams,
  UnsignedTx,
  BurnUnsignedTx,
  CollectUnsignedTx,
  RemoveAmountsResult,
  RemoveAmountsParams,
} from './liquidity';

// #69 — Pool query helpers
export {
  getPool,
  getPosition,
  getPositionWithLoading,
  getTick,
  EMPTY_POSITION_MESSAGE,
} from './queries';
export type { PoolState, PositionState, TickState } from './types';
export { SwyftRpcError } from './types';

export { buildSwapTx, toStellarAddress, toRawAmount, toXdrBase64, SwapValidationError } from './swap';
export type { PoolId, SwapTxParams, SwapUnsignedTx, StellarAddress, RawAmount, XdrBase64 } from './swap';

// #973 — SDK error mapping from contract errors
export {
  SdkError,
  SdkErrorCode,
  CONTRACT_ERROR_CODE_MAP,
  mapContractError,
  withContractErrorMapping,
} from './errors';
export type { RawContractError } from './errors';

export { config } from './config';
