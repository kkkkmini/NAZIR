import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NAZIR",
  description: "뮤지컬·연극 티켓 예매",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
