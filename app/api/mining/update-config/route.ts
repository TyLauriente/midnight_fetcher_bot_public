/**
 * API endpoint to update mining orchestrator configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';

export async function POST(req: NextRequest) {
  try {
    const { workerThreads, batchSize } = await req.json();

    // Raise the max allowed workerThreads
    const MAX_WORKERS = 1024; // Use at your own risk: high values can cause instability if you don't have enough cores/memory
    if (typeof workerThreads !== 'number' || workerThreads < 1 || workerThreads > MAX_WORKERS) {
      return NextResponse.json(
        { success: false, error: `Invalid workerThreads value (must be between 1 and ${MAX_WORKERS})` },
        { status: 400 }
      );
    }

    if (typeof batchSize !== 'number' || batchSize < 50 || batchSize > 1000) {
      return NextResponse.json(
        { success: false, error: 'Invalid batchSize value (must be between 50 and 1000)' },
        { status: 400 }
      );
    }

    // Update configuration in the orchestrator
    miningOrchestrator.updateConfiguration({
      workerThreads,
      batchSize,
    });

    return NextResponse.json({
      success: true,
      message: 'Configuration updated successfully',
      config: {
        workerThreads,
        batchSize,
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to update configuration' },
      { status: 500 }
    );
  }
}
