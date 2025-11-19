/**
 * Chain Transport
 *
 * Provides the plumbing needed to talk to the Midnight scavenger
 * endpoints without relying on the soon-to-be-removed HTTP API.
 *
 * The website drives everything through on-chain transactions that are
 * assembled with `cardano-cli` (or similar tooling). This transport mirrors
 * that behaviour by shelling out to user-provided commands instead of
 * performing HTTP requests.
 *
 * Configure the commands through environment variables or through the
 * constructor options:
 *   - MIDNIGHT_CHALLENGE_COMMAND: executable that prints challenge JSON
 *   - MIDNIGHT_SUBMIT_COMMAND: executable that submits a solution transaction
 *   - MIDNIGHT_TANDC_COMMAND: executable that prints the current T&C message
 *   - MIDNIGHT_REGISTER_COMMAND: executable that registers an address
 *   - WORK_TO_STAR_RATE_COMMAND: executable that prints work/star rate JSON
 *
 * Each command should emit JSON to stdout that matches the structures used
 * by the existing HTTP API.
 */

import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { ChallengeResponse } from './types';
import { fetchWebsiteChallenge, fetchWebsiteRates, fetchWebsiteTerms } from './website-scraper';
import { receiptsLogger } from '@/lib/storage/receipts-logger';

const execFileAsync = promisify(execFile);

const DEFAULT_WEBSITE_BASE = process.env.MIDNIGHT_WEBSITE_BASE || 'https://midnight.glacier-drop.io';
const LEGACY_API_BASE = process.env.MIDNIGHT_LEGACY_API_BASE || 'https://scavenger.prod.gd.midnighttge.io';

const WEBSITE_MIRRORS = Array.from(new Set([DEFAULT_WEBSITE_BASE, LEGACY_API_BASE].filter(Boolean)));

export interface ChainTransportOptions {
  challengeCommand?: string;
  submitCommand?: string;
  tandcCommand?: string;
  registerCommand?: string;
  workRateCommand?: string;
  fallbackDir?: string;
}

function splitCommand(command: string) {
  const [cmd, ...args] = command.split(/\s+/).filter(Boolean);
  if (!cmd) {
    throw new Error('Invalid command configuration.');
  }
  return { cmd, args };
}

async function runJsonCommand<T>(command: string, extraArgs: string[], label: string): Promise<T> {
  const { cmd, args } = splitCommand(command);
  const { stdout } = await execFileAsync(cmd, [...args, ...extraArgs], { env: process.env });
  try {
    return JSON.parse(stdout) as T;
  } catch (err: any) {
    throw new Error(`[ChainTransport] ${label} command did not return valid JSON: ${err.message}`);
  }
}

async function runCommand(command: string, extraArgs: string[], label: string): Promise<void> {
  const { cmd, args } = splitCommand(command);
  try {
    await execFileAsync(cmd, [...args, ...extraArgs], { env: process.env });
  } catch (err: any) {
    throw new Error(`[ChainTransport] ${label} command failed: ${err.message}`);
  }
}

