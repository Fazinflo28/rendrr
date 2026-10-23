/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  poweredByHeader: false,
  // The UI is a client-only app ported from ui/rendrr-ui.html; type errors in the ported JS are not checked.
  eslint: { ignoreDuringBuilds: true },
  // The editor uses the shared timeline module and render plan (TypeScript source), so it plays what renders.
  transpilePackages: ["@rendrr/shared"],
};
export default nextConfig;
