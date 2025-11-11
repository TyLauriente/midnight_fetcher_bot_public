# Midnight API Query - The Optimal Method

## Key Insight: Query the Midnight API Directly!

**Registration is stored on the Midnight mining API**, not on the Cardano blockchain. Therefore, we should query the Midnight API directly to find registered addresses!

## How Registration Works

1. **Registration**: `POST /register/{address}/{signature}/{pubKey}`
   - Stores address in Midnight API database
   - Not a Cardano blockchain transaction
   - Stored on Midnight API/blockchain (separate from Cardano)

2. **Mining**: `POST /solution/{address}/{challenge_id}/{nonce}`
   - Submits solutions to Midnight API
   - Not a Cardano blockchain transaction
   - Stored on Midnight API

3. **Rewards**: NIGHT tokens may be stored on Midnight blockchain
   - Redemption might create Cardano transactions later
   - But mining activity is on Midnight, not Cardano

## Querying the Midnight API

### Available Endpoints (Known)
- `GET /challenge` - Get current challenge
- `GET /TandC` - Get terms and conditions
- `POST /register/{address}/{signature}/{pubKey}` - Register address
- `POST /solution/{address}/{challenge_id}/{nonce}` - Submit solution

### Potential Endpoints (To Discover)
The Midnight API might expose endpoints to query registered addresses:
- `GET /address/{address}` - Get address info
- `GET /address/{address}/status` - Get registration status
- `GET /address/{address}/submissions` - Get submissions for address
- `GET /addresses` - List all registered addresses (if authenticated)
- `GET /wallet/{identifier}/addresses` - Get addresses for a wallet

### Implementation

The `MidnightApiQuery` class tries multiple endpoint patterns:
1. Tries common endpoint patterns
2. Checks if address has submissions (if address has submissions, it's registered)
3. Falls back to individual address checks if batch endpoints don't exist

## Usage

```typescript
import { MidnightApiQuery } from '@/lib/wallet/midnight-api-query';

// Query Midnight API for registered addresses
const addresses = await MidnightApiQuery.queryRegisteredAddresses(
  seedPhrase,
  50000, // max addresses to check
  10,    // batch size
  (current, total, registered) => {
    console.log(`Checked ${current}/${total}, found ${registered} registered`);
  }
);

console.log(`Found ${addresses.length} registered addresses`);
```

## Advantages

- ✅ **Queries the source of truth** (Midnight API database)
- ✅ **Faster than checking addresses one by one** (if batch endpoints exist)
- ✅ **More accurate** (directly from the API that stores registration)
- ✅ **No Cardano blockchain dependency** (queries Midnight API directly)

## Limitations

- ⚠️ **Depends on API endpoints** (may not expose query endpoints)
- ⚠️ **May require authentication** (some endpoints might be protected)
- ⚠️ **Rate limiting** (API might limit query frequency)

## Discovery Mode

To discover available endpoints:

```typescript
import { MidnightApiQuery } from '@/lib/wallet/midnight-api-query';

// Discover available endpoints
const endpoints = await MidnightApiQuery.discoverEndpoints();
console.log('Discovered endpoints:', endpoints);
```

This will try common endpoint patterns and report which ones exist.

## Fallback Strategy

If Midnight API doesn't expose query endpoints:
1. Generate addresses from seed phrase
2. Check each address individually with Midnight API
3. Cache results for future use

## Best Practice

**Use Midnight API query as the primary method:**
1. Try to query Midnight API directly (if endpoints exist)
2. Fall back to address generation + individual checks
3. Use receipts file if available (fastest, most accurate)

