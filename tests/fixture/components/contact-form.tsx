'use client';

import { useState } from 'react';

import { sendMessage } from '../app/contact/actions';

export function ContactForm() {
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [failure, setFailure] = useState('');

  async function send(form: FormData) {
    const field = (name: string) => String(form.get(name));
    const message = { name: field('name'), email: field('email'), message: field('message') };
    const result = await sendMessage(message, field('token'));
    if (result.ok) return setSent(true);
    setErrors(result.errors);
    setFailure(result.message);
  }

  if (sent) return <p className="sent">Thanks</p>;
  return (
    <form action={send}>
      <input name="name" defaultValue="Ada" />
      <input name="email" />
      {errors.email && <p className="email-error">{errors.email}</p>}
      <textarea name="message" defaultValue="Hello" />
      <input name="token" type="hidden" defaultValue="human" />
      {failure && <p className="failure">{failure}</p>}
      <button type="submit">Send</button>
    </form>
  );
}
