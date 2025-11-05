'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Lock, Eye, EyeOff, Copy, Check, ShieldAlert, ArrowLeft, Loader2 } from 'lucide-react';

export default function CreateWallet() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [seedPhrase, setSeedPhrase] = useState<string | null>(null);
  const [savedConfirm, setSavedConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addressCount] = useState(200);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCreateWallet = async () => {
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/wallet/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, count: addressCount }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create wallet');
      }

      setSeedPhrase(data.seedPhrase);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleContinue = () => {
    if (!savedConfirm) {
      setError('Please confirm you have saved your seed phrase');
      return;
    }
    router.push('/wallet/load');
  };

  const handleCopy = async () => {
    if (seedPhrase) {
      await navigator.clipboard.writeText(seedPhrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (seedPhrase) {
    return (
      <div className="relative flex flex-col items-center justify-center min-h-screen p-8 overflow-hidden">
        {/* Background decoration */}
        <div className="absolute inset-0 bg-gradient-to-br from-red-900/10 via-yellow-900/10 to-gray-900 pointer-events-none" />
        <div className="absolute top-20 left-20 w-96 h-96 bg-red-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-20 right-20 w-96 h-96 bg-yellow-500/5 rounded-full blur-3xl pointer-events-none" />

        <div className="relative max-w-4xl w-full space-y-8">
          {/* Header */}
          <div className="text-center space-y-4">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-red-900/30 border-2 border-red-500/50 rounded-full mb-4 animate-pulse">
              <ShieldAlert className="w-10 h-10 text-red-400" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-white">
              Backup Your Seed Phrase
            </h1>
            <p className="text-lg text-red-400 font-semibold">
              This is the ONLY way to recover your wallet
            </p>
          </div>

          {/* Warning Alert */}
          <Alert variant="error" title="Critical: Save Your Seed Phrase">
            <ul className="space-y-2 mt-2">
              <li className="flex items-start gap-2">
                <span className="shrink-0">1.</span>
                <span>Write these 24 words on paper in order</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="shrink-0">2.</span>
                <span>Store in a secure location (safe, vault, etc.)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="shrink-0">3.</span>
                <span>Never share with anyone or store digitally</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="shrink-0">4.</span>
                <span className="font-semibold">Without this phrase, your funds are LOST FOREVER</span>
              </li>
            </ul>
          </Alert>

          {/* Seed Phrase Display */}
          <Card variant="elevated">
            <CardHeader>
              <CardTitle className="text-center">Your 24-Word Seed Phrase</CardTitle>
              <CardDescription className="text-center">
                Keep this safe and never share it with anyone
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
                {seedPhrase.split(' ').map((word, index) => (
                  <div
                    key={index}
                    className="bg-gray-700/50 border border-gray-600 p-3 rounded-lg hover:bg-gray-700 transition-colors"
                  >
                    <span className="text-gray-400 text-xs mr-2 font-medium">{index + 1}.</span>
                    <span className="font-mono font-semibold text-white">{word}</span>
                  </div>
                ))}
              </div>

              <Button
                onClick={handleCopy}
                variant={copied ? 'success' : 'secondary'}
                size="lg"
                className="w-full"
              >
                {copied ? (
                  <>
                    <Check className="w-5 h-5" />
                    Copied to Clipboard!
                  </>
                ) : (
                  <>
                    <Copy className="w-5 h-5" />
                    Copy to Clipboard
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Confirmation */}
          <Card variant="bordered">
            <CardContent className="pt-6">
              <label className="flex items-start gap-4 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={savedConfirm}
                  onChange={(e) => setSavedConfirm(e.target.checked)}
                  className="mt-1 w-5 h-5 rounded border-gray-600 bg-gray-700 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-900 cursor-pointer"
                />
                <span className="text-lg text-gray-200 group-hover:text-white transition-colors">
                  I confirm that I have written down and securely stored my 24-word seed phrase.
                  I understand that without it, I cannot recover my wallet.
                </span>
              </label>
            </CardContent>
          </Card>

          {error && <Alert variant="error">{error}</Alert>}

          {/* Actions */}
          <div className="flex flex-col gap-3">
            <Button
              onClick={handleContinue}
              disabled={!savedConfirm}
              variant="success"
              size="xl"
              className="w-full"
            >
              Continue to Load Wallet
            </Button>
            <p className="text-center text-sm text-gray-500">
              You'll need to enter your password to unlock the wallet
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen p-8 overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 bg-gradient-to-br from-green-900/10 via-blue-900/10 to-gray-900 pointer-events-none" />
      <div className="absolute top-20 left-20 w-96 h-96 bg-green-500/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-20 right-20 w-96 h-96 bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-2xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-green-900/30 border-2 border-green-500/50 rounded-full mb-4">
            <Lock className="w-8 h-8 text-green-400" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-white">
            Create New Wallet
          </h1>
          <p className="text-lg text-gray-400">
            Generate a secure wallet with {addressCount} mining addresses
          </p>
        </div>

        {/* Info Alert */}
        <Alert variant="info" title="Wallet Security">
          Choose a strong password to encrypt your wallet. You'll need this password every time you
          want to access your mining addresses.
        </Alert>

        {/* Form Card */}
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Set Your Wallet Password</CardTitle>
            <CardDescription>
              Minimum 8 characters required for security
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-gray-700/50 border border-gray-600 rounded-lg pl-10 pr-12 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  placeholder="Enter a strong password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              {password && password.length < 8 && (
                <p className="text-sm text-yellow-400 flex items-center gap-1">
                  <span>⚠</span> Password must be at least 8 characters
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">
                Confirm Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full bg-gray-700/50 border border-gray-600 rounded-lg pl-10 pr-12 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  placeholder="Re-enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300 transition-colors"
                >
                  {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="text-sm text-red-400 flex items-center gap-1">
                  <span>⚠</span> Passwords do not match
                </p>
              )}
            </div>

            {error && <Alert variant="error">{error}</Alert>}
          </CardContent>

          <CardFooter className="flex-col gap-3">
            <Button
              onClick={handleCreateWallet}
              disabled={loading || !password || !confirmPassword || password.length < 8 || password !== confirmPassword}
              variant="success"
              size="lg"
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Creating Wallet...
                </>
              ) : (
                'Create Wallet'
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
      </div>
    </div>
  );
}
