import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

const SECURE_DIR = path.join(process.cwd(), 'secure');
const SEED_FILE = path.join(SECURE_DIR, 'wallet-seed.json.enc');
const DERIVED_ADDRESSES_FILE = path.join(SECURE_DIR, 'derived-addresses.json');

export async function POST(request: NextRequest) {
  try {
    const { password, count, mnemonic, replace } = await request.json();

    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }
    const walletCount = count || 40;
    if (walletCount < 1 || walletCount > 50000) {
      return NextResponse.json(
        { error: 'Wallet count must be between 1 and 50000' },
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
      if (replace) {
        try {
          if (fs.existsSync(SEED_FILE)) fs.unlinkSync(SEED_FILE);
          if (fs.existsSync(DERIVED_ADDRESSES_FILE)) fs.unlinkSync(DERIVED_ADDRESSES_FILE);
        } catch (e) {
          return NextResponse.json(
            { error: 'Failed to delete existing wallet files.' },
            { status: 500 }
          );
        }
      } else {
        return NextResponse.json(
          { error: 'Wallet already exists. Use /api/wallet/load to load it.' },
          { status: 400 }
        );
      }
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
