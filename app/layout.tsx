import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { AuthProvider } from '@/lib/auth-context';
import AuthGate from '@/components/auth-gate';
import Navbar from '@/components/navbar';
import Footer from '@/components/footer';
import { Toaster } from 'sonner';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Seva - Trusted Service Providers at Your Doorstep',
  description: "India's #1 service marketplace. Connect with verified electricians, plumbers, home cooks, caretakers, and more at your doorstep.",
  keywords: 'home services, electrician, plumber, cook, tiffin, caretaker, India, marketplace',
  openGraph: {
    title: 'Seva - Trusted Service Providers',
    description: "India's #1 service marketplace",
    images: [{ url: 'https://bolt.new/static/og_default.png' }],
  },
  twitter: {
    card: 'summary_large_image',
    images: [{ url: 'https://bolt.new/static/og_default.png' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className={`${inter.className} bg-[#0d0d0d] text-white min-h-screen`}>
        <AuthProvider>
          <Navbar />
          {/* Every page renders through here, so every page needs a session — see auth-gate.tsx
              for the public list. Navbar and Footer sit OUTSIDE it on purpose: they are the
              chrome the sign-in page itself is drawn in, and they already branch on `user`. */}
          <AuthGate>
            <main>{children}</main>
          </AuthGate>
          <Footer />
          <Toaster
            position="top-right"
            toastOptions={{
              style: {
                background: '#1a1a1a',
                border: '1px solid #2a2a2a',
                color: '#fff',
              },
            }}
          />
        </AuthProvider>
      </body>
    </html>
  );
}
