'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Login() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      router.replace('/');
      router.refresh();
    } else {
      setError((await res.json().catch(() => ({}))).error || 'Não foi possível entrar.');
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 28 }}>
          <i /> Clipa
        </div>
        <input
          className="url"
          style={{ width: '100%', marginBottom: 12 }}
          type="password"
          placeholder="Senha"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn" style={{ width: '100%' }} disabled={busy || !password}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        {error && <p className="err">{error}</p>}
      </form>
    </main>
  );
}
