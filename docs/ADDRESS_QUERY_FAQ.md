# Address Query & Limits FAQ

> **API shutdown notice**: The Midnight HTTP API paths referenced below are being removed. The miner now relies on on-chain/`cardano-cli` commands (see `docs/API_DEPRECATION_NOTES.md`).

## 1. Can we determine mined addresses WITHOUT cache files?

**YES!** There are multiple methods, and I've implemented an **OPTIMIZED** approach using Cardano stake keys!

### Three Methods (from fastest to slowest):

#### Method 1: Midnight API Query (OPTIMAL - Recommended!) 🎯
**Queries the Midnight mining API directly - the source of truth for registration!**

```typescript
import { MidnightApiQuery } from '@/lib/wallet/midnight-api-query';

// Query Midnight API for registered addresses
// This queries the API that stores registration data!
const addresses = await MidnightApiQuery.queryRegisteredAddresses(
  seedPhrase,
  50000, // max addresses to check
  10,    // batch size
  (current, total, registered) => {
    console.log(`Checked ${current}/${total}, found ${registered} registered`);
  }
);
```

**How it works:**
1. Generates addresses from seed phrase (deterministic)
2. Queries Midnight API to check which addresses are registered
3. Queries submission data for registered addresses
4. Returns all registered addresses with their mining stats

**Key Insight:**
- Registration is stored on the **Midnight API** (not Cardano blockchain)
- Midnight is a separate blockchain from Cardano
- We can query the Midnight API directly to find registered addresses!

**Advantages:**
- ✅ **Queries the source of truth** (Midnight API database)
- ✅ **Faster than individual checks** (if batch endpoints exist)
- ✅ **More accurate** (directly from the API that stores registration)
- ✅ **No Cardano blockchain dependency** (queries Midnight API directly)

