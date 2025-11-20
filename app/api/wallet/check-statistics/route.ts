import { NextRequest, NextResponse } from 'next/server';


export const runtime = "nodejs";

import { chromium, Browser, BrowserContext, Page } from "playwright";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
const DEFAULT_PARALLEL = parseInt(process.env.STATS_MAX_PARALLEL || '5', 10);

async function initBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9"
      }
    });

  }
}

async function createPage(): Promise<Page> {
  await initBrowser();
  return await context!.newPage();
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");

  if (!address) {
    return new Response("Missing address", { status: 400 });
  }

  try {
    const tempPage = await createPage();
    try {
      const stats = await fetchStatsWithPage(tempPage, address);
      return Response.json(stats);
    } finally {
      await tempPage.close();
    }
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}


interface AddressStatistics {
  registered: boolean;
  solutionsSubmitted: number;
  nightEarned: number;
  error?: string;
}

async function fetchStatsWithPage(page: Page, address: string): Promise<AddressStatistics> {
  if (!address || typeof address !== "string" || !address.startsWith("addr1")) {
    return {
      registered: false,
      solutionsSubmitted: 0,
      nightEarned: 0,
      error: "Invalid address"
    };
  }

  try {
    const url = `https://sm.midnight.gd/api/statistics/${address}`;
    await page.goto(url, { waitUntil: "networkidle" });

    const raw = await page.evaluate(() => document.body.innerText);

    if (!raw || !raw.trim()) {
      return {
        registered: false,
        solutionsSubmitted: 0,
        nightEarned: 0,
        error: "Empty response"
      };
    }

    let data: any;

    try {
      data = JSON.parse(raw);
    } catch {
      return {
        registered: false,
        solutionsSubmitted: 0,
        nightEarned: 0,
        error: "Failed to parse JSON"
      };
    }

    const local = data.local ?? null;

    return {
      registered: !!local,
      solutionsSubmitted: local?.crypto_receipts ?? 0,
      nightEarned: local?.night_allocation ?? 0
    };

  } catch (e: any) {
    return {
      registered: false,
      solutionsSubmitted: 0,
      nightEarned: 0,
      error: e.message ?? "Unknown error"
    };
  }
}

// Helper function to check a single address (creates its own page)
export async function checkAddress(address: string): Promise<AddressStatistics> {
  const workerPage = await createPage();
  try {
    return await fetchStatsWithPage(workerPage, address);
  } finally {
    await workerPage.close();
  }
}

export async function POST(request: NextRequest) {
  try {
    const { addresses } = await request.json();

    if (!Array.isArray(addresses) || addresses.length === 0) {
      return NextResponse.json(
        { error: 'Addresses array is required' },
        { status: 400 }
      );
    }

    // Process addresses sequentially with delays to avoid rate limiting
    // Very conservative approach: one request at a time with delays
    await initBrowser();

    const statistics: AddressStatistics[] = new Array(addresses.length);
    const errors: Array<{ address: string; error: string }> = [];

    const parallelism = Math.min(DEFAULT_PARALLEL, addresses.length);
    let nextIndex = 0;

    const workers = Array.from({ length: parallelism }, async () => {
      const workerPage = await context!.newPage();
      try {
        while (true) {
          const currentIndex = nextIndex++;
          if (currentIndex >= addresses.length) break;

          const address = addresses[currentIndex];
          let retries = 3;
          let stat: AddressStatistics | null = null;

          while (retries > 0 && !stat) {
            try {
              stat = await fetchStatsWithPage(workerPage, address);
              if (stat.error && retries > 1) {
                // If there's an error, retry (might be transient)
                stat = null;
                retries--;
                await new Promise(resolve => setTimeout(resolve, 1000 * (4 - retries)));
              } else {
                break;
              }
            } catch (err: any) {
              retries--;
              if (retries === 0) {
                stat = {
                  registered: false,
                  solutionsSubmitted: 0,
                  nightEarned: 0,
                  error: err.message || 'Failed to fetch statistics',
                };
              } else {
                await new Promise(resolve => setTimeout(resolve, 1000 * (4 - retries)));
              }
            }
          }

          if (!stat) {
            stat = {
              registered: false,
              solutionsSubmitted: 0,
              nightEarned: 0,
              error: 'Failed after retries',
            };
          }

          statistics[currentIndex] = stat;
          if (stat.error) {
            errors.push({ address, error: stat.error });
          }
        }
      } catch (err: any) {
        console.error('[API] Worker error:', err);
        // Mark remaining addresses in this worker's range as failed
        while (true) {
          const currentIndex = nextIndex++;
          if (currentIndex >= addresses.length) break;
          statistics[currentIndex] = {
            registered: false,
            solutionsSubmitted: 0,
            nightEarned: 0,
            error: `Worker error: ${err.message}`,
          };
        }
      } finally {
        await workerPage.close();
      }
    });

    await Promise.all(workers);

    // Calculate totals
    const totals = statistics.reduce(
      (acc, stat) => {
        if (stat.registered && !stat.error) {
          acc.registeredCount++;
          acc.totalSolutions += stat.solutionsSubmitted;
          acc.totalNight += stat.nightEarned;
        }
        return acc;
      },
      { registeredCount: 0, totalSolutions: 0, totalNight: 0 }
    );

    return NextResponse.json({
      success: true,
      statistics,
      totals,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error: any) {
    console.error('[API] Check statistics error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to check statistics' },
      { status: 500 }
    );
  }
}

