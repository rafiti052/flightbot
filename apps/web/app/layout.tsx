import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flightbot",
  description: "Read-only ops view (config + last run + log tail)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
