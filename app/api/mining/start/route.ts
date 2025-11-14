import { NextRequest, NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json();

    if (!password) {
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    // CRITICAL: Never accept addressOffset in start endpoint - always read from config
    // This ensures addressOffset is only saved when user explicitly changes it via update-config endpoint
    // The start() method will read addressOffset from config automatically when undefined is passed
    console.log(`[API] Start button clicked - reinitializing orchestrator (addressOffset will be read from config)...`);
    await miningOrchestrator.reinitialize(password, undefined);

    // Get current config to return the addressOffset that was actually used
    const config = miningOrchestrator.getCurrentConfiguration();

    return NextResponse.json({
      success: true,
      message: 'Mining started',
      addressOffset: config.addressOffset,
      stats: miningOrchestrator.getStats(),
    });
  } catch (error: any) {
    console.error('[API] Mining start error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to start mining' },
      { status: 500 }
    );
  }
}
