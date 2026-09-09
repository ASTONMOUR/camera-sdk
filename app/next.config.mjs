/** @type {import('next').NextConfig} */

// Static export, always. Capacitor needs a folder of files to bundle into the
// native app, and the API is a separate FastAPI service either way — so there
// is nothing for a Node server to do here.
const nextConfig = {
  output: "export",
  images: { unoptimized: true },

  // The capture logic lives in ../web/core and is shared verbatim with the
  // zero-build SDK. externalDir lets Next compile files from outside app/,
  // which is what keeps there from being two copies of the quality gates
  // drifting apart from each other.
  experimental: { externalDir: true },
};

export default nextConfig;
