import { NextRequest, NextResponse } from 'next/server';
import { hashEngine } from '@/lib/hash/engine';
import { DEFAULT_ASH_CONFIG } from '@/lib/hash/types';

export async function POST(request: NextRequest) {
  try {
    const { no_pre_mine, ashConfig } = await request.json();

    if (!no_pre_mine) {
      return NextResponse.json(
        { error: 'no_pre_mine is required' },
        { status: 400 }
      );
    }

    const config = ashConfig || DEFAULT_ASH_CONFIG;

    await hashEngine.initRom(no_pre_mine, config);

    return NextResponse.json({
      success: true,
      status: 'initialized',
      no_pre_mine: no_pre_mine.slice(0, 16) + '...',
    });
  } catch (error: any) {
    console.error('[API] Hash init error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to initialize ROM' },
      { status: 500 }
    );
  }
}
