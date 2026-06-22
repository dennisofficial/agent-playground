import type { Metadata } from "next";
import { Space_Grotesk, Geist, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/providers";
import "./globals.css";

// Map the three design fonts onto the CSS variables the tokens reference (§7).
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--f-disp",
});
const ui = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--f-ui",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--f-mono",
});

export const metadata: Metadata = {
  title: "Atlas — Operator Console",
  description: "Operate Atlas: see all threads, talk to a thread's brain, approve plans, watch builds.",
};

// Set data-theme before first paint to avoid a flash on Terminal/Warm reloads.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('atlas-theme');if(t!=='terminal'&&t!=='warm')t='daylight';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="daylight"
      suppressHydrationWarning
      className={`${display.variable} ${ui.variable} ${mono.variable} h-full`}
    >
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
