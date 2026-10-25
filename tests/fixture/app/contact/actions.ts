'use server';

import type { Creatable } from '../../ohne';

import { ohne } from '../../lib/ohne';

export async function sendMessage(message: Creatable['Messages'], recaptcha: string) {
  return ohne.create('Messages', message, { headers: { 'recaptcha-token': recaptcha } });
}
