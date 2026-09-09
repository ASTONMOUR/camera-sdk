import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Product Capture",
  description:
    "Guided capture and Legal Metrology compliance checking for packaged food labels.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The camera screen is full-bleed; without this the notch crops the overlay.
  viewportFit: "cover",
  themeColor: "#0b1020",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
