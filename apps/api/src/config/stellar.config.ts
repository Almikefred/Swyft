/**
 * Centralised Stellar / Soroban network configuration.
 *
 * All RPC and Horizon URL values flow through this module so they are:
 *   • validated at startup (missing or malformed URLs cause a loud crash)
 *   • injectable via NestJS DI rather than scattered `process.env` reads
 *   • documented in one place
 *
 * Required env vars (see apps/api/.env.example):
 *   STELLAR_RPC_URL   — Soroban JSON-RPC endpoint
 *   HORIZON_URL       — Horizon REST API endpoint
 *   STELLAR_NETWORK   — "testnet" | "mainnet"  (default: "testnet")
 *   POOL_CONTRACT_ID  — deployed pool contract address (optional on testnet)
 *
 * Testnet wiring mirrors packages/contract/deployments/TESTNET.md. The config
 * is fail-closed: a mainnet passphrase, an unknown network, or a testnet
 * deployment whose URLs/contract IDs drift from the documented values will
 * abort startup with a stable error code rather than silently trading against
 * the wrong network.
 */

import { registerAs } from '@nestjs/config';
import { IsOptional, IsIn, validateSync, IsString, Matches } from 'class-validator';
import { plainToInstance } from 'class-transformer';

// ── Allowed networks ─────────────────────────────────────────────────────────

export type StellarNetwork = 'testnet' | 'mainnet';

/**
 * Canonical testnet deployment values, kept in sync with
 * packages/contract/deployments/TESTNET.md. These are public identifiers only
 * — never put secrets here.
 */
export const TESTNET_DEPLOYMENT = {
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  horizonUrl: 'https://horizon-testnet.stellar.org',
} as const;

const TESTNET_DEFAULTS = {
  rpcUrl: TESTNET_DEPLOYMENT.rpcUrl,
  horizonUrl: TESTNET_DEPLOYMENT.horizonUrl,
} as const;

// Accepts http:// and https:// only — rejects ftp, ws, etc.
const HTTP_URL_PATTERN = /^https?:\/\/.+/;

// Stellar contract IDs are 56-char StrKey (C...) values.
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

// ── Stable error codes ───────────────────────────────────────────────────────

export const StellarConfigErrorCode = {
  INVALID_CONFIG: 'STELLAR_CONFIG_INVALID',
  MAINNET_PASSPHRASE_ON_TESTNET: 'STELLAR_CONFIG_MAINNET_PASSPHRASE',
  UNKNOWN_NETWORK: 'STELLAR_CONFIG_UNKNOWN_NETWORK',
  MISSING_CONTRACT_ID: 'STELLAR_CONFIG_MISSING_CONTRACT_ID',
  ADDRESS_DRIFT: 'STELLAR_CONFIG_ADDRESS_DRIFT',
} as const;

export type StellarConfigErrorCode =
  (typeof StellarConfigErrorCode)[keyof typeof StellarConfigErrorCode];

export class StellarConfigError extends Error {
  readonly code: StellarConfigErrorCode;

  constructor(code: StellarConfigErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'StellarConfigError';
    this.code = code;
  }
}

// ── Validation class ─────────────────────────────────────────────────────────

class StellarEnvVars {
  @Matches(HTTP_URL_PATTERN, {
    message: 'STELLAR_RPC_URL must be a valid http:// or https:// URL',
  })
  STELLAR_RPC_URL: string = TESTNET_DEFAULTS.rpcUrl;

  @Matches(HTTP_URL_PATTERN, {
    message: 'HORIZON_URL must be a valid http:// or https:// URL',
  })
  HORIZON_URL: string = TESTNET_DEFAULTS.horizonUrl;

  @IsIn(['testnet', 'mainnet'])
  STELLAR_NETWORK: StellarNetwork = 'testnet';

  @IsOptional()
  @IsString()
  POOL_CONTRACT_ID?: string;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface StellarConfig {
  rpcUrl: string;
  horizonUrl: string;
  network: StellarNetwork;
  networkPassphrase: string;
  poolContractId: string;
}

export const STELLAR_CONFIG_KEY = 'stellar';

/**
 * Validates and exposes Stellar-related env vars via `@nestjs/config`.
 *
 * Usage:
 * ```ts
 * const cfg = this.config.get<StellarConfig>(STELLAR_CONFIG_KEY)!;
 * ```
 */
export const stellarConfig = registerAs(STELLAR_CONFIG_KEY, (): StellarConfig => {
  const rawNetwork = process.env.STELLAR_NETWORK ?? 'testnet';

  // Fail-closed on unknown network before anything else runs.
  if (rawNetwork !== 'testnet' && rawNetwork !== 'mainnet') {
    throw new StellarConfigError(
      StellarConfigErrorCode.UNKNOWN_NETWORK,
      `STELLAR_NETWORK must be "testnet" or "mainnet", received "${rawNetwork}"`,
    );
  }

  const env = plainToInstance(StellarEnvVars, {
    STELLAR_RPC_URL: process.env.STELLAR_RPC_URL ?? TESTNET_DEFAULTS.rpcUrl,
    HORIZON_URL: process.env.HORIZON_URL ?? TESTNET_DEFAULTS.horizonUrl,
    STELLAR_NETWORK: rawNetwork,
    POOL_CONTRACT_ID: process.env.POOL_CONTRACT_ID,
  });

  const errors = validateSync(env, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((e) => `  ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new StellarConfigError(
      StellarConfigErrorCode.INVALID_CONFIG,
      `Stellar configuration is invalid:\n${details}`,
    );
  }

  const networkPassphrase =
    env.STELLAR_NETWORK === 'testnet'
      ? TESTNET_DEPLOYMENT.networkPassphrase
      : 'Public Global Stellar Network ; September 2015';

  // Reject a mainnet passphrase supplied while the network is testnet.
  const suppliedPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
  if (
    env.STELLAR_NETWORK === 'testnet' &&
    suppliedPassphrase &&
    suppliedPassphrase !== TESTNET_DEPLOYMENT.networkPassphrase
  ) {
    throw new StellarConfigError(
      StellarConfigErrorCode.MAINNET_PASSPHRASE_ON_TESTNET,
      'STELLAR_NETWORK_PASSPHRASE does not match the testnet passphrase documented in TESTNET.md',
    );
  }

  const poolContractId = env.POOL_CONTRACT_ID ?? '';

  // On testnet the pool contract ID is required and must be a valid StrKey.
  if (env.STELLAR_NETWORK === 'testnet') {
    if (!poolContractId) {
      throw new StellarConfigError(
        StellarConfigErrorCode.MISSING_CONTRACT_ID,
        'POOL_CONTRACT_ID is required on testnet (see packages/contract/deployments/TESTNET.md)',
      );
    }
    if (!CONTRACT_ID_PATTERN.test(poolContractId)) {
      throw new StellarConfigError(
        StellarConfigErrorCode.ADDRESS_DRIFT,
        'POOL_CONTRACT_ID is not a valid Stellar contract address (expected C... StrKey)',
      );
    }
  }

  return {
    rpcUrl: env.STELLAR_RPC_URL,
    horizonUrl: env.HORIZON_URL,
    network: env.STELLAR_NETWORK,
    networkPassphrase,
    poolContractId,
  };
});
