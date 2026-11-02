'use server';

import { revalidatePath } from 'next/cache';

import { api } from '../lib/api';

export async function signIn(form: FormData) {
  await api.login({ email: String(form.get('email')), password: String(form.get('password')) });
  revalidatePath('/');
}

export async function signOut() {
  await api.logout();
  revalidatePath('/');
}
