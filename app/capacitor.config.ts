import type { CapacitorConfig } from "@capacitor/cli";

// `next build` with output:"export" writes to out/, which is what Capacitor
// copies into the native app. Run `npm run sync:ios` / `sync:android`.
const config: CapacitorConfig = {
  appId: "in.productcapture.app",
  appName: "Product Capture",
  webDir: "out",

  // The native shell has no FastAPI in it. Point the app at the compliance
  // service with NEXT_PUBLIC_API_BASE at build time; on device, localhost is
  // the phone, so this must be a reachable host.
  server: {
    androidScheme: "https",
  },

  plugins: {
    // The web camera path (getUserMedia) works inside the Capacitor WebView on
    // both platforms, so the SDK core runs unchanged. These permissions are
    // still required in the native manifests — see ios/ and android/ after the
    // first `cap add`.
    Camera: {
      permissions: ["camera"],
    },
  },

  ios: {
    contentInset: "always",
  },
};

export default config;
