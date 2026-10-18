import { OhnePreview } from '@ohnejs/next/client';

import { Hydrated } from '../components/hydrated';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>
        {children}
        <OhnePreview />
        <Hydrated />
      </body>
    </html>
  );
}
