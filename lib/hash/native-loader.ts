/**
 * Native module loader - isolated to avoid build-time analysis
 * This file should only be imported at runtime on the server
 */

// Native binding interface
interface NativeBinding {
  initRom(
    no_pre_mine_hex: string,
    nb_loops: number,
    nb_instrs: number,
    pre_size: number,
    rom_size: number,
    mixing_numbers: number
  ): void;
  hashPreimage(preimage: string): string;
  romReady(): boolean;
}

export async function loadNativeModule(): Promise<NativeBinding | null> {
  // Only load on server-side at runtime
  if (typeof window !== 'undefined') {
    console.log('[Native Loader] Skipping on client-side');
    return null;
  }

  try {
    console.log('[Native Loader] Loading native hash implementation');

    // Dynamic import to avoid build-time analysis
    const path = await import('path');
    const fs = await import('fs');
    const { fileURLToPath } = await import('url');

    // In Next.js, we need to use process.cwd() to get project root, not __dirname
    // because __dirname points to the compiled .next directory
    const projectRoot = process.cwd();
    const modulePath = path.join(projectRoot, 'hashengine', 'index.node');

    // Check if file exists
    if (!fs.existsSync(modulePath)) {
      throw new Error(`Native module not found at ${modulePath}`);
    }

    // Load using eval to completely hide from static analysis
    const req = eval('require');
    const binding = req(modulePath);

    console.log('[Native Loader] ✓ Loaded successfully');
    console.log('[Native Loader] Available functions:', Object.keys(binding));

    // Verify API compatibility
    if (!binding.initRom || !binding.hashPreimage || !binding.romReady) {
      throw new Error(`Native binding missing required functions. Available: ${Object.keys(binding).join(', ')}`);
    }

    return binding;
  } catch (e: any) {
    console.error('[Native Loader] Failed to load native binding:', e.message);
    console.error('[Native Loader] To build native module:');
    console.error('[Native Loader]   1. cd hashengine');
    console.error('[Native Loader]   2. npm install');
    console.error('[Native Loader]   3. npm run build');
    console.error('[Native Loader]   4. Restart application');
    return null;
  }
}
