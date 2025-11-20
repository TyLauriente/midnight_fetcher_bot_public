'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Lock, Eye, EyeOff, Copy, Check, ShieldAlert, ArrowLeft, Loader2, Download, Plus } from 'lucide-react';

type WalletMode = 'create' | 'import';

export default function CreateWallet() {
  const router = useRouter();
  const [mode, setMode] = useState<WalletMode>('create');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [importSeedPhrase, setImportSeedPhrase] = useState('');
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
      if (mode === 'import') {
        // Import existing wallet
        if (!importSeedPhrase.trim()) {
          setError('Please enter your seed phrase');
          setLoading(false);
          return;
        }

        const response = await fetch('/api/wallet/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            seedPhrase: importSeedPhrase.trim(), 
            password, 
            count: addressCount 
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to import wallet');
        }

        // Import successful, redirect to load page
        router.push('/wallet/load');
      } else {
        // Create new wallet
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
      }
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
          <div className={`inline-flex items-center justify-center w-16 h-16 ${mode === 'create' ? 'bg-green-900/30 border-green-500/50' : 'bg-blue-900/30 border-blue-500/50'} border-2 rounded-full mb-4`}>
            {mode === 'create' ? (
              <Lock className="w-8 h-8 text-green-400" />
            ) : (
              <Download className="w-8 h-8 text-blue-400" />
            )}
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-white">
            {mode === 'create' ? 'Create New Wallet' : 'Import Existing Wallet'}
          </h1>
          <p className="text-lg text-gray-400">
            {mode === 'create' 
              ? `Generate a secure wallet with ${addressCount} mining addresses`
              : `Import your wallet using your 24-word seed phrase`}
          </p>
        </div>

        {/* Mode Toggle */}
        <div className="flex items-center justify-center gap-2 p-1 bg-gray-800/50 rounded-lg border border-gray-700">
          <button
            onClick={() => {
              setMode('create');
              setError(null);
              setImportSeedPhrase('');
            }}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md transition-all ${
              mode === 'create'
                ? 'bg-green-600 text-white shadow-lg'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Plus className="w-4 h-4" />
            Create New
          </button>
          <button
            onClick={() => {
              setMode('import');
              setError(null);
            }}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md transition-all ${
              mode === 'import'
                ? 'bg-blue-600 text-white shadow-lg'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            <Download className="w-4 h-4" />
            Import Existing
          </button>
        </div>

        {/* Info Alert */}
        {mode === 'create' ? (
          <Alert variant="info" title="Wallet Security">
            Choose a strong password to encrypt your wallet. You'll need this password every time you
            want to access your mining addresses.
          </Alert>
        ) : (
          <Alert variant="warning" title="Importing Wallet">
            This will replace any existing wallet. Make sure you have your seed phrase backed up before proceeding.
            Your seed phrase will be encrypted with the password you provide.
          </Alert>
        )}

        {/* Form Card */}
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>{mode === 'create' ? 'Set Your Wallet Password' : 'Import Your Wallet'}</CardTitle>
            <CardDescription>
              {mode === 'create' 
                ? 'Minimum 8 characters required for security'
                : 'Enter your 24-word seed phrase and set a password to encrypt it'}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            {mode === 'import' && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-300">
                  Seed Phrase (24 words)
                </label>
                <textarea
                  value={importSeedPhrase}
                  onChange={(e) => setImportSeedPhrase(e.target.value)}
                  className="w-full bg-gray-700/50 border border-gray-600 rounded-lg px-4 py-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all min-h-[120px] font-mono text-sm"
                  placeholder="Enter your 24-word seed phrase here..."
                />
                <p className="text-xs text-gray-500">
                  Enter all 24 words separated by spaces. The seed phrase will be validated before import.
                </p>
                {importSeedPhrase && importSeedPhrase.trim().split(/\s+/).length !== 24 && (
                  <p className="text-sm text-yellow-400 flex items-center gap-1">
                    <span>⚠</span> Seed phrase should contain exactly 24 words (currently: {importSeedPhrase.trim().split(/\s+/).length})
                  </p>
                )}
              </div>
            )}
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
              disabled={
                loading || 
                !password || 
                !confirmPassword || 
                password.length < 8 || 
                password !== confirmPassword ||
                (mode === 'import' && (!importSeedPhrase.trim() || importSeedPhrase.trim().split(/\s+/).length !== 24))
              }
              variant={mode === 'create' ? 'success' : 'primary'}
              size="lg"
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {mode === 'create' ? 'Creating Wallet...' : 'Importing Wallet...'}
                </>
              ) : (
                mode === 'create' ? 'Create Wallet' : 'Import Wallet'
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
