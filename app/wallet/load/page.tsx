'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Lock, Eye, EyeOff, LogIn, ArrowLeft, Loader2, KeyRound } from 'lucide-react';

export default function LoadWallet() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [checkingAutoUnlock, setCheckingAutoUnlock] = useState(true);

  // Check if wallet is already unlocked on the backend (from auto-startup script)
  useEffect(() => {
    const checkAutoUnlock = async () => {
      // Retry up to 10 times with 2 second delays (20 seconds total)
      // This handles the case where auto-startup script is still running
      const maxRetries = 10;
      const retryDelay = 2000;
      const defaultPassword = 'Rascalismydog@1';
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // First, check if mining is already active (most reliable indicator)
          const statusResponse = await fetch('/api/mining/status');
          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            if (statusData.success && statusData.stats?.active) {
              // Mining is active! Wallet is already unlocked and mining is running
              // Set the default password in sessionStorage and redirect to mining
              sessionStorage.setItem('walletPassword', defaultPassword);
              console.log(`[Wallet Load] Mining is already active (attempt ${attempt + 1})! Wallet unlocked via auto-startup, redirecting to mining...`);
              router.push('/mining');
              return;
            }
          }
          
          // Mining is not active yet, try to verify default password works
          const response = await fetch('/api/wallet/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: defaultPassword }),
          });
          
          if (response.ok) {
            // Default password works! Wallet can be unlocked
            // Set the default password in sessionStorage and redirect to mining
            // (Mining may start automatically or user can start it manually)
            sessionStorage.setItem('walletPassword', defaultPassword);
            console.log(`[Wallet Load] Default password works! (attempt ${attempt + 1}) Wallet can be unlocked, redirecting to mining...`);
            router.push('/mining');
            return;
          } else {
            // Default password doesn't work yet, maybe auto-startup is still running
            if (attempt < maxRetries - 1) {
              console.log(`[Wallet Load] Default password check failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${retryDelay / 1000}s...`);
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              continue;
            } else {
              // All retries failed, show the password input form
              console.log('[Wallet Load] Default password does not work after all retries, showing password input form');
            }
          }
        } catch (error) {
          console.error(`[Wallet Load] Error checking auto-unlock (attempt ${attempt + 1}):`, error);
          // On error, wait and retry unless this is the last attempt
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          }
        }
      }
      
      // All retries failed, show the password input form
      setCheckingAutoUnlock(false);
    };
    
    checkAutoUnlock();
  }, [router]);

  const handleLoadWallet = async () => {
    if (!password) {
      setError('Password is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/wallet/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load wallet');
      }

      // Wallet loaded successfully, store password securely in sessionStorage
      // Note: sessionStorage is cleared when the browser tab is closed
      sessionStorage.setItem('walletPassword', password);

      // Navigate to mining page without password in URL
      router.push('/mining');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && password && !loading) {
      handleLoadWallet();
    }
  };

  // Show loading state while checking auto-unlock
  if (checkingAutoUnlock) {
    return (
      <div className="relative flex flex-col items-center justify-center min-h-screen p-8 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-900/10 via-purple-900/10 to-gray-900 pointer-events-none" />
        <div className="relative text-center space-y-4">
          <Loader2 className="w-16 h-16 animate-spin text-blue-500 mx-auto" />
          <p className="text-lg text-gray-400">Checking if wallet is already unlocked...</p>
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

      <div className="relative max-w-2xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-900/30 border-2 border-blue-500/50 rounded-full mb-4">
            <KeyRound className="w-8 h-8 text-blue-400" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-white">
            Welcome Back
          </h1>
          <p className="text-lg text-gray-400">
            Enter your password to unlock your wallet and start mining
          </p>
        </div>

        {/* Info Alert */}
        <Alert variant="info" title="Secure Access">
          Your wallet data is encrypted. Enter your password to decrypt and access your 200 mining addresses.
        </Alert>

        {/* Form Card */}
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Unlock Your Wallet</CardTitle>
            <CardDescription>
              Use the password you created when you first set up your wallet
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">
                Wallet Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyPress={handleKeyPress}
                  className="w-full bg-gray-700/50 border border-gray-600 rounded-lg pl-10 pr-12 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  placeholder="Enter your password"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Press Enter to continue
              </p>
            </div>

            {error && <Alert variant="error">{error}</Alert>}
          </CardContent>

          <CardFooter className="flex-col gap-3">
            <Button
              onClick={handleLoadWallet}
              disabled={loading || !password}
              variant="primary"
              size="lg"
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Unlocking Wallet...
                </>
              ) : (
                <>
                  <LogIn className="w-5 h-5" />
                  Unlock Wallet
                </>
              )}
            </Button>

            <Button
              onClick={() => router.push('/')}
              variant="ghost"
              size="md"
              className="w-full"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Button>
          </CardFooter>
        </Card>

        {/* Help Section */}
        <Card variant="glass">
          <CardContent className="pt-6">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-300">Having trouble?</h3>
              <div className="space-y-2 text-sm text-gray-400">
                <p>• Make sure you're using the password you created during wallet setup</p>
                <p>• Passwords are case-sensitive</p>
                <p>• If you've forgotten your password, you'll need your seed phrase to recover</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
