import { NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';
import { MiningEvent } from '@/lib/mining/types';

export async function GET() {
  const encoder = new TextEncoder();
  let isClosed = false;
  let statsInterval: NodeJS.Timeout | null = null;
  let cleanupFunction: (() => void) | null = null;

  // CRITICAL FIX: Define cleanup function outside so cancel() can access it
  const setupCleanup = (interval: NodeJS.Timeout | null, onEvent: (event: MiningEvent) => void) => {
    return () => {
      if (isClosed) return; // Prevent double cleanup
      isClosed = true;
      if (interval) {
        clearInterval(interval);
      }
      // Clear the outer variable
      statsInterval = null;
      miningOrchestrator.off('status', onEvent);
      miningOrchestrator.off('solution', onEvent);
      miningOrchestrator.off('stats', onEvent);
      miningOrchestrator.off('error', onEvent);
      miningOrchestrator.off('mining_start', onEvent);
      miningOrchestrator.off('hash_progress', onEvent);
      miningOrchestrator.off('solution_submit', onEvent);
      miningOrchestrator.off('solution_result', onEvent);
      miningOrchestrator.off('registration_progress', onEvent);
      miningOrchestrator.off('worker_update', onEvent);
    };
  };

  const stream = new ReadableStream({
    start(controller) {
      // Send initial stats
      try {
        const initialStats = miningOrchestrator.getStats();
        const data = `data: ${JSON.stringify({ type: 'stats', stats: initialStats })}\n\n`;
        controller.enqueue(encoder.encode(data));
      } catch (error) {
        console.error('Error sending initial stats:', error);
      }

      // Set up event listeners
      const onEvent = (event: MiningEvent) => {
        if (isClosed) return;
        try {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        } catch (error) {
          console.error('Error sending event:', error);
          isClosed = true;
        }
      };

      miningOrchestrator.on('status', onEvent);
      miningOrchestrator.on('solution', onEvent);
      miningOrchestrator.on('stats', onEvent);
      miningOrchestrator.on('error', onEvent);
      miningOrchestrator.on('mining_start', onEvent);
      miningOrchestrator.on('hash_progress', onEvent);
      miningOrchestrator.on('solution_submit', onEvent);
      miningOrchestrator.on('solution_result', onEvent);
      miningOrchestrator.on('registration_progress', onEvent);
      miningOrchestrator.on('worker_update', onEvent);

      // Send periodic stats updates
      statsInterval = setInterval(() => {
        if (isClosed) return;
        try {
          const stats = miningOrchestrator.getStats();
          const data = `data: ${JSON.stringify({ type: 'stats', stats })}\n\n`;
          controller.enqueue(encoder.encode(data));
        } catch (error) {
          console.error('Error sending periodic stats:', error);
          isClosed = true;
          if (statsInterval) {
            clearInterval(statsInterval);
            statsInterval = null;
          }
        }
      }, 5000); // Every 5 seconds

      // CRITICAL FIX: Store cleanup function so cancel() can call it
      cleanupFunction = setupCleanup(statsInterval, onEvent);

      // Handle client disconnect - return cleanup
      return cleanupFunction;
    },
    cancel() {
      // CRITICAL FIX: Call cleanup to remove event listeners
      // This prevents memory leaks when clients disconnect
      isClosed = true;
      if (cleanupFunction) {
        cleanupFunction();
        cleanupFunction = null;
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
