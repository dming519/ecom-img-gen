import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EcomImgGen",
  description: "登录后生成商品详情图文案，并逐张生成电商详情页图片",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
