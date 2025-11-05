import { NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';

export async function GET() {
  try {
    const stats = miningOrchestrator.getStats();

    return NextResponse.json({
      success: true,
      stats,
    });
  } catch (error: any) {
    console.error('[API] Mining status error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to get mining status' },
      { status: 500 }
    );
  }
}
