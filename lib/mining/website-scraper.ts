import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { ChallengeResponse } from './types';

/**
 * Website scraper utilities
 *
 * The Midnight website keeps exposing challenge, terms, and work/star rate
 * payloads even after the dedicated API goes away. These helpers mirror how
 * the browser grabs those assets so the miner can self-configure without any
 * operator-supplied commands.
 */
const DEFAULT_BASE = process.env.MIDNIGHT_WEBSITE_BASE || 'https://midnight.glacier-drop.io';

const candidatePaths = {
  challenge: ['/api/challenge', '/challenge', '/challenge.json'],
  tandc: ['/api/tandc', '/tandc', '/tandc.txt'],
  workRates: ['/api/work_to_star_rate', '/work_to_star_rate.json', '/rates.json'],
};

async function fetchFirst(baseUrl: string, paths: string[]): Promise<any> {
  for (const suffix of paths) {
    const url = `${baseUrl.replace(/\/$/, '')}${suffix}`;
    try {
      const response = await axios.get(url, { timeout: 5_000 });
      return response.data;
    } catch (err) {
      continue;
    }
  }
  throw new Error('No website endpoints returned data');
}

async function readOrWriteCache<T>(fallbackDir: string | undefined, filename: string, data?: T): Promise<T | null> {
  if (!fallbackDir) return null;

  const filePath = path.join(fallbackDir, filename);
  if (data !== undefined) {
    try {
      await fs.mkdir(fallbackDir, { recursive: true });
      await fs.writeFile(filePath, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[WebsiteScraper] Failed to write cache ${filename}:`, (err as any).message);
    }
    return data as T;
  }

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (filename.endsWith('.json') || filename.endsWith('.jsonl')) {
      return JSON.parse(raw) as T;
    }
    return raw as unknown as T;
  } catch (err) {
    return null;
  }
}

export async function fetchWebsiteChallenge(fallbackDir?: string, baseUrl: string = DEFAULT_BASE): Promise<ChallengeResponse> {
  const cached = await readOrWriteCache<ChallengeResponse>(fallbackDir, 'challenge.json');
  if (cached) return cached;

  const data = await fetchFirst(baseUrl, candidatePaths.challenge);
  await readOrWriteCache(fallbackDir, 'challenge.json', data);
  return data as ChallengeResponse;
}

export async function fetchWebsiteTerms(fallbackDir?: string, baseUrl: string = DEFAULT_BASE): Promise<string> {
  const cached = await readOrWriteCache<string>(fallbackDir, 'tandc.txt');
  if (cached) return cached;

  const data = await fetchFirst(baseUrl, candidatePaths.tandc);
  const message = typeof data === 'string' ? data : data.message || data.tandc || '';
  await readOrWriteCache(fallbackDir, 'tandc.txt', message);
  return message;
}

export async function fetchWebsiteRates(fallbackDir?: string, baseUrl: string = DEFAULT_BASE): Promise<number[]> {
  const cached = await readOrWriteCache<number[]>(fallbackDir, 'work_to_star_rate.json');
  if (cached) return cached;

  const data = await fetchFirst(baseUrl, candidatePaths.workRates);
  const rates = Array.isArray(data) ? data : data?.rates || data?.work_to_star_rate || [];
  await readOrWriteCache(fallbackDir, 'work_to_star_rate.json', rates);
  return rates as number[];
}
