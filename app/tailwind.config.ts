import type { Config } from "tailwindcss";

// The palette mirrors web/style.css so the zero-build UI and the app look like
// one product. Border colours are duplicated in core/constants.js because the
// canvas overlay draws them at runtime and cannot read a Tailwind class.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b1020",
        panel: "#141a2e",
        line: "#232a44",
        ink: "#e8ecf7",
        muted: "#8b95b4",
        ready: "#22c55e",
        close: "#f59e0b",
        invalid: "#ef4444",
        accent: "#6366f1",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
