import { Providers } from '@/providers';
import type { Metadata, Viewport } from 'next';
import { Geist, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import './globals.css';

// Map the three design fonts onto the CSS variables the tokens reference (§7).
const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--f-disp',
});
const ui = Geist({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--f-ui',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--f-mono',
});

export const metadata: Metadata = {
  title: 'Atlas — Operator Console',
  description:
    "Operate Atlas: see all threads, talk to a thread's brain, approve plans, watch builds.",
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${display.variable} ${ui.variable} ${mono.variable} h-full`}
    >
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