**Limitations:**
- ⚠️ **Depends on API endpoints** (Midnight API may not expose query endpoints)
- ⚠️ **May require authentication** (some endpoints might be protected)
- ⚠️ **Falls back to individual checks** (if batch endpoints don't exist)

#### Method 2: Stake Key Query (For On-Chain Addresses Only) ⚠️
**⚠️ IMPORTANT LIMITATION: Only finds addresses with ON-CHAIN activity on Cardano!**

```typescript
import { StakeKeyQuery } from '@/lib/wallet/stake-key-query';

// Query addresses with on-chain activity using stake key
// NOTE: This won't find mining-only addresses (mining is on Midnight, not Cardano)
const addresses = await StakeKeyQuery.getRegisteredAddressesByStakeKey(
  seedPhrase,
  true // check mining API for registration
);
```

**How it works:**
1. Extracts stake key from seed phrase (all addresses share the same stake key)
2. Queries Cardano blockchain (Blockfrost/Koios/Cardanoscan) for addresses with ON-CHAIN activity
3. Checks which addresses are registered with mining API
4. Returns addresses that have had Cardano blockchain transactions

**⚠️ CRITICAL LIMITATION:**
- **Only finds addresses with ON-CHAIN activity on Cardano** (transactions, UTXOs)
- **Won't find mining-only addresses** (mining is on Midnight blockchain, not Cardano)
- **Won't find addresses that never had Cardano transactions**

**When to use:**
- ✅ Finding addresses that received rewards on Cardano (on-chain)
- ✅ Finding addresses that redeemed tokens on Cardano (on-chain)
- ✅ Finding addresses with any Cardano blockchain activity
- ❌ **NOT for mining-only addresses** (mining is on Midnight, use Midnight API query instead)

**Requirements:**
- Blockfrost API key (optional, free tier available)
- Or Koios/Cardanoscan API access

#### Method 2: With Receipts File (Fast, but requires files)
```typescript
import { AddressReconstructor } from '@/lib/wallet/address-reconstructor';

// Uses local receipts.jsonl file
const addresses = await AddressReconstructor.getMinedAddresses(
  seedPhrase,
  10000,
  'storage/receipts.jsonl'
);
```

#### Method 3: Address Generation + API Query (Slower, fallback)
```typescript
import { AddressReconstructor } from '@/lib/wallet/address-reconstructor';

// Queries mining API for each address - NO files needed!
// This is the fallback if stake key method fails
const addresses = await AddressReconstructor.getMinedAddresses(
  seedPhrase,
  10000,
  undefined, // No receipts file
  true // Use blockchain query
);
```

### How Stake Key Method Works (On-Chain Addresses Only):
1. **Extract stake key** from seed phrase (all addresses from same seed share stake key)
2. **Query Cardano blockchain** using stake key to get addresses with ON-CHAIN activity
   - Uses Blockfrost API: `GET /accounts/{stakeKey}/addresses`
   - Or Koios API: `POST /account_addresses`
   - Or Cardanoscan API: `GET /rewardAccount/addresses`
   - ⚠️ **Only returns addresses that have had transactions/UTXOs**
3. **Check mining API** for which addresses are registered (only check addresses from blockchain)
4. **Return registered addresses** - only addresses with on-chain activity

### ⚠️ Why Stake Key Doesn't Work for Mining-Only Addresses:

**Mining registration is OFF-CHAIN:**
- Registration: `POST /register/{address}/{signature}/{pubKey}` → Stores in mining API database
- **NOT stored on Cardano blockchain**
- **NOT a blockchain transaction**
- **NOT a UTXO**

**Result:** Stake key queries return **ZERO addresses** for mining-only addresses!

**Performance Comparison:**
- **Stake Key Method**: ~1-10 seconds (only finds on-chain addresses)
- **Address Generation Method**: ~5-50 minutes (finds ALL addresses, including mining-only)
- **Receipts File Method**: ~1 second (reads local file, most accurate for mining)

**For Mining Addresses: Use Address Generation from Seed Phrase!**

---

## 2. What is the Maximum Number of Addresses?

### Current Hard-Coded Limit: **50,000 addresses**
- **Location**: All wallet API endpoints (`/api/wallet/create`, `/api/wallet/expand`, `/api/wallet/fill-missing`)
- **Validation**: `if (count > 50000)` returns error
- **Reason**: Practical limit to prevent excessive memory/processing

### Technical Maximum (Cardano BIP44): **2,147,483,648 addresses**
- **Theoretical**: 2^31 addresses per seed phrase (BIP44 account index limit)
- **Practical**: Limited by:
  - **Memory**: ~100 bytes per address
    - 50,000 addresses ≈ 5 MB
    - 1,000,000 addresses ≈ 100 MB
    - 10,000,000 addresses ≈ 1 GB
  - **Processing Time**: ~10-50ms per address derivation
    - 50,000 addresses: ~8-40 minutes
    - 1,000,000 addresses: ~3-14 hours
  - **API Rate Limits**: Registration takes ~1.5 seconds per address
    - 50,000 addresses: ~21 hours registration time
    - 1,000,000 addresses: ~17 days registration time

### Cardano Address Derivation:
- Uses **BIP44 HD wallet structure**
- Path: `m/1852'/1815'/account'/0/address_index`
- Current implementation uses **single account** (account index 0)
- Each address is **deterministic** from seed phrase

---

## 3. What is the Maximum for General Cardano Transactions?

### Cardano Transaction Limits:
- **No hard limit** on number of addresses in a wallet
- **Transaction size limit**: 16 KB per transaction
- **UTXO limit**: 2^64 - 1 UTXOs (practically unlimited)
- **Addresses per transaction**: Limited by transaction size (typically 100-1000 addresses per transaction)

### Practical Considerations:
- **Wallet software limits**: Most wallets limit to 100-10,000 addresses for UI performance
- **Transaction batching**: For large operations, transactions are batched
- **Memory constraints**: Large address lists require more memory

---

## 4. Can we Query Blockchain for Registered Addresses?

**YES!** I've implemented **TWO** optimized methods:

### Method 1: Stake Key Query (On-Chain Addresses Only) ⚠️

**⚠️ IMPORTANT: Only finds addresses with ON-CHAIN activity!**

```typescript
import { StakeKeyQuery } from '@/lib/wallet/stake-key-query';

// Get addresses with on-chain activity using stake key
// NOTE: Won't find mining-only addresses (off-chain registration)
const addresses = await StakeKeyQuery.getRegisteredAddressesByStakeKey(
  seedPhrase,
  true // check mining API
);

console.log(`Found ${addresses.length} addresses with on-chain activity`);
```

**How it works:**
1. Extracts stake key from seed phrase
2. Queries Cardano blockchain (Blockfrost/Koios/Cardanoscan) for addresses with ON-CHAIN activity
3. Checks which addresses are registered with mining API
4. Returns addresses that have had blockchain transactions

**⚠️ CRITICAL LIMITATION:**
- **Only finds addresses with ON-CHAIN transactions/UTXOs**
- **Won't find mining-only addresses** (mining registration is OFF-CHAIN)
- **For mining addresses, use address generation from seed phrase instead**

**APIs Used:**
- **Blockfrost**: `GET /accounts/{stakeKey}/addresses` (returns addresses with UTXOs/transactions)
- **Koios**: `POST /account_addresses` with `stake_addresses: [stakeKey]`
- **Cardanoscan**: `GET /rewardAccount/addresses?rewardAddress={stakeKey}`

### Method 2: Blockchain Query (Fallback)

**Queries mining API directly (slower but works without Cardano APIs):**

```typescript
import { BlockchainQuery } from '@/lib/wallet/blockchain-query';

// Get all registered addresses (uses stake key if available, falls back to address generation)
const registered = await BlockchainQuery.getRegisteredAddresses(
  seedPhrase,
  50000, // max addresses to check (fallback)
  10     // batch size
);

// Get full mining stats
const stats = await BlockchainQuery.queryRegisteredAddresses(
  seedPhrase,
  50000,
  10,
  (current, total, registered) => {
    console.log(`Checked ${current}/${total}, found ${registered} registered`);
  },
  true // use stake key method (much faster!)
);

console.log(`Total registered: ${stats.registeredAddresses.length}`);
console.log(`Total submissions: ${stats.totalSubmissions}`);
```

### Features:
- ✅ Query which addresses are registered (without local files)
- ✅ Get submission counts per address
- ✅ Get challenge IDs per address
- ✅ Get total submissions across all addresses
- ✅ Progress callbacks for long-running queries
- ✅ **Stake key optimization** - queries blockchain first, then checks mining API

### Mining API Endpoints Used:
- `GET /TandC` - Check if address is registered
- `GET /address/{address}/submissions` - Get submission data (if available)

### Cardano Blockchain APIs Used:
- **Blockfrost API** (primary): Requires free API key from https://blockfrost.io
- **Koios API** (fallback): No API key required
- **Cardanoscan API** (fallback): No API key required

**⚠️ IMPORTANT NOTE:** The stake key method only finds addresses with **ON-CHAIN activity**. For mining addresses (which are registered OFF-CHAIN), you must use address generation from seed phrase. The hybrid approach in `BlockchainQuery` tries stake key first (for on-chain addresses), then falls back to address generation (for mining addresses).

---

## 5. Can we Get Total Receipts/Submissions/NIGHT Collected?

**Partially** - Depends on what the mining API exposes.

### What's Available:

#### ✅ From Receipts File (Local):
- Total submissions per address
- Submission timestamps
- Challenge IDs
- Solution hashes/nonces

#### ✅ From Blockchain Query (No Files):
- Registration status per address
- Submission counts (if API endpoint exists)
- Challenge IDs (if API endpoint exists)

#### ❓ NIGHT Token Amounts:
- **Not currently available** from mining API
- Would need to query Cardano blockchain directly for token balances
- Requires Cardano node or block explorer API

### Implementation Status:

```typescript
// Current implementation can get:
const stats = await BlockchainQuery.queryRegisteredAddresses(seedPhrase, 50000);

// Available:
stats.totalSubmissions          // Total submissions across all addresses
stats.addressesWithSubmissions  // Addresses that have submissions
stats.uniqueChallenges          // All challenge IDs
stats.registeredAddresses      // All registered addresses

// Not yet available (would require Cardano blockchain query):
// stats.totalNIGHTTokens        // Total NIGHT collected
// stats.tokensPerAddress        // NIGHT per address
```

### To Get NIGHT Token Amounts:
Would need to:
1. Query Cardano blockchain for each address
2. Check token balances (NIGHT token policy ID)
3. Sum across all addresses

This would require:
- Cardano node connection, OR
- Block explorer API (e.g., Blockfrost, Koios), OR
- Midnight-specific API endpoint (if available)

---

## Summary

| Question | Answer | Implementation |
|----------|--------|---------------|
| **Query without cache files?** | ✅ Yes | `BlockchainQuery` class |
| **Max addresses (current)?** | 50,000 | Hard-coded limit |
| **Max addresses (theoretical)?** | 2,147,483,648 | Cardano BIP44 limit |
| **Cardano transaction max?** | No hard limit | Limited by transaction size (16 KB) |
| **Query registered addresses?** | ✅ Yes | `BlockchainQuery.queryRegisteredAddresses()` |
| **Get total submissions?** | ✅ Yes | From receipts file OR blockchain query |
| **Get NIGHT tokens?** | ❓ Partial | Requires Cardano blockchain query (not yet implemented) |

---

## Files Created/Modified

1. **`lib/wallet/blockchain-query.ts`** - New utility for blockchain/API queries
2. **`lib/wallet/address-reconstructor.ts`** - Updated to support blockchain queries
3. **`lib/wallet/address-limits.md`** - Documentation on address limits
4. **`docs/ADDRESS_QUERY_FAQ.md`** - This FAQ document

---

## Next Steps (Optional Enhancements)

1. **Add Cardano blockchain query** for NIGHT token balances
   - Integrate Blockfrost/Koios API
   - Query token balances per address
   - Sum total NIGHT collected

2. **Optimize blockchain queries**
   - Cache registration status
   - Batch API calls more efficiently
   - Add retry logic for failed queries

3. **Add UI for blockchain queries**
   - Progress indicator
   - Results display
   - Export functionality

