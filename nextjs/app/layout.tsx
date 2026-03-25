import "@rainbow-me/rainbowkit/styles.css";
import "@/styles/globals.css";
import { Providers } from "../components/Providers";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Toaster } from "sonner";

export const metadata = {
  title: "Soulkey Store",
  description: "Mint verifiable game keys as virtual game cards",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <Toaster position="bottom-right" theme="dark" richColors />
          {children}
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
