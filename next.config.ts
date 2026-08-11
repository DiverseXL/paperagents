import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * pdf-parse (pdfjs-dist) dynamically loads its web worker at runtime —
   * bundling breaks that. Load it natively from node_modules instead.
   */
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
