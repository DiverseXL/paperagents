import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Inter } from "next/font/google";
import ThemeSync from "@/components/ThemeSync";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "PaperAgents — The Citation Verification Desk",
  description:
    "PaperAgents puts every citation in a research paper on the record: four agents — Retriever, Extractor, Verifier, Synthesizer — gather the sources, isolate the claims, check each against the source text, and file a verdict.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

/*
 * Runs before hydration so the first paint already wears the right edition:
 * stored preference wins, otherwise the OS preference. Sets data-theme on
 * <html>, which the CSS variables in globals.css key off.
 */
const themeScript = `(function(){try{var k="paperagents-theme";var s=localStorage.getItem(k);var t=s==="dark"||(!s&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${inter.variable} ${plexMono.variable} h-full antialiased`}
      /* data-theme is set on this element by the inline script — React
         must not flag the attribute difference during hydration. */
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Follows OS theme changes live until the user picks an edition. */}
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
