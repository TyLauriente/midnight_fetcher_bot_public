# Midnight API Deprecation Notes

The hosted Midnight scavenger API is being shut down. The miner now avoids those HTTP endpoints entirely and relies on the same on-chain transaction flow that the website uses (via `cardano-cli` or similar tooling). Use this document to configure replacements and to track legacy code that previously depended on the API.

## New command-based transport

By default the miner now mirrors the public website so **no custom scripts are required**. It will pull challenge/T&C/work rate
payloads straight from the site and cache them under `storage/midnight-website-cache`, and it will locally log submissions and
registrations if no CLI is available.

If you still want to wire custom scripts, configure the following environment variables (or constructor options on
`ChainTransport`) to point at wrappers around your `cardano-cli`/transaction builder:

- `MIDNIGHT_CHALLENGE_COMMAND`: emits the current challenge JSON (`ChallengeResponse` shape)
- `MIDNIGHT_SUBMIT_COMMAND`: builds & submits a solution transaction. Receives `address challengeId nonce [preimage]` args.
- `MIDNIGHT_TANDC_COMMAND`: emits the T&C message as JSON (`{ "message": "..." }`)
- `MIDNIGHT_REGISTER_COMMAND`: registers an address with args `address signature publicKeyHex`
- `WORK_TO_STAR_RATE_COMMAND`: emits `work_to_star_rate` JSON for reward calculations

Optional: set `MIDNIGHT_FALLBACK_DIR` to a directory containing `challenge.json`, `tandc.txt`, and `work_to_star_rate.json` if you want a custom cache location.

### Operator checklist

- Make sure the above commands exist and emit the same payloads the website expects (challenge JSON, work/star rate array, etc.) **if** you override the defaults.
- Install and expose whatever CLI stack you rely on (e.g., `cardano-cli`) so the scripts can build and submit transactions.
- Provide fallback files if you need to smoke-test without a live chain.
- Remove any `apiBase` settings from your configs; the transport ignores the retired HTTP endpoints.

## Replaced API calls

- Mining orchestration and solution submission no longer call `https://scavenger.prod.gd.midnighttge.io` and instead go through the CLI-backed `ChainTransport`.
- Mining stats now read work/star rates through `ChainTransport.fetchWorkRates()` instead of the HTTP endpoint.
- Wallet registration helpers that previously queried the API (`BlockchainQuery`, `StakeKeyQuery`) now log warnings and skip API probing because those endpoints are offline.

## Legacy helpers that still mention the API

- `lib/wallet/midnight-api-query.ts`, `lib/wallet/signature-verification-query.ts`, and documentation files reference the legacy API patterns. They are left intact for historical context but should be replaced with CLI-backed equivalents if that functionality is required post-shutdown.

## Next steps

- Provide the actual command implementations that mirror the website’s transaction flow.
- Replace the remaining reference docs with instructions for the CLI-based flow once the scripts are finalized.
