# Stake Key Query Limitations for Mining

## Critical Understanding: Mining Registration is OFF-CHAIN

### How Stake Keys Work in Cardano

**Stake keys reveal addresses that have been USED on the Cardano blockchain:**
- Addresses with transactions (sent/received)
- Addresses with UTXOs (unspent transaction outputs)
- Addresses that have interacted with smart contracts
- **NOT addresses that were only registered for mining**

### Mining Registration is OFF-CHAIN

Based on the code analysis:
```typescript
// Mining registration endpoint
POST /register/{address}/{signature}/{pubKey}
```

This endpoint:
- Stores the address in the **mining API's database**
- Does **NOT** create a Cardano blockchain transaction
- Does **NOT** create a UTXO
- Does **NOT** make the address visible on the blockchain

### When Are Addresses Findable via Stake Key?

An address becomes findable through stake key queries when:

1. ✅ **It has had an on-chain transaction** (sent or received ADA/tokens)
2. ✅ **It has a UTXO** (unspent transaction output)
3. ✅ **It has interacted with a smart contract**
4. ❌ **NOT when it's only registered for mining** (off-chain registration)

### The Problem for Mining

**Mining addresses are registered OFF-CHAIN:**
- Registration: `POST /register/{address}/{signature}/{pubKey}` → Stores in mining API database
- Mining: Submits solutions to mining API (also off-chain)
- Rewards: NIGHT tokens may be stored off-chain until redemption

**Result:** Stake key queries will **NOT** find addresses that were:
- Only registered for mining
- Never had on-chain transactions
- Only used for mining (no blockchain activity)

### What Stake Key Query CAN Find

Stake key queries WILL find addresses that:
- Have received rewards (if rewards create on-chain transactions)
- Have been used to redeem tokens (creates on-chain transaction)
- Have had any on-chain activity

### The Solution for Mining

For mining addresses, you have **three options**:

#### Option 1: Generate Addresses from Seed (Recommended for Mining)
```typescript
// Generate all addresses from seed phrase (deterministic)
const walletManager = new WalletManager();
const walletInfo = await walletManager.generateWalletFromMnemonic(seedPhrase, 'temp', 50000);
const allAddresses = walletInfo.addresses;

// Then check which are registered with mining API
for (const addr of allAddresses) {
  const isRegistered = await checkMiningApiRegistration(addr.bech32);
  if (isRegistered) {
    registeredAddresses.push(addr);
  }
}
```

**Advantages:**
- ✅ Finds ALL addresses from seed phrase (up to max count)
- ✅ Works for off-chain mining registration
- ✅ Deterministic (same seed = same addresses)

**Disadvantages:**
- ⚠️ Slower (must generate and check each address)
- ⚠️ Limited by max address count (50,000)

#### Option 2: Use Receipts File (Fastest, but requires files)
```typescript
// Read receipts file to see which addresses submitted solutions
const receipts = receiptsLogger.readReceipts();
const addressesWithSolutions = receipts.map(r => r.address);
```

**Advantages:**
- ✅ Very fast (reads local file)
- ✅ Accurate (shows which addresses actually mined)

**Disadvantages:**
- ❌ Requires receipts file from mining computer(s)
- ❌ May miss addresses that were registered but never mined

#### Option 3: Stake Key Query (Only for On-Chain Activity)
```typescript
// Query blockchain for addresses with on-chain activity
const stakeKey = await getStakeKeyFromSeed(seedPhrase);
const addresses = await queryBlockchainByStakeKey(stakeKey);
```

**Advantages:**
- ✅ Fast (queries blockchain)
- ✅ Finds addresses with on-chain activity

**Disadvantages:**
- ❌ **Won't find mining-only addresses** (no on-chain activity)
- ❌ Only finds addresses that have had transactions

### Recommended Approach for Mining

**For mining addresses, use a HYBRID approach:**

1. **Primary:** Generate addresses from seed phrase and check mining API
2. **Secondary:** Use stake key query to find addresses with on-chain activity (rewards, redemptions)
3. **Tertiary:** Use receipts file if available (most accurate)

### Updated Implementation

The `BlockchainQuery` class now uses this hybrid approach:

```typescript
// 1. Try stake key method (finds on-chain addresses)
const blockchainAddresses = await StakeKeyQuery.getAddressesByStakeKey(stakeKey);

// 2. Generate addresses from seed (finds all possible addresses)
const seedAddresses = await generateAddressesFromSeed(seedPhrase, 50000);

// 3. Combine and check mining API
const allAddresses = new Set([...blockchainAddresses, ...seedAddresses]);
const registeredAddresses = await checkMiningApiRegistration(Array.from(allAddresses));
```

### Summary

| Method | Finds Mining Addresses? | Finds On-Chain Addresses? | Speed |
|--------|------------------------|---------------------------|-------|
| **Generate from Seed** | ✅ Yes | ✅ Yes | Slow |
| **Receipts File** | ✅ Yes (mined addresses) | ❌ No | Fast |
| **Stake Key Query** | ❌ No (off-chain) | ✅ Yes (on-chain only) | Fast |
| **Hybrid Approach** | ✅ Yes | ✅ Yes | Medium |

**For mining: Use address generation from seed + mining API check**
**For on-chain activity: Use stake key query**
**For best results: Use hybrid approach**

