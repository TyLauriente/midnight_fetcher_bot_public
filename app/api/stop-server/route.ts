import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';

export async function POST(req: NextRequest) {
  try {
    // Kill hash-server
    execSync('pkill -f hash-server || true');
    execSync('pkill -f "next" || true');
    // Optionally, kill tmux session if present
    try { execSync('tmux kill-session -t midnightbot || true'); } catch {}
    return NextResponse.json({ success: true, message: 'Server stopped.' });
  } catch (e) {
    return NextResponse.json({ success: false, error: 'Failed to stop servers.' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Use POST to stop server.' }, { status: 405 });
}
