import { NextRequest, NextResponse } from 'next/server';
import { WalletManager } from '@/lib/wallet/manager';
import fs from 'fs';
import path from 'path';

export async function POST(request: NextRequest) {
  try {
    const { password, count } = await request.json();

    if (!password || password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }
    const newCount = Number(count);
    if (!newCount || newCount < 1 || newCount > 50000) {
      return NextResponse.json(
        { error: 'Address count must be between 1 and 50000' },
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
    // Load wallet and check registered
    let addresses;
    try {
      addresses = await manager.loadWallet(password);
    } catch (e) {
      return NextResponse.json(
        { error: 'Incorrect password or failed to decrypt wallet.' },
        { status: 401 }
      );
    }
    // Check registered count
    const registeredCount = addresses.filter(a => a.registered).length;
    if (newCount < registeredCount) {
      return NextResponse.json(
        { error: `Cannot set address count below number of registered addresses (${registeredCount})` },
        { status: 400 }
      );
    }
    if (addresses.length === newCount) {
      return NextResponse.json({ success: true, addressCount: addresses.length, primaryAddress: addresses[0]?.bech32 });
    }
    if (newCount > addresses.length) {
      // Expand: derive more addresses and save
      // This will preserve already registered addresses
      await manager.expandAddresses(password, newCount);
      const updated = await manager.loadWallet(password);
      return NextResponse.json({ success: true, addressCount: updated.length, primaryAddress: updated[0]?.bech32 });
    }
    // If newCount < addresses.length (but >= registeredCount), allow truncation
    await manager.truncateAddresses(newCount);
    const updated = await manager.loadWallet(password);
    return NextResponse.json({ success: true, addressCount: updated.length, primaryAddress: updated[0]?.bech32 });
  } catch (error: any) {
    console.error('[API] Wallet expand error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to expand wallet addresses' },
      { status: 500 }
    );
  }
}
