import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clipa — vídeos longos em clipes curtos',
  description: 'Cole um link e receba os melhores cortes verticais, com legendas.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#0c0b09' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
