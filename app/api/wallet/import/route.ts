import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

export async function POST(request: NextRequest) {
  try {
    const { seedPhrase, password, count } = await request.json();

    if (!seedPhrase) {
      return NextResponse.json(
        { error: 'Seed phrase is required' },
        { status: 400 }
      );
    }

    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }

    const walletCount = count || 200;

    if (walletCount < 1 || walletCount > 500) {
      return NextResponse.json(
        { error: 'Wallet count must be between 1 and 500' },
        { status: 400 }
      );
    }

    const manager = new WalletManager();

    // Import wallet (this will replace existing wallet if one exists)
    const walletInfo = await manager.importWallet(seedPhrase, password, walletCount);

    return NextResponse.json({
      success: true,
      addressCount: walletInfo.addresses.length,
      primaryAddress: walletInfo.addresses[0]?.bech32,
      message: manager.walletExists() ? 'Wallet imported and replaced existing wallet' : 'Wallet imported successfully',
    });
  } catch (error: any) {
    console.error('[API] Wallet import error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to import wallet' },
      { status: 500 }
    );
  }
}

