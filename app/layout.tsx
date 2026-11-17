import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = {
  title: "CratePending — Your listening backlog",
  description: "Save recommendations, dig through your backlog, and find something to play.",
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
