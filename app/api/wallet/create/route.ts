import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

export async function POST(request: NextRequest) {
  try {
    const { password, count, mnemonic } = await request.json();

    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }
    const walletCount = count || 40;
    if (walletCount < 1 || walletCount > 1000) {
      return NextResponse.json(
        { error: 'Wallet count must be between 1 and 500' },
        { status: 400 }
      );
    }
    if (mnemonic) {
      // Validate mnemonic
      const words = mnemonic.trim().replace(/\s+/g, ' ').split(' ');
      if (words.length !== 24) {
        return NextResponse.json(
          { error: 'Seed phrase must be exactly 24 words' },
          { status: 400 }
        );
      }
    }
    const manager = new WalletManager();
    if (manager.walletExists()) {
      return NextResponse.json(
        { error: 'Wallet already exists. Use /api/wallet/load to load it.' },
        { status: 400 }
      );
    }
    let walletInfo;
    if (mnemonic) {
      walletInfo = await manager.generateWalletFromMnemonic(mnemonic, password, walletCount);
    } else {
      walletInfo = await manager.generateWallet(password, walletCount);
    }
    return NextResponse.json({
      success: true,
      seedPhrase: walletInfo.seedPhrase,
      addressCount: walletInfo.addresses.length,
      primaryAddress: walletInfo.addresses[0]?.bech32,
    });
  } catch (error: any) {
    console.error('[API] Wallet creation/import error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create/import wallet' },
      { status: 500 }
    );
  }
}
