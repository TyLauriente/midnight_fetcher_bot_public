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
};

export default nextConfig;
