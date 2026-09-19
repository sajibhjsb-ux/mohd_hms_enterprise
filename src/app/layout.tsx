import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/hms/shell/theme-provider";
import { PwaRuntime } from "@/components/hms/pwa-runtime";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "MOHD.HMS ENTERPRISE — Smart Facility Maintenance Management",
  description:
    "Enterprise Smart Facility Maintenance Management System: complaints, work orders, equipment, preventive maintenance, IRMS, inventory, quotations, invoices, finance and HR.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "MOHD.HMS",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/brand/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/brand/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // viewport-fit=cover exposes env(safe-area-inset-*) so standalone mode can
  // pad the header/top and the bottom navigation (they already consume them).
  viewportFit: "cover",
  themeColor: "#0c2414",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${poppins.variable} antialiased bg-background text-foreground font-sans`}>
        <ThemeProvider>
          {children}
          <Toaster />
          <PwaRuntime />
        </ThemeProvider>
      </body>
    </html>
  );
}
