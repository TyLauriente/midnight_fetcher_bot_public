import { NextResponse } from 'next/server';

/**
 * Dev Fee API - Returns developer wallet address for fee mining
 * Fetches from external API to keep wallet address dynamic and secure
 */
export async function GET() {
  try {
    // TODO: Replace with your actual API endpoint
    const DEV_FEE_API = process.env.DEV_FEE_API_URL || 'https://api.example.com/devfee';

    // Fetch dev wallet address from external API
    const response = await fetch(DEV_FEE_API, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      // Cache for 1 hour to reduce API calls
      next: { revalidate: 3600 }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch dev fee address');
    }

    const data = await response.json();
    const devWalletAddress = data.address || data.devWalletAddress;

    if (!devWalletAddress) {
      // If no dev wallet available, disable fees
      return NextResponse.json({
        devWalletAddress: null,
        feeEnabled: false
      });
    }

    return NextResponse.json({
      devWalletAddress,
      feeEnabled: true,
      feeRate: '1/hour', // 1 mining attempt per hour
    });
  } catch (error: any) {
    console.error('[DevFee] Failed to fetch dev wallet address:', error.message);

    // Fallback: disable dev fee if API is unavailable
    return NextResponse.json({
      devWalletAddress: null,
      feeEnabled: false,
      error: 'Dev fee API unavailable'
    });
  }
}
