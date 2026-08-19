import type { MetadataRoute } from "next";
import { APP_DESC_CN, APP_NAME, APP_TAGLINE } from "@/lib/ui-text";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: APP_NAME,
    short_name: APP_NAME,
    description: `${APP_DESC_CN} · ${APP_TAGLINE}`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#08141f",
    theme_color: "#00cd99",
    lang: "zh-CN",
    categories: ["productivity", "utilities"],
    icons: [
      {
        src: "/icons/pwa-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/pwa-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
