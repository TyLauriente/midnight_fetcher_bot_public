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

    await miningOrchestrator.start(password);

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
