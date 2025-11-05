import { NextResponse } from 'next/server';
import { receiptsLogger } from '@/lib/storage/receipts-logger';

export async function GET() {
  try {
    const receipts = receiptsLogger.readReceipts();
    const errors = receiptsLogger.readErrors();

    // Sort by timestamp descending (most recent first)
    receipts.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    errors.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

    return NextResponse.json({
      success: true,
      receipts,
      errors,
      summary: {
        totalSolutions: receipts.length,
        totalErrors: errors.length,
        successRate: receipts.length + errors.length > 0
          ? ((receipts.length / (receipts.length + errors.length)) * 100).toFixed(2) + '%'
          : '0%'
      }
    });
  } catch (error: any) {
    console.error('[API] Mining history error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch mining history' },
      { status: 500 }
    );
  }
}
