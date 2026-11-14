import "@hussmartinez/ui/styles.css";
import "@hussmartinez/video-sdk/styles.css";
import "./example.css";
import type { ReactNode } from "react";

export const metadata = { title: "@hussmartinez/video-sdk in Next.js" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
