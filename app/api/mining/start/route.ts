import { NextRequest, NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';

export async function POST(request: NextRequest) {
  try {
    const { password, addressOffset } = await request.json();

    if (!password) {
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    // Validate addressOffset (must be a non-negative integer)
    const offset = addressOffset !== undefined ? parseInt(addressOffset, 10) : 0;
    if (isNaN(offset) || offset < 0) {
      return NextResponse.json(
        { error: 'Address offset must be a non-negative integer' },
        { status: 400 }
      );
    }

    // Use reinitialize to ensure fresh state when start button is clicked
    console.log(`[API] Start button clicked - reinitializing orchestrator with address offset ${offset}...`);
    await miningOrchestrator.reinitialize(password, offset);

    return NextResponse.json({
      success: true,
      message: 'Mining started',
      addressOffset: offset,
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
