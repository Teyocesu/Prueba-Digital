import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const publicOrigin =
  process.env.NEXT_PUBLIC_SITE_URL ??
  process.env.RENDER_EXTERNAL_URL ??
  "https://prueba-digital.onrender.com";

export const metadata: Metadata = {
  metadataBase: new URL(publicOrigin),
  title: "Prueba Digital | Hash SHA-256 y manifiesto judicial",
  description:
    "Prepará archivos de audio y capturas para una presentación judicial, con procesamiento local y verificación SHA-256.",
  alternates: {
    canonical: "/",
  },
  applicationName: "Prueba Digital",
  keywords: [
    "SHA-256",
    "prueba digital",
    "integridad de archivos",
    "manifiesto judicial",
  ],
  openGraph: {
    type: "website",
    locale: "es_AR",
    url: "/",
    title: "Prueba Digital | Hash SHA-256 y manifiesto judicial",
    description:
      "Organizá audios y capturas, calculá SHA-256 y generá un paquete judicial sin subir tus archivos.",
    images: [
      {
        url: "/og.png",
        width: 1734,
        height: 907,
        alt: "Prueba Digital: hash SHA-256 y manifiesto judicial",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Prueba Digital",
    description:
      "Preparación local de archivos, hashes SHA-256 y manifiesto judicial.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <head>
        <link rel="icon" href="/favicon.png" />
        <link rel="shortcut icon" href="/favicon.png" />
        <link rel="apple-touch-icon" href="/favicon.png" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
