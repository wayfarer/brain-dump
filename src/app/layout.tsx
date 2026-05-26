import type { ReactNode } from "react";

export const metadata = {
  title: "Brain Dump",
  description: "A reverse chatbot that interviews you.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#000",
          color: "#e8e8e8",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
        }}
      >
        {children}
      </body>
    </html>
  );
}
