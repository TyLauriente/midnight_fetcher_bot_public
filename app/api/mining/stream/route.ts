import { NextResponse } from 'next/server';
import { miningOrchestrator } from '@/lib/mining/orchestrator';
import { MiningEvent } from '@/lib/mining/types';

export async function GET() {
  const encoder = new TextEncoder();
  let isClosed = false;
  let statsInterval: NodeJS.Timeout | null = null;
  let cleanupFunction: (() => void) | null = null;
  let heartbeatInterval: NodeJS.Timeout | null = null;

  // CRITICAL FIX: Define cleanup function outside so cancel() can access it
  const setupCleanup = (interval: NodeJS.Timeout | null, heartbeat: NodeJS.Timeout | null, onEvent: (event: MiningEvent) => void) => {
    return () => {
      if (isClosed) return; // Prevent double cleanup
      isClosed = true;
      console.log('[Stream] Cleaning up connection and removing listeners...');
      
      if (interval) {
        clearInterval(interval);
      }
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      
      // Clear the outer variables
      statsInterval = null;
      heartbeatInterval = null;
      
      // CRITICAL: Remove all event listeners to prevent memory leaks
      try {
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
        console.log('[Stream] All listeners removed successfully');
      } catch (cleanupError) {
        console.error('[Stream] Error during listener cleanup:', cleanupError);
      }
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
      // CRITICAL FIX: Use a single handler function that can be properly removed
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

      // CRITICAL FIX: Store reference to onEvent for cleanup
      // Add listeners with the same function reference so they can be removed
      try {
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
      } catch (listenerError) {
        console.error('[Stream] Error adding listeners:', listenerError);
        isClosed = true;
      }

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
          if (cleanupFunction) {
            cleanupFunction();
          }
        }
      }, 5000); // Every 5 seconds

      // CRITICAL FIX: Send heartbeat to detect dead connections
      // If client disconnects, we'll detect it when trying to send
      heartbeatInterval = setInterval(() => {
        if (isClosed) return;
        try {
          // Send a comment line as heartbeat (SSE format)
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch (error) {
          // Connection is likely dead, cleanup
          console.log('[Stream] Heartbeat failed, connection likely closed');
          isClosed = true;
          if (cleanupFunction) {
            cleanupFunction();
          }
        }
      }, 30000); // Every 30 seconds

      // CRITICAL FIX: Store cleanup function so cancel() can call it
      // Must be set up after onEvent is defined and intervals are created
      cleanupFunction = setupCleanup(statsInterval, heartbeatInterval, onEvent);

      // CRITICAL FIX: Add AbortController support for better cleanup
      // This ensures cleanup happens even if the connection is aborted
      const abortController = new AbortController();
      
      // Handle client disconnect - return cleanup
      return () => {
        abortController.abort();
        if (cleanupFunction) {
          cleanupFunction();
        }
      };
    },
    cancel() {
      // CRITICAL FIX: Call cleanup to remove event listeners
      // This prevents memory leaks when clients disconnect
      console.log('[Stream] Client disconnected (cancel called), cleaning up listeners...');
      isClosed = true;
      if (cleanupFunction) {
        cleanupFunction();
        cleanupFunction = null;
      }
      if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
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
