import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

const DEFAULT_PASSWORD = 'Rascalismydog@1';

export async function POST(request: NextRequest) {
  try {
    let { password } = await request.json();

    // Try default password if no password provided
    if (!password) {
      password = DEFAULT_PASSWORD;
      console.log('[API] No password provided, trying default password...');
    }

    const manager = new WalletManager();

    if (!manager.walletExists()) {
      return NextResponse.json(
        { error: 'No wallet found. Please create a new wallet first.' },
        { status: 404 }
      );
    }

    // Try to load with provided password (or default)
    let addresses;
    try {
      addresses = await manager.loadWallet(password);
    } catch (error: any) {
      // If default password was used and failed, try user-provided password
      if (password === DEFAULT_PASSWORD && error.message.includes('Failed to decrypt')) {
        return NextResponse.json(
          { error: 'Incorrect password. Please provide your wallet password.' },
          { status: 401 }
        );
      }
      throw error;
    }

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
