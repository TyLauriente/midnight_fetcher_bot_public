# Signature Verification Method - The Optimal Approach

## Key Insight: Use Registration Signatures to Detect Registered Addresses

**You're absolutely right!** Registration requires signing the T&C message with the Cardano private key. We can use this to verify which addresses are registered!

## How Registration Works

1. **Get T&C Message**: `GET /TandC` → Returns a message that must be signed
2. **Sign Message**: Sign the T&C message with the Cardano private key for that address
3. **Register**: `POST /register/{address}/{signature}/{pubKey}` → Sends signature to Midnight API
4. **Verification**: Midnight API verifies the signature proves ownership of the address

## The Signature Verification Method

### How It Works:

1. **Get T&C message once** (same for all addresses)
2. **For each address from seed phrase:**
   - Sign the T&C message with that address's private key
   - Attempt to register with that signature
   - If "already registered" error → Address is registered! ✅
   - If registration succeeds → Address was not registered (but we just registered it)

### Advantages:

- ✅ **Uses the actual registration process** - most reliable method
- ✅ **Cryptographic proof** - signature proves ownership
- ✅ **No guesswork** - directly checks registration status
- ✅ **Works for all addresses** - doesn't depend on blockchain activity

### Limitations:

- ⚠️ **May register new addresses** - if address wasn't registered, we'll register it
- ⚠️ **Rate limiting** - registration endpoint has rate limits (1.5s per address)
- ⚠️ **Slower** - must attempt registration for each address

## Implementation

```typescript
import { SignatureVerificationQuery } from '@/lib/wallet/signature-verification-query';

// Verify registered addresses using signature method
const addresses = await SignatureVerificationQuery.verifyRegisteredAddresses(
  seedPhrase,
  50000,
  5, // batch size (lower to avoid rate limits)
  (current, total, registered) => {
    console.log(`Checked ${current}/${total}, found ${registered} registered`);
  },
  false // Don't actually register new addresses (just detect)
);
```

## Why This Works

**The signature is the cryptographic proof:**
- Each address has a unique private key (derived from seed phrase)
- Signing the T&C message proves ownership of that address
- The signature is sent to the Midnight API during registration
- The Midnight API stores this proof in its database

**When we attempt registration:**
- If address is already registered → API returns "already registered" error
- If address is not registered → API accepts registration (returns 200/201)
- This tells us definitively which addresses are registered!

## Can We Query Cardano Blockchain for Signatures?

**No, because:**
- The signature is **only sent to the Midnight API**
- It is **NOT stored on the Cardano blockchain**
- It is **NOT a Cardano transaction**
- It is **NOT a UTXO**

**The signature is:**
- Stored in the **Midnight API database**
- Used to verify ownership to the Midnight API
- Not recorded on the Cardano blockchain

## Why This is Better Than Other Methods

| Method | Reliability | Speed | Works Without Files |
|--------|------------|-------|---------------------|
| **Signature Verification** | ✅✅✅ Highest | ⚠️ Slow (rate limited) | ✅ Yes |
| Receipts File | ✅✅✅ Highest | ✅✅✅ Fastest | ❌ No |
| Address Generation + Check | ✅✅ Good | ⚠️ Slow | ✅ Yes |
| Stake Key Query | ⚠️ Limited | ✅✅ Fast | ✅ Yes |

## Best Practice

**Use signature verification as the primary method:**
1. Generate addresses from seed phrase
2. For each address, sign T&C message and attempt registration
3. Detect "already registered" errors to find registered addresses
4. Optionally: Don't actually register new addresses (just detect)

**Note:** If you want to avoid registering new addresses, you could:
- Check if address has submissions first (if it has submissions, it's registered)
- Only attempt registration if address has no submissions
- Or accept that we'll register addresses (which might be desired anyway)

## Summary

**Yes, we can use signature verification!** This is the most reliable method because:
- Uses the actual registration process
- Cryptographic proof of ownership
- Directly queries the Midnight API (source of truth)
- Works for all addresses (no blockchain dependency)

**The signature is not on the Cardano blockchain**, but we can still use it to verify registration by attempting registration and detecting "already registered" errors!

