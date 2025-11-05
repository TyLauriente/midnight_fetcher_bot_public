import { NextResponse } from 'next/server';
import { receiptsLogger } from '@/lib/storage/receipts-logger';
import { computeStats, computeHourlyStats, computeLastNHours, fetchRates, getTodayStats, getSolutionsPerHour } from '@/lib/stats/compute';

const API_BASE = 'https://scavenger.prod.gd.midnighttge.io';

/**
 * GET /api/stats - Get mining statistics with STAR/NIGHT rewards
 */
export async function GET() {
  try {
    const allReceipts = receiptsLogger.readReceipts();
    const errors = receiptsLogger.readErrors();

    // Filter out dev fee receipts from user stats
    const receipts = allReceipts.filter(r => !r.isDevFee);

    // Fetch STAR rates from API
    const rates = await fetchRates(API_BASE);

    // Compute stats with STAR/NIGHT (only user receipts, no dev fee)
    const globalStats = computeStats(receipts, rates);
    const hourlyStats = computeHourlyStats(receipts, rates);
    const last8Hours = computeLastNHours(receipts, rates, 8);
    const todayStats = getTodayStats(receipts, rates);
    const solutionsPerHour24h = getSolutionsPerHour(receipts, 24);
    const solutionsPerHour1h = getSolutionsPerHour(receipts, 1);

    return NextResponse.json({
      success: true,
      stats: {
        global: globalStats,
        hourly: hourlyStats,
        last8Hours: last8Hours,
        today: todayStats,
        rate: {
          perHour24h: solutionsPerHour24h,
          perHour1h: solutionsPerHour1h,
        },
        errors: {
          total: errors.length,
        },
      },
    });
  } catch (error: any) {
    console.error('[Stats API] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
}
