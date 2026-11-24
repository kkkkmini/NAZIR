import type { Metadata } from "next";
import { PreLaunchNotice, SiteFooter, SiteHeader } from "@/components/site/SiteChrome";
import "./globals.css";

export const metadata: Metadata = {
  title: "NAZIR",
  description: "뮤지컬·연극 티켓 예매",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <PreLaunchNotice />
        <SiteHeader />
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
