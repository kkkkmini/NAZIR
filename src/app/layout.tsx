import type { Metadata } from "next";
import { Anton, Black_Han_Sans, Cormorant_Garamond, Noto_Sans_KR, Noto_Serif_KR } from "next/font/google";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";

const sans = Noto_Sans_KR({ subsets: ["latin"], variable: "--font-noto-sans-kr", display: "swap" });

/* 작품명 서체 A안: 굵은 명조 */
const serif = Noto_Serif_KR({
  subsets: ["latin"],
  weight: ["700", "900"],
  variable: "--font-noto-serif-kr",
  display: "swap",
});
const serifLatin = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["600"],
  variable: "--font-cormorant",
  display: "swap",
});

/* 작품명 서체 B안: 굵은 압축 고딕 — 시안 비교용(임시). 선택 후 쓰지 않는 쪽을 제거한다. */
const gothic = Black_Han_Sans({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-black-han-sans",
  display: "swap",
  preload: false,
});
const gothicLatin = Anton({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-anton",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "뮤지컬 〈나지르〉 | NAZIR",
  description: "뮤지컬 〈나지르〉 공연 소개와 예매 안내",
};

const fontVars = [sans, serif, serifLatin, gothic, gothicLatin].map((f) => f.variable).join(" ");

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" data-title-font="a" className={`${fontVars} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}
