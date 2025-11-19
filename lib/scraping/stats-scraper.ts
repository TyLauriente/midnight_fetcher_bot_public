/**
 * Stats Scraper
 * Scrapes mining statistics from the website
 * Replaces stats/address query endpoints
 */

import { browserService } from './browser-service';

const MINING_URL = 'https://sm.midnight.gd/wizard/mine';

export interface MiningStats {
  currentChallenge?: number;
  minerStatus?: 'ACTIVE' | 'INACTIVE' | 'FINDING';
  submittedSolutions?: number;
  totalSolutions?: number;
  estimatedNight?: number;
  estimatedShare?: number;
}

/**
 * Scrape mining statistics from the website
 */
export async function fetchMiningStats(): Promise<MiningStats> {
  try {
    const page = await browserService.navigateTo(MINING_URL);

    await page.waitForTimeout(2000);

    // Check if we're on the mining page
    const currentUrl = page.url();
    if (!currentUrl.includes('/wizard/mine')) {
      // Try to navigate to mine page
      await page.goto(MINING_URL, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
    }

    // Extract statistics from the page
    const stats = await page.evaluate(() => {
      const result: MiningStats = {};
      const bodyText = document.body.innerText || '';

      // Extract current challenge number
      // Pattern: "Current challenge: 483" or "Challenge: 483"
      const challengeMatch = bodyText.match(/current challenge[:\s]+(\d+)/i) ||
                            bodyText.match(/challenge[:\s]+(\d+)/i);
      if (challengeMatch) {
        result.currentChallenge = parseInt(challengeMatch[1], 10);
      }

      // Extract miner status
      // Pattern: "Miner status: ACTIVE" or "Status: Finding a solution"
      const statusMatch = bodyText.match(/miner status[:\s]+(\w+)/i) ||
                         bodyText.match(/status[:\s]+(\w+)/i);
      if (statusMatch) {
        const status = statusMatch[1].toUpperCase();
        if (status === 'ACTIVE' || status === 'INACTIVE' || status === 'FINDING') {
          result.minerStatus = status as 'ACTIVE' | 'INACTIVE' | 'FINDING';
        } else if (status.includes('FINDING')) {
          result.minerStatus = 'FINDING';
        } else if (status.includes('ACTIVE')) {
          result.minerStatus = 'ACTIVE';
        }
      }

      // Extract submitted solutions
      // Pattern: "Your submitted solutions: 120 / 504"
      const submittedMatch = bodyText.match(/your submitted solutions[:\s]+(\d+)\s*\/\s*(\d+)/i) ||
                            bodyText.match(/submitted solutions[:\s]+(\d+)/i);
      if (submittedMatch) {
        result.submittedSolutions = parseInt(submittedMatch[1], 10);
        if (submittedMatch[2]) {
          result.totalSolutions = parseInt(submittedMatch[2], 10);
        }
      }

      // Extract estimated NIGHT tokens
      // Pattern: "Your estimated claim: 330.9561 NIGHT"
      const nightMatch = bodyText.match(/estimated claim[:\s]+([\d.]+)\s*night/i) ||
                        bodyText.match(/([\d.]+)\s*night/i);
      if (nightMatch) {
        result.estimatedNight = parseFloat(nightMatch[1]);
      }

      // Extract estimated share
      // Pattern: "Your estimated share: 0.00003684%"
      const shareMatch = bodyText.match(/estimated share[:\s]+([\d.]+)%/i);
      if (shareMatch) {
        result.estimatedShare = parseFloat(shareMatch[1]);
      }

      // Extract all submitted solutions (global)
      // Pattern: "All submitted solutions: 325708320"
      const allSolutionsMatch = bodyText.match(/all submitted solutions[:\s]+([\d,]+)/i);
      if (allSolutionsMatch) {
        const countStr = allSolutionsMatch[1].replace(/,/g, '');
        result.totalSolutions = parseInt(countStr, 10);
      }

      return result;
    });

    return stats;

  } catch (error: any) {
    console.error('[StatsScraper] Error fetching mining stats:', error.message);
    
    // Return empty stats on error
    return {};
  }
}

/**
 * Get address-specific statistics
 */
export async function getAddressSubmissions(address: string): Promise<{
  count: number;
  lastSubmission?: string;
  challenges: string[];
}> {
  try {
    // Navigate to the website and look for address-specific stats
    // This might require being logged in or on a specific page
    const page = await browserService.navigateTo(MINING_URL);

    await page.waitForTimeout(2000);

    // Try to extract address-specific data from the page
    const submissions = await page.evaluate((addr: string) => {
      const bodyText = document.body.innerText || '';

      // Look for address-specific submission count
      // This might be in a table or list
      const countMatch = bodyText.match(new RegExp(`${addr}[^\\d]*(\\d+)[^\\d]*submission`, 'i'));
      
      return {
        count: countMatch ? parseInt(countMatch[1], 10) : 0,
        lastSubmission: undefined,
        challenges: [],
      };
    }, address);

    return submissions;

  } catch (error: any) {
    console.error('[StatsScraper] Error fetching address submissions:', error.message);
    
    return {
      count: 0,
      challenges: [],
    };
  }
}

/**
 * Fetch work_to_star_rate if available
 * This might be in a different location or calculated from stats
 */
export async function fetchWorkToStarRate(): Promise<number[]> {
  try {
    // Try to find work_to_star_rate data on the website
    // This might be in JavaScript state or calculated from stats
    const page = await browserService.navigateTo(MINING_URL);

    await page.waitForTimeout(2000);

    const rates = await page.evaluate(() => {
      const win = window as any;

      // Look for rates in JavaScript state
      if (win.__NEXT_DATA__) {
        const nextData = win.__NEXT_DATA__;
        if (nextData.props?.pageProps?.workToStarRate) {
          return nextData.props.pageProps.workToStarRate;
        }
        if (nextData.props?.pageProps?.rates) {
          return nextData.props.pageProps.rates;
        }
      }

      // Look for rates in React state
      if (win.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        // Try to extract from React tree
        // This is a fallback approach
      }

      return null;
    });

    if (rates && Array.isArray(rates)) {
      return rates;
    }

    // Fallback: Return empty array
    return [];

  } catch (error: any) {
    console.error('[StatsScraper] Error fetching work_to_star_rate:', error.message);
    return [];
  }
}

