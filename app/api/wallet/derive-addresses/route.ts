import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

export async function POST(request: NextRequest) {
  try {
    const { password, startIndex, endIndex } = await request.json();

    if (!password) {
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    if (typeof startIndex !== 'number' || typeof endIndex !== 'number') {
      return NextResponse.json(
        { error: 'startIndex and endIndex must be numbers' },
        { status: 400 }
      );
    }

    if (startIndex < 0 || endIndex < startIndex) {
      return NextResponse.json(
        { error: 'Invalid index range' },
        { status: 400 }
      );
    }

    if (endIndex - startIndex > 150000) {
      return NextResponse.json(
        { error: 'Index range cannot exceed 150000 addresses' },
        { status: 400 }
      );
    }

    const manager = new WalletManager();
    const addresses = await manager.deriveAddressesByRange(password, startIndex, endIndex);

    return NextResponse.json({
      success: true,
      addresses: addresses.map(addr => ({
        index: addr.index,
        bech32: addr.bech32,
        publicKeyHex: addr.publicKeyHex,
      })),
    });
  } catch (error: any) {
    console.error('[API] Derive addresses error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to derive addresses' },
      { status: 500 }
    );
  }
}

