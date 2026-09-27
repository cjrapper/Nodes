import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Nodes — 知识库与内置 AI",
  description: "本地优先的知识库笔记软件，内置可自定义模型的 AI 对话，以 prompt 前缀缓存命中为核心优化目标。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="h-full">{children}</body>
    </html>
  );
}
