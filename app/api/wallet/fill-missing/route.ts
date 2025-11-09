import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';

export async function POST(request: NextRequest) {
  try {
    const { password, targetCount } = await request.json();
    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }
    const count = Number(targetCount);
    if (!count || count < 1 || count > 1000) {
      return NextResponse.json(
        { error: 'targetCount must be between 1 and 1000' },
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
    let updatedCount;
    try {
      updatedCount = await manager.fillMissingAddresses(password, count);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Failed to generate missing addresses' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true, addressCount: updatedCount });
  } catch (error: any) {
    console.error('[API] fill-missing error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fill missing addresses' },
      { status: 500 }
    );
  }
}
