# Address Generation Limits

## Current Implementation Limits

### Hard-coded Maximum: 50,000 addresses
- **Location**: `app/api/wallet/create/route.ts`, `app/api/wallet/expand/route.ts`, `app/api/wallet/fill-missing/route.ts`
- **Validation**: `if (count > 50000)` returns error
- **Reason**: Practical limit to prevent excessive memory/processing

### Technical Maximum (Cardano BIP44)
- **Theoretical**: 2^31 = 2,147,483,648 addresses per seed phrase
- **Practical**: Limited by:
  - Memory (each address requires ~100 bytes)
  - Processing time (derivation is sequential)
  - API rate limits (registration/submission)

## Cardano Address Derivation

Cardano uses BIP44 hierarchical deterministic (HD) wallet structure:
- **Path Format**: `m/1852'/1815'/account'/0/address_index`
- **Account Index**: 0 to 2^31 - 1 (2,147,483,647)
- **Address Index**: 0 to 2^31 - 1 per account

### Current Implementation
- Uses **single account** (account index 0)
- Derives addresses using `accountIndex` parameter (0, 1, 2, ...)
- Each address is deterministic from seed phrase

## Practical Considerations

### Memory Usage
- 50,000 addresses ≈ 5 MB (100 bytes per address)
- 1,000,000 addresses ≈ 100 MB
- 10,000,000 addresses ≈ 1 GB

### Processing Time
- Address derivation: ~10-50ms per address
- 50,000 addresses: ~8-40 minutes
- 1,000,000 addresses: ~3-14 hours

### API Rate Limits
- Registration: ~1.5 seconds per address (rate limited)
- 50,000 addresses: ~21 hours of registration time
- 1,000,000 addresses: ~17 days of registration time

## Recommendations

1. **For Mining**: 50,000 addresses is reasonable
   - Allows multi-computer setups (20 computers × 2,500 addresses each)
   - Manageable memory footprint
   - Reasonable registration time

2. **For Maximum Coverage**: Can increase to 100,000-500,000
   - Requires more memory
   - Longer initial setup time
   - Better for large-scale operations

3. **For Theoretical Maximum**: 2^31 addresses
   - Not practical for most use cases
   - Would require distributed processing
   - Memory/processing constraints apply

## Increasing the Limit

To increase beyond 50,000:
1. Update validation in:
   - `app/api/wallet/create/route.ts`
   - `app/api/wallet/expand/route.ts`
   - `app/api/wallet/fill-missing/route.ts`
2. Consider memory/processing implications
3. Update UI to reflect new maximum
4. Test with large address counts

