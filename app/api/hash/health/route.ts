import { NextResponse } from 'next/server';
import { hashEngine } from '@/lib/hash/engine';

export async function GET() {
  try {
    const status = await hashEngine.getStatus();

    return NextResponse.json({
      status: 'ok',
      ...status,
    });
  } catch (error: any) {
    console.error('[API] Hash health error:', error);
    return NextResponse.json(
      { error: error.message || 'Health check failed' },
      { status: 500 }
    );
  }
}
