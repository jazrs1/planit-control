import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PlanIT Control",
  description: "Real-time job-site safety for utility field crews",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
