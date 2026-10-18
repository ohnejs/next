'use client';

import { useEffect } from 'react';

// The browser tests click only once the page has hydrated and its links are wired.
export function Hydrated() {
  useEffect(() => {
    document.body.dataset.hydrated = '';
  }, []);
  return null;
}
