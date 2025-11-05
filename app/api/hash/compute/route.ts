import { NextRequest, NextResponse } from 'next/server';
import { hashEngine } from '@/lib/hash/engine';

export async function POST(request: NextRequest) {
  try {
    const { preimage } = await request.json();

    if (!preimage) {
      return NextResponse.json(
        { error: 'preimage is required' },
        { status: 400 }
      );
    }

    const hash = hashEngine.hash(preimage);

    return NextResponse.json({
      hash,
    });
  } catch (error: any) {
    console.error('[API] Hash compute error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to compute hash' },
      { status: 500 }
    );
  }
}
