import { NextRequest, NextResponse } from 'next/server';
import { ConfigManager } from '@/lib/mining/config-manager';

/**
 * API endpoint to save mining state (for auto-resume)
 */
export async function POST(req: NextRequest) {
  try {
    const { active } = await req.json();

    if (typeof active !== 'boolean') {
      return NextResponse.json(
        { success: false, error: 'active must be a boolean' },
        { status: 400 }
      );
    }

    // Save mining state
    ConfigManager.setMiningActive(active);

    return NextResponse.json({
      success: true,
      message: `Mining state saved: ${active ? 'active' : 'inactive'}`,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to save mining state' },
      { status: 500 }
    );
  }
}

