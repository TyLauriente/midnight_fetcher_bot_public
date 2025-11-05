import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Midnight Fetcher Bot',
  description: 'Windows-based mining application for Midnight',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-900 text-white min-h-screen">
        {children}
      </body>
    </html>
  );
}
