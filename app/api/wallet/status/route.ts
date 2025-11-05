import { NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

export async function GET() {
  try {
    const manager = new WalletManager();

    return NextResponse.json({
      exists: manager.walletExists(),
    });
  } catch (error: any) {
    console.error('[API] Wallet status error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to check wallet status' },
      { status: 500 }
    );
  }
}
