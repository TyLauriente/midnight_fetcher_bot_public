'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Lock, Eye, EyeOff, Copy, Check, ShieldAlert, ArrowLeft, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';

export default function CreateWallet() {
  const router = useRouter();
  const [mode, setMode] = useState<'new' | 'import'>('new');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [seedPhrase, setSeedPhrase] = useState<string | null>(null);
  const [savedConfirm, setSavedConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addressCount] = useState(200);
  const [importMnemonic, setImportMnemonic] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showReplaceWalletModal, setShowReplaceWalletModal] = useState(false);
  const [replaceAttempt, setReplaceAttempt] = useState(false);

  const handleCreateWallet = async () => {
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (mode === 'import') {
      // Validate mnemonic
      const words = importMnemonic.trim().replace(/\s+/g, ' ').split(' ');
      if (words.length !== 24) {
        setError('Seed phrase must be exactly 24 words');
        return;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const payload: Record<string, any> = {
        password,
        count: addressCount,
      };
      if (mode === 'import') payload.mnemonic = importMnemonic.trim();
      if (replaceAttempt) payload.replace = true;
      const response = await fetch('/api/wallet/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.error && data.error.includes('Wallet already exists') && !replaceAttempt) {
          setShowReplaceWalletModal(true);
          setError(null);
          return;
        }
        throw new Error(data.error || 'Failed to create/import wallet');
      }
      setSeedPhrase(data.seedPhrase);
      setShowReplaceWalletModal(false);
      setReplaceAttempt(false);
    } catch (err: any) {
      setError(err.message);
      setShowReplaceWalletModal(false);
      setReplaceAttempt(false);
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

  const handleCopy = async (e?: React.MouseEvent) => {
    // Prevent any default behavior
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!seedPhrase) {
      console.error('No seed phrase to copy');
      setError('No seed phrase to copy');
      return;
    }

    console.log('Copy button clicked, seed phrase length:', seedPhrase.length);

    try {
      // Try modern clipboard API first (requires secure context - HTTPS or localhost)
      if (navigator.clipboard && navigator.clipboard.writeText) {
        console.log('Using modern clipboard API');
        await navigator.clipboard.writeText(seedPhrase);
        console.log('Successfully copied to clipboard');
        setCopied(true);
        setError(null); // Clear any previous errors
        setTimeout(() => setCopied(false), 2000);
      } else {
        // Fallback for older browsers or non-secure contexts
        console.log('Using fallback copy method');
        const textArea = document.createElement('textarea');
        textArea.value = seedPhrase;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        textArea.style.opacity = '0';
        textArea.setAttribute('readonly', '');
        document.body.appendChild(textArea);
        
        // Select the text
        textArea.select();
        textArea.setSelectionRange(0, seedPhrase.length);
        
        try {
          const successful = document.execCommand('copy');
          if (successful) {
            console.log('Successfully copied using fallback method');
            setCopied(true);
            setError(null); // Clear any previous errors
            setTimeout(() => setCopied(false), 2000);
          } else {
            throw new Error('Copy command failed');
          }
        } catch (fallbackError: any) {
          console.error('Fallback copy failed:', fallbackError);
          throw new Error(`Fallback copy failed: ${fallbackError.message}`);
        } finally {
          document.body.removeChild(textArea);
        }
      }
    } catch (err: any) {
      console.error('Failed to copy seed phrase:', err);
      const errorMessage = err.message || 'Unknown error';
      setError(`Failed to copy to clipboard: ${errorMessage}. Please manually select and copy the seed phrase above.`);
      // Don't set copied state on error
      setCopied(false);
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
                    <span className="font-mono font-semibold text-white select-text">{word}</span>
                  </div>
                ))}
              </div>

              {/* Also show the full seed phrase as selectable text for manual copying */}
              <div className="mb-4 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
                <p className="text-xs text-gray-400 mb-2">Full seed phrase (selectable):</p>
                <p className="font-mono text-sm text-white break-words select-all cursor-text">{seedPhrase}</p>
              </div>

              <Button
                type="button"
                onClick={(e) => handleCopy(e)}
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
      {/* Tabs: New or Import */}
      <div className="flex gap-2 mb-8">
        <button
          className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${mode === 'new' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`}
          onClick={() => { setMode('new'); setError(null); }}
        >Create New Wallet</button>
        <button
          className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${mode === 'import' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`}
          onClick={() => { setMode('import'); setError(null); }}
        >Import Existing Wallet</button>
      </div>
      <div className="relative max-w-2xl w-full space-y-8">
        {/* Form main section */}
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>{mode === 'import' ? 'Import Wallet from Seed Phrase' : 'Create New Wallet'}</CardTitle>
            <CardDescription>
              {mode === 'import' ? 'Paste your 24-word seed phrase below to recover your mining wallet.' : 'Generate a new wallet with a fresh seed phrase.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {mode === 'import' && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-300">
                  24-Word Seed Phrase
                </label>
                <textarea
                  rows={3}
                  value={importMnemonic}
                  onChange={e => setImportMnemonic(e.target.value)}
                  className="w-full bg-gray-700/50 border border-gray-600 rounded-lg p-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all font-mono text-sm"
                  placeholder="Enter your 24-word mnemonic seed phrase separated by spaces"
                />
                <p className="text-xs text-gray-500">Enter words separated by spaces (must be exactly 24 words).</p>
              </div>
            )}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
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
                <p className="text-sm text-yellow-400 flex items-center gap-1"><span>⚠</span> Password must be at least 8 characters</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-300">Confirm Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
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
                <p className="text-sm text-red-400 flex items-center gap-1"><span>⚠</span> Passwords do not match</p>
              )}
            </div>
            {error && <Alert variant="error">{error}</Alert>}
          </CardContent>
          <CardFooter className="flex-col gap-3">
            <Button
              onClick={handleCreateWallet}
              disabled={loading || !password || !confirmPassword || password.length < 8 || password !== confirmPassword || (mode === 'import' && importMnemonic.trim().split(/\s+/).length !== 24)}
              variant="success"
              size="lg"
              className="w-full"
            >
              {loading ? (
                <><Loader2 className="w-5 h-5 animate-spin" /> {mode === 'new' ? 'Creating Wallet...' : 'Importing Wallet...'}</>
              ) : (
                mode === 'new' ? 'Create Wallet' : 'Import Wallet'
              )}
            </Button>
            <Button onClick={() => router.push('/')} variant="ghost" size="md" className="w-full">
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Button>
          </CardFooter>
        </Card>
        {/* Optionally show the generated seed phrase like before if in new mode and after creation */}
        {seedPhrase && mode === 'new' && (
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
                      <span className="font-mono font-semibold text-white select-text">{word}</span>
                    </div>
                  ))}
                </div>

                {/* Also show the full seed phrase as selectable text for manual copying */}
                <div className="mb-4 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
                  <p className="text-xs text-gray-400 mb-2">Full seed phrase (selectable):</p>
                  <p className="font-mono text-sm text-white break-words select-all cursor-text">{seedPhrase}</p>
                </div>

                <Button
                  type="button"
                  onClick={(e) => handleCopy(e)}
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
        )}
      </div>
      {showReplaceWalletModal && (
        <Modal
          isOpen={showReplaceWalletModal}
          onClose={() => setShowReplaceWalletModal(false)}
          title="Replace Existing Wallet?"
        >
          <div className="p-6 text-center">
            <p className="mb-3 text-gray-300">A wallet already exists on this computer. If you continue, <b>your old wallet and all previously mined addresses will be permanently deleted.</b> This cannot be undone.</p>
            <div className="flex gap-6 mt-6 justify-center">
              <Button variant="ghost" onClick={() => setShowReplaceWalletModal(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => { setReplaceAttempt(true); setShowReplaceWalletModal(false); handleCreateWallet(); }}>Replace Wallet</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
