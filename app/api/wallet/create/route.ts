import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

export async function POST(request: NextRequest) {
  try {
    const { password, count } = await request.json();

    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }

    const walletCount = count || 40;

    if (walletCount < 1 || walletCount > 1000) {
      return NextResponse.json(
        { error: 'Wallet count must be between 1 and 1000' },
        { status: 400 }
      );
    }

    const manager = new WalletManager();

    // Check if wallet already exists
    if (manager.walletExists()) {
      return NextResponse.json(
        { error: 'Wallet already exists. Use /api/wallet/load to load it.' },
        { status: 400 }
      );
    }

    const walletInfo = await manager.generateWallet(password, walletCount);

    return NextResponse.json({
      success: true,
      seedPhrase: walletInfo.seedPhrase,
      addressCount: walletInfo.addresses.length,
      primaryAddress: walletInfo.addresses[0]?.bech32,
    });
  } catch (error: any) {
    console.error('[API] Wallet creation error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create wallet' },
      { status: 500 }
    );
  }
}
