import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';
import { donationLogger } from '@/lib/storage/donation-logger';

/**
 * POST /api/wallet/donate-to
 * Donate (consolidate) rewards from one address to another
 * 
 * Body: {
 *   password: string,
 *   sourceAddress: string,
 *   sourceAddressIndex?: number,  // Optional, will be derived if not provided
 *   destinationAddress: string
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const { password, sourceAddress, sourceAddressIndex, destinationAddress } = await request.json();

    if (!password || !sourceAddress || !destinationAddress) {
      return NextResponse.json(
        { error: 'Missing required fields: password, sourceAddress, destinationAddress' },
        { status: 400 }
      );
    }

    if (!sourceAddress.startsWith('addr1') || !destinationAddress.startsWith('addr1')) {
      return NextResponse.json(
        { error: 'Invalid address format. Addresses must start with addr1' },
        { status: 400 }
      );
    }

    const walletManager = new WalletManager();

    if (!walletManager.walletExists()) {
      return NextResponse.json(
        { error: 'No wallet found. Please create or import a wallet first.' },
        { status: 404 }
      );
    }

    // Load wallet with password
    try {
      await walletManager.loadWallet(password);
    } catch (err) {
      return NextResponse.json(
        { error: 'Failed to decrypt wallet. Incorrect password?' },
        { status: 401 }
      );
    }

    // Find the source address index if not provided
    let addressIndex = sourceAddressIndex;
    if (addressIndex === undefined) {
      const addresses = walletManager.getDerivedAddresses();
      const found = addresses.find(a => a.bech32 === sourceAddress);
      if (!found) {
        return NextResponse.json(
          { error: `Source address ${sourceAddress} not found in wallet` },
          { status: 404 }
        );
      }
      addressIndex = found.index;
    }

    // Ensure the address is derived (derive on the fly if needed)
    // We need to derive it so it's available for both getPubKeyHex and makeDonationSignature
    try {
      walletManager.getPubKeyHex(addressIndex);
    } catch (err: any) {
      // Address not in derived list, derive it on the fly
      console.log(`[Donate-to] Address ${addressIndex} not found in derived list, deriving on the fly...`);
      try {
        const derived = await walletManager.deriveAddressesByRange(password, addressIndex, addressIndex);
        if (!derived || derived.length === 0) {
          console.error(`[Donate-to] Derivation returned no addresses for index ${addressIndex}`);
          return NextResponse.json(
            { error: `Failed to derive address for index ${addressIndex}: No addresses returned` },
            { status: 500 }
          );
        }
        // Verify the address matches
        const derivedAddr = derived.find(a => a.index === addressIndex);
        if (!derivedAddr) {
          console.error(`[Donate-to] Derived addresses: ${derived.map(a => a.index).join(', ')}, but ${addressIndex} not found`);
          return NextResponse.json(
            { error: `Failed to derive address for index ${addressIndex}: Address not in derived list` },
            { status: 500 }
          );
        }
        if (derivedAddr.bech32 !== sourceAddress) {
          console.error(`[Donate-to] Address mismatch: expected ${sourceAddress}, got ${derivedAddr.bech32}`);
          return NextResponse.json(
            { error: `Address mismatch: expected ${sourceAddress}, got ${derivedAddr.bech32}` },
            { status: 500 }
          );
        }
        console.log(`[Donate-to] Successfully derived address ${addressIndex}, now available for signing`);
      } catch (deriveErr: any) {
        console.error(`[Donate-to] Derivation error for index ${addressIndex}:`, deriveErr);
        return NextResponse.json(
          { error: `Failed to derive address for index ${addressIndex}: ${deriveErr.message}` },
          { status: 500 }
        );
      }
    }

    // Get public key for the address (should now be available)
    const pubkey = walletManager.getPubKeyHex(addressIndex);

    // Sign the donation message
    const signature = await walletManager.makeDonationSignature(
      addressIndex,
      sourceAddress,
      destinationAddress
    );

    // Make the donation API call
    // According to Midnight documentation: POST /donate_to/{destination}/{source}/{signature}
    // The -d flag suggests we may also need to send pubkey in the request body
    const apiBase = 'https://scavenger.prod.gd.midnighttge.io';
    // Note: destination comes first, then source (matching consolidate route format)
    const donateUrl = `${apiBase}/donate_to/${destinationAddress}/${sourceAddress}/${signature}`;

    let success = false;
    let responseData: any = null;
    let error: string | undefined = undefined;
    let httpStatus: number | undefined = undefined;

    try {
      // Send pubkey in request body (using -d flag equivalent)
      // The URL contains destination, source, and signature; body contains pubkey
      const requestBody = {
        pubkey: pubkey,
      };

      const response = await fetch(donateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      httpStatus = response.status;
      const responseText = await response.text();

      if (response.ok) {
        try {
          responseData = JSON.parse(responseText);
        } catch (e) {
          responseData = responseText;
        }
        success = true;
      } else {
        try {
          responseData = JSON.parse(responseText);
          error = responseData.message || responseData.error || `HTTP ${response.status}`;
        } catch (e) {
          error = responseText || `HTTP ${response.status}`;
        }
      }
    } catch (err: any) {
      error = err.message || 'Network error';
      httpStatus = 0;
    }

    // Log the donation attempt
    donationLogger.logDonation({
      timestamp: new Date().toISOString(),
      attemptNumber: 0, // Will be set by logger
      sourceAddress,
      sourceAddressIndex: addressIndex,
      destinationAddress,
      signature,
      pubkey,
      success,
      response: responseData,
      error,
      httpStatus,
    });

    if (success) {
      return NextResponse.json({
        success: true,
        message: 'Donation successful',
        sourceAddress,
        destinationAddress,
        response: responseData,
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: error || 'Donation failed',
          sourceAddress,
          destinationAddress,
          httpStatus,
          response: responseData,
        },
        { status: httpStatus && httpStatus >= 400 ? httpStatus : 500 }
      );
    }
  } catch (error: any) {
    console.error('[API] Donate-to error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to process donation' },
      { status: 500 }
    );
  }
}

