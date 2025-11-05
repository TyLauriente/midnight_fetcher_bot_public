'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Wallet, Plus, LogIn, Loader2, Sparkles, Shield, Zap } from 'lucide-react';
import { Alert } from '@/components/ui/alert';

export default function Home() {
  const router = useRouter();
  const [walletExists, setWalletExists] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkWalletStatus();
  }, []);

  const checkWalletStatus = async () => {
    try {
      const response = await fetch('/api/wallet/status');
      const data = await response.json();
      setWalletExists(data.exists);
    } catch (error) {
      console.error('Failed to check wallet status:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4">
          <Loader2 className="w-12 h-12 animate-spin text-blue-500 mx-auto" />
          <p className="text-lg text-gray-400">Initializing...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen p-8 overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-900/10 via-purple-900/10 to-gray-900 pointer-events-none" />
      <div className="absolute top-20 left-20 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-20 right-20 w-96 h-96 bg-purple-500/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-4xl w-full space-y-12">
        {/* Hero Section */}
        <div className="text-center space-y-6">
          <div className="inline-flex items-center gap-3 px-4 py-2 bg-blue-900/20 border border-blue-700/50 rounded-full text-blue-300 text-sm font-medium">
            <Sparkles className="w-4 h-4" />
            <span>Windows Mining Application</span>
          </div>

          <h1 className="text-6xl md:text-7xl font-bold bg-gradient-to-r from-blue-400 via-purple-400 to-blue-400 bg-clip-text text-transparent animate-gradient">
            Midnight Fetcher Bot
          </h1>

          <p className="text-xl text-gray-400 max-w-2xl mx-auto">
            High-performance proof-of-work mining platform powered by Rust and optimized for Windows
          </p>
        </div>

        {/* Feature Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Card variant="glass" className="text-center">
            <CardContent className="pt-6">
              <Shield className="w-8 h-8 text-blue-400 mx-auto mb-3" />
              <h3 className="font-semibold text-white mb-1">Secure Encryption</h3>
              <p className="text-sm text-gray-400">AES-256-GCM encryption</p>
            </CardContent>
          </Card>

          <Card variant="glass" className="text-center">
            <CardContent className="pt-6">
              <Zap className="w-8 h-8 text-yellow-400 mx-auto mb-3" />
              <h3 className="font-semibold text-white mb-1">High Performance</h3>
              <p className="text-sm text-gray-400">Native Rust engine</p>
            </CardContent>
          </Card>

          <Card variant="glass" className="text-center">
            <CardContent className="pt-6">
              <Wallet className="w-8 h-8 text-green-400 mx-auto mb-3" />
              <h3 className="font-semibold text-white mb-1">200 Addresses</h3>
              <p className="text-sm text-gray-400">Multi-address mining</p>
            </CardContent>
          </Card>
        </div>

        {/* Main Action Card */}
        <Card variant="elevated" className="max-w-xl mx-auto">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl">
              {walletExists ? 'Welcome Back' : 'Get Started'}
            </CardTitle>
            <CardDescription>
              {walletExists
                ? 'Load your wallet to access the mining dashboard'
                : 'Create your first wallet to begin mining'}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {walletExists ? (
              <>
                <Button
                  onClick={() => router.push('/wallet/load')}
                  variant="primary"
                  size="lg"
                  className="w-full"
                >
                  <LogIn className="w-5 h-5" />
                  Load Existing Wallet
                </Button>
                <p className="text-center text-sm text-gray-400">
                  Enter your password to unlock your wallet
                </p>
              </>
            ) : (
              <>
                <Button
                  onClick={() => router.push('/wallet/create')}
                  variant="success"
                  size="lg"
                  className="w-full"
                >
                  <Plus className="w-5 h-5" />
                  Create New Wallet
                </Button>
                <p className="text-center text-sm text-gray-400">
                  Generate a secure wallet with 200 mining addresses
                </p>
              </>
            )}
          </CardContent>

          {walletExists && (
            <CardFooter className="flex-col space-y-3">
              <Alert variant="warning" className="w-full">
                Creating a new wallet will require backing up a new seed phrase
              </Alert>
              <Button
                onClick={() => router.push('/wallet/create')}
                variant="outline"
                size="md"
                className="w-full"
              >
                <Plus className="w-4 h-4" />
                Create New Wallet Instead
              </Button>
            </CardFooter>
          )}
        </Card>

        {/* Footer */}
        <div className="text-center text-sm text-gray-500 space-y-2">
          <p className="flex items-center justify-center gap-2">
            <span>Made for Windows</span>
            <span>•</span>
            <span>Powered by Midnight</span>
          </p>
        </div>
      </div>
    </div>
  );
}
