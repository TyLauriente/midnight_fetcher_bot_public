import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json();

    if (!password) {
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    const manager = new WalletManager();

    if (!manager.walletExists()) {
      return NextResponse.json(
        { error: 'No wallet found. Please create a new wallet first.' },
        { status: 404 }
      );
    }

    const addresses = await manager.loadWallet(password);

    return NextResponse.json({
      success: true,
      addressCount: addresses.length,
      primaryAddress: addresses[0]?.bech32,
      registeredCount: addresses.filter(a => a.registered).length,
    });
  } catch (error: any) {
    console.error('[API] Wallet load error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to load wallet' },
      { status: 500 }
    );
  }
}
