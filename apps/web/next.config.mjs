/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  poweredByHeader: false,
  // The UI is a client-only app ported from ui/rendrr-ui.html; type errors in the ported JS are not checked.
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
