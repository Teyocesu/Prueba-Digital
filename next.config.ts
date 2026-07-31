import type { NextConfig } from "next";

const isRenderStatic =
  process.env.RENDER === "true" &&
  process.env.RENDER_SERVICE_TYPE === "static";

const nextConfig: NextConfig = isRenderStatic
  ? {
      output: "export",
      images: { unoptimized: true },
    }
  : {};

export default nextConfig;
