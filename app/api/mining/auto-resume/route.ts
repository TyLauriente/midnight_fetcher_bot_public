import { NextRequest, NextResponse } from 'next/server';
import { ConfigManager } from '@/lib/mining/config-manager';

/**
 * API endpoint to enable/disable auto-resume mining
 */
export async function POST(req: NextRequest) {
  try {
    const { enabled, password } = await req.json();

    if (typeof enabled !== 'boolean') {
      return NextResponse.json(
        { success: false, error: 'enabled must be a boolean' },
        { status: 400 }
      );
    }

    if (enabled && !password) {
      return NextResponse.json(
        { success: false, error: 'Password is required when enabling auto-resume' },
        { status: 400 }
      );
    }

    // Enable/disable auto-resume
    ConfigManager.setAutoResume(enabled, password);

    return NextResponse.json({
      success: true,
      message: enabled ? 'Auto-resume enabled' : 'Auto-resume disabled',
      autoResume: enabled,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to update auto-resume setting' },
      { status: 500 }
    );
  }
}

/**
 * Get auto-resume status and decrypted password (if enabled)
 */
export async function GET() {
  try {
    const enabled = ConfigManager.isAutoResumeEnabled();
    const wasActive = ConfigManager.wasMiningActive();
    const decryptedPassword = enabled ? ConfigManager.getDecryptedPassword() : null;

    return NextResponse.json({
      success: true,
      autoResume: enabled,
      wasMiningActive: wasActive,
      password: decryptedPassword, // Return decrypted password for auto-resume
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to get auto-resume status' },
      { status: 500 }
    );
  }
}

