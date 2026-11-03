// Acorda o worker na nuvem (GitHub Actions). Sem token configurado, não faz nada
// (o worker no Mac, se estiver ligado, continua pegando os jobs normalmente).
export async function wakeWorker(): Promise<void> {
  const token = process.env.CLIPA_GITHUB_TOKEN;
  const repo = process.env.CLIPA_GITHUB_REPO || 'dlrandrade/clipa';
  if (!token) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'clipa',
      },
      body: JSON.stringify({ event_type: 'clipa-job' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error('wakeWorker:', res.status, (await res.text()).slice(0, 300));
  } catch (e) {
    console.error('wakeWorker:', (e as Error).message);
  }
}
