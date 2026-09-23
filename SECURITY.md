# Security Policy

## Scope

This policy covers the Swyft monorepo, including:

- Soroban smart contracts (`packages/contract/`)
- NestJS backend API (`apps/api/`)
- TypeScript SDK (`packages/sdk/`)
- Next.js frontend (`apps/web/`)

> **Important:** Swyft contracts are **unaudited**. Do not deploy to mainnet or use with real funds until a security audit has been completed and published.

---

## Supported Versions

| Component | Supported |
|---|---|
| `main` branch | ✅ Yes |
| Tagged releases | ✅ Yes |
| Other branches | ❌ No |

---

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.** Public disclosure before a fix is available puts users at risk.

### How to report

Send a report by email to the maintainer via GitHub. You can find the contact by navigating to the [repository owner's profile](https://github.com/Valreb001) and using the email listed there, or by opening a **private** [GitHub Security Advisory](https://github.com/Valreb001/Swyft/security/advisories/new).

### What to include

A useful report includes:

1. **Description** — what is vulnerable and what the potential impact is
2. **Reproduction steps** — a minimal example that demonstrates the issue
3. **Affected component** — which package, contract, or endpoint is affected
4. **Suggested fix** (optional) — if you have one

### What to expect

| Step | Timeline |
|---|---|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix or mitigation | Depends on severity — critical issues are prioritised immediately |
| Public disclosure | After a fix is merged and released |

---

## Severity Classification

We follow the [CVSS v3.1](https://www.first.org/cvss/v3.1/specification-document) scoring framework:

| Severity | CVSS Score | Examples |
|---|---|---|
| Critical | 9.0–10.0 | Fund drainage, permanent contract lock |
| High | 7.0–8.9 | Privilege escalation, fee manipulation |
| Medium | 4.0–6.9 | Denial of service, info disclosure |
| Low | 0.1–3.9 | Minor logic errors, non-exploitable edge cases |

---

## Smart Contract Specific Guidance

Soroban contracts present unique risks. When reporting contract vulnerabilities, please consider:

- **Reentrancy** — cross-contract call ordering
- **Arithmetic overflow/underflow** — fixed-point math edge cases
- **Access control** — admin function exposure
- **Oracle manipulation** — TWAP price manipulation vectors
- **Tick arithmetic** — off-by-one errors in concentrated liquidity math
- **Storage exhaustion** — unbounded storage writes

---

## SDK Security Model (`@swyft/sdk`)

The SDK exposes high-level swap and liquidity APIs. These are **client-side helpers only** — they never hold keys, sign transactions, or act as a source of truth.

### Trust boundaries

- **Server/contract is the source of truth** for balances, swap execution, pool state, and admin actions. SDK results (quotes, pool queries) are advisory and MUST be re-validated on-chain.
- **No secrets in the SDK.** The SDK never accepts, stores, or logs private keys, seed phrases, or signing material. Signing is delegated to the caller's wallet (e.g. Freighter).
- **Deny-by-default authz.** Privileged surfaces (admin, treasury, config) are not exposed through the SDK's public entrypoints. Any privileged call requires an explicit, caller-supplied authorization context; absent or invalid context fails closed.

### Network passphrase guards

Every SDK entrypoint that touches liquidity, trading, or settlement paths is gated by a **network passphrase guard** that runs before any operation executes. The guard is fail-closed: if it cannot positively confirm the configured network, the operation is rejected.

- **Expected network is explicit.** The SDK is constructed with an expected network (testnet or mainnet) and the corresponding Stellar network passphrase. There is no implicit default and no silent fallback.
- **Guard runs first.** The guard validates the configured passphrase against the expected network before any quote, execute, add/remove liquidity, or settlement call proceeds. Untrusted callers cannot bypass it by supplying their own passphrase or network.
- **Fail-closed on mismatch.** A missing, malformed, or mismatched passphrase (e.g. testnet passphrase against a mainnet expectation, or vice versa) causes the operation to be rejected with a stable, documented error code. The SDK never proceeds on an unverified network.
- **Stable error codes.** Guard failures surface a stable, machine-readable error code plus a correlation id, consistent with the SDK's error model. Messages MUST NOT leak secrets or internal topology.
- **No address drift.** The guard prevents testnet vs mainnet address drift: the SDK never silently falls back to a different network's addresses or passphrase.

### Swap & liquidity entrypoints

- **Quote** (`quote`) is read-only and side-effect free. It MUST NOT mutate state or trigger writes.
- **Execute** (`execute`) and liquidity mutations (`addLiquidity` / `removeLiquidity`) are money-path operations. They:
  - require an explicit authorization context and fail closed when it is missing, expired, or has the wrong role;
  - carry a caller-supplied **idempotency key** so concurrent or replayed requests cannot double-execute;
  - fail closed on dependency outages (RPC/DB/Redis) — no partial writes, no silent retries that could duplicate a swap.
- **Stable error codes.** All SDK errors surface a stable, machine-readable code plus a correlation id for support and audit trails. Error messages MUST NOT leak secrets or internal topology.

### Observability

- Metrics and logs on money paths (quote, execute, add/remove liquidity) are ops-safe: they record counts, latency, and stable error codes — never keys, signatures, or raw payloads containing secrets.
- Correlation ids are propagated end-to-end so a client request can be traced without exposing sensitive data.

### Mainnet safety

- Money-path and mainnet-affecting SDK behavior is gated behind a feature flag / kill-switch. Rollback is documented in the PR that introduces the change.
- Testnet vs mainnet address drift is handled explicitly; the SDK never silently falls back to a different network's addresses.

---

## Disclosure Policy

Swyft follows **coordinated disclosure**:

1. Researcher reports privately.
2. Maintainer confirms and assesses the issue.
3. Fix is developed and tested.
4. Fix is merged and a release is tagged.
5. Public advisory is published with credit to the reporter (unless they prefer to remain anonymous).

We will not take legal action against security researchers who follow this policy and act in good faith.

---

## Bug Bounty

There is no formal bug bounty programme at this time. We will publicly acknowledge researchers who responsibly disclose valid vulnerabilities.
