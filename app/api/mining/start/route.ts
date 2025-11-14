import { NextRequest, NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';

const DEFAULT_PASSWORD = 'Rascalismydog@1';

export async function POST(request: NextRequest) {
  try {
    let { password } = await request.json();

    // Try default password if no password provided
    if (!password) {
      password = DEFAULT_PASSWORD;
      console.log('[API] No password provided, trying default password...');
    }

    // Use reinitialize to ensure fresh state when start button is clicked
    console.log('[API] Start button clicked - reinitializing orchestrator...');
    await miningOrchestrator.reinitialize(password);

    return NextResponse.json({
      success: true,
      message: 'Mining started',
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
