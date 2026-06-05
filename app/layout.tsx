import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EcomImgGen",
  description: "登录后生成商品详情图 Prompt，并逐张生成电商详情页图片",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("ecomimggen_theme");document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light")}catch(e){document.documentElement.setAttribute("data-theme","light")}})()`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
