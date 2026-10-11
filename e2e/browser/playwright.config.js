import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    browserName: "chromium",
    // Bundled Chromium works on Linux CI. On macOS the application firewall
    // can block WebRTC to the unsigned headless shell; use
    // PLAYWRIGHT_CHANNEL=chrome there.
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        // Expose real host candidates so two local viewers can connect
        // without an mDNS responder (absent on CI runners).
        "--disable-features=WebRtcHideLocalIpsWithMdns",
      ],
    },
  },
});
