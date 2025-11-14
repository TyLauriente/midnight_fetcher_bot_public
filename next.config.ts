import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['lucid-cardano'],

  // Turbopack configuration
  turbopack: {
    resolveAlias: {
      // Keep native modules external
      '../../hashengine/index.node': './hashengine/index.node',
    },
  },

  // Limit Next.js build workers to reduce confusion (optional - doesn't affect mining)
  // This only affects static page generation during build, not runtime mining workers
  experimental: {
    workerThreads: false, // Disable worker threads for static generation (uses main thread)
    cpus: 1, // Limit to 1 CPU for static generation
  },
};

export default nextConfig;
