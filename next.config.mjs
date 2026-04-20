/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";
const BASE = isProd ? "/BaseTransitTW" : "";

const nextConfig = {
  output: "export",
  basePath: BASE,
  assetPrefix: isProd ? "/BaseTransitTW/" : "",
  env: {
    NEXT_PUBLIC_BASE_PATH: BASE,
  },
  // Web Worker support
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    return config;
  },
};

export default nextConfig;
