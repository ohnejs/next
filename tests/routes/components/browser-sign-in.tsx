'use client';

import { createAPI } from '@ohnejs/client';
import { useRouter } from 'next/navigation';

import type { Routes } from '../ohne';

const api = createAPI<Routes>({ api: '/api' });

export function BrowserSignIn() {
  const router = useRouter();

  async function signIn() {
    const outcome = await api.login({ email: 'ada@example.com', password: 'secret' });
    if (outcome.kind === 'signed-in') router.refresh();
  }

  async function signOut() {
    await api.logout();
    router.refresh();
  }

  return (
    <>
      <button className="browser-in" onClick={signIn}>
        Sign in here
      </button>
      <button className="browser-out" onClick={signOut}>
        Sign out here
      </button>
    </>
  );
}
