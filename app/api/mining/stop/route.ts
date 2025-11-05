import { NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';

export async function POST() {
  try {
    miningOrchestrator.stop();

    return NextResponse.json({
      success: true,
      message: 'Mining stopped',
    });
  } catch (error: any) {
    console.error('[API] Mining stop error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to stop mining' },
      { status: 500 }
    );
  }
}