async function fetchFromMirrors<T>(
  label: string,
  fallbackDir: string | undefined,
  fetcher: (fallbackDir?: string, baseUrl?: string) => Promise<T>
): Promise<T> {
  let lastError: any;

  for (const baseUrl of WEBSITE_MIRRORS) {
    try {
      return await fetcher(fallbackDir, baseUrl);
    } catch (err: any) {
      lastError = err;
      console.warn(`[ChainTransport] ${label} mirror at ${baseUrl} failed:`, err.message);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`[ChainTransport] No ${label.toLowerCase()} mirrors configured.`);
}

export class ChainTransport {
  private readonly challengeCommand?: string;
  private readonly submitCommand?: string;
  private readonly tandcCommand?: string;
  private readonly registerCommand?: string;
  private readonly workRateCommand?: string;
  private readonly fallbackDir?: string;

  constructor(options: ChainTransportOptions = {}) {
    this.challengeCommand = options.challengeCommand || process.env.MIDNIGHT_CHALLENGE_COMMAND;
    this.submitCommand = options.submitCommand || process.env.MIDNIGHT_SUBMIT_COMMAND;
    this.tandcCommand = options.tandcCommand || process.env.MIDNIGHT_TANDC_COMMAND;
    this.registerCommand = options.registerCommand || process.env.MIDNIGHT_REGISTER_COMMAND;
    this.workRateCommand = options.workRateCommand || process.env.WORK_TO_STAR_RATE_COMMAND;
    this.fallbackDir = options.fallbackDir || process.env.MIDNIGHT_FALLBACK_DIR || path.join(process.cwd(), 'storage', 'midnight-website-cache');
  }

  /**
   * Fetch the current challenge using the website-compatible path.
   * The command should return the former ChallengeResponse JSON.
   */
  async fetchChallenge(): Promise<ChallengeResponse> {
    if (this.challengeCommand) {
      return runJsonCommand<ChallengeResponse>(this.challengeCommand, [], 'Challenge fetch');
    }

    const fallback = this.fallbackDir ? path.join(this.fallbackDir, 'challenge.json') : null;
    if (fallback) {
      try {
        const raw = await fs.readFile(fallback, 'utf8');
        return JSON.parse(raw) as ChallengeResponse;
      } catch (err: any) {
        console.warn('[ChainTransport] Fallback challenge file missing or invalid, trying website mirror:', err.message);
      }
    }

    try {
      return await fetchFromMirrors('Challenge fetch', this.fallbackDir, fetchWebsiteChallenge);
    } catch (err: any) {
      throw new Error('[ChainTransport] No challenge command configured and website/legacy mirrors failed. Set MIDNIGHT_CHALLENGE_COMMAND to a cardano-cli script that outputs challenge JSON.');
    }
  }

  /**
   * Submit a solution by invoking the CLI pipeline (e.g., cardano-cli).
   */
  async submitSolution(address: string, challengeId: string, nonce: string, preimage?: string): Promise<void> {
    if (!this.submitCommand) {
      console.warn('[ChainTransport] No submission command configured. Using local receipt log to mirror website submission.');
      receiptsLogger.logReceipt({
        ts: new Date().toISOString(),
        address,
        challenge_id: challengeId,
        nonce,
        hash: preimage || '',
      });
      return;
    }

    const args = [address, challengeId, nonce];
    if (preimage) {
      args.push(preimage);
    }
    await runCommand(this.submitCommand, args, 'Solution submission');
  }

  /**
   * Fetch the T&C message used for registration.
   */
  async fetchTermsAndConditions(): Promise<string> {
    if (this.tandcCommand) {
      const result = await runJsonCommand<{ message?: string; tandc?: string }>(this.tandcCommand, [], 'T&C fetch');
      return result.message || result.tandc || '';
    }

    const fallback = this.fallbackDir ? path.join(this.fallbackDir, 'tandc.txt') : null;
    if (fallback) {
      try {
        return await fs.readFile(fallback, 'utf8');
      } catch (err: any) {
        console.warn('[ChainTransport] Fallback T&C file missing or invalid, trying website mirror:', err.message);
      }
    }

    try {
      return await fetchFromMirrors('T&C fetch', this.fallbackDir, fetchWebsiteTerms);
    } catch (err: any) {
      throw new Error('[ChainTransport] No T&C command configured and website/legacy mirrors failed. Set MIDNIGHT_TANDC_COMMAND or provide a fallback file.');
    }
  }

  /**
   * Register an address using the website-compatible transaction flow.
   */
  async registerAddress(address: string, signature: string, publicKeyHex: string): Promise<void> {
    if (!this.registerCommand) {
      console.warn('[ChainTransport] No registration command configured. Skipping on-chain registration and caching locally.');
      const fallback = this.fallbackDir ? path.join(this.fallbackDir, 'registrations.jsonl') : null;
      if (fallback) {
        try {
          await fs.mkdir(path.dirname(fallback), { recursive: true });
          await fs.appendFile(fallback, `${JSON.stringify({ address, signature, publicKeyHex, ts: new Date().toISOString() })}\n`);
        } catch (err: any) {
          console.warn('[ChainTransport] Failed to persist local registration cache:', err.message);
        }
      }
      return;
    }

    await runCommand(this.registerCommand, [address, signature, publicKeyHex], 'Address registration');
  }

  /**
   * Fetch STAR/NIGHT work rates without the HTTP API.
   */
  async fetchWorkRates(): Promise<number[]> {
    if (this.workRateCommand) {
      return runJsonCommand<number[]>(this.workRateCommand, [], 'Work to STAR rate fetch');
    }

    const fallback = this.fallbackDir ? path.join(this.fallbackDir, 'work_to_star_rate.json') : null;
    if (fallback) {
      try {
        const raw = await fs.readFile(fallback, 'utf8');
        return JSON.parse(raw) as number[];
      } catch (err: any) {
        console.warn('[ChainTransport] Failed to read fallback work_to_star_rate.json:', err.message);
      }
    }

    try {
      return await fetchFromMirrors('Work to STAR rate fetch', this.fallbackDir, fetchWebsiteRates);
    } catch (err: any) {
      console.warn('[ChainTransport] No work rate command configured and website/legacy mirrors failed; STAR calculations will be empty.');
      return [];
    }
  }
}

export const chainTransport = new ChainTransport();
