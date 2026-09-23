# Swyft API

The Swyft API is the server-side entrypoint for liquidity, trading, and settlement flows. It talks to Stellar (Horizon + Soroban RPC) and to the Swyft contracts deployed on testnet.

## Environment wiring (testnet)

The API is configured entirely through environment variables. The canonical source of truth for testnet identifiers is [`packages/contract/deployments/TESTNET.md`](../../packages/contract/deployments/TESTNET.md). Copy [`apps/api/.env.example`](./.env.example) to `.env` and fill in the values documented there.

Required variables:

| Variable | Purpose |
| --- | --- |
| `STELLAR_NETWORK` | Network name (`testnet`). Mainnet is rejected by config validation. |
| `STELLAR_NETWORK_PASSPHRASE` | Must match the passphrase for `STELLAR_NETWORK`. |
| `STELLAR_HORIZON_URL` | Horizon endpoint for the selected network. |
| `STELLAR_SOROBAN_RPC_URL` | Soroban RPC endpoint for the selected network. |
| `SWYFT_CONTRACT_ID` | Deployed Swyft contract id (testnet). |
| `SWYFT_ASSET_ISSUER` | Public issuer account for the Swyft asset (testnet). |

### Fail-closed behavior

`apps/api/src/config/stellar.config.ts` validates the environment at startup and **fails closed**:

- A mainnet passphrase or unknown network is rejected.
- Missing contract ids or asset issuers are rejected.
- A passphrase that does not match the declared network is rejected (address/network drift).

Validation errors use stable error codes so operators and tests can assert on them. The API will not start with an invalid Stellar configuration.

### Secrets

Only public testnet identifiers and URLs belong in `.env.example`. Never commit secret keys, seed phrases, or private credentials. Do not log secret values; log only the stable error codes and non-sensitive identifiers.

## Development

See the repository root README for workspace setup. Run the API from `apps/api` after populating `.env` from `.env.example`.

## Tests

Config validation is covered by `apps/api/src/config/stellar.config.spec.ts`, including valid testnet configuration and negative cases (mainnet passphrase, missing variables, address drift).
