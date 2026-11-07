/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  poweredByHeader: false,
  // The UI is a client-only app ported from ui/rendrr-ui.html; type errors in the ported JS are not checked.
  eslint: { ignoreDuringBuilds: true },
  // The editor uses the shared timeline module and render plan (TypeScript source), so it plays what renders.
  transpilePackages: ["@rendrr/shared"],
  // app.rendrr.live/download: the public page to get Rendrr for Mac (served by the API, which holds the installers).
  async redirects() {
    return [{ source: "/download", destination: "https://api.rendrr.live/download/mac", permanent: false }];
  },
};
export default nextConfig;
