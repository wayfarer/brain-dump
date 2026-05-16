import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "brain-dump",
  description: "Next.js app scaffold with Tailwind, UI primitives, and tests.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
