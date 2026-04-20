import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "公車等時線地圖 | Transit Isochrone Map",
  description: "輸入時間限制，即時計算並視覺化桃園公車路網所能抵達的範圍。基於 TDX 開放資料，零後端計算。",
  keywords: ["公車", "等時線", "桃園", "大眾運輸", "isochrone", "transit map"],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;600&family=Inter:wght@300;400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
