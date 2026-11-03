# Clipa

Cole um link (ou envie um arquivo) → a Clipa transcreve, escolhe os melhores momentos, corta em 9:16 com reenquadramento no rosto e legendas palavra por palavra, e entrega os clipes ranqueados por potencial viral.

```
web/      Next.js (tela, login, API)         → roda na Vercel
worker/   Node + FFmpeg + yt-dlp + OpenCV    → roda no seu computador ou num servidor
supabase/ banco (jobs, clips) + buckets      → Supabase
```

Fluxo: o web grava um *job* no Supabase → o worker pega o job → baixa, transcreve (Whisper), escolhe trechos (Claude), renderiza (FFmpeg) → sobe os clipes no Storage → o web mostra.

## Passo a passo

### 1. Banco (Supabase)
1. Crie um projeto novo em supabase.com (ou use um já existente).
2. Em **SQL Editor**, cole o conteúdo de `supabase/migrations/001_init.sql` e clique em **Run**.
3. Em **Project Settings → API**, copie: a URL, a chave `anon` e a chave `service_role`.

> Limite de upload: o plano grátis do Supabase aceita arquivos de até 50 MB. Para vídeos maiores, use links ou aumente o limite em **Storage → Settings**.

### 2. Worker (o "motor" de vídeo)
Precisa de: Node 22+, FFmpeg, Python 3 com `opencv-python-headless` e `yt-dlp`.

```bash
cd worker
npm install
pip install -U yt-dlp opencv-python-headless
cp .env.example .env     # preencha as chaves
npm start
```

Deixe esse terminal aberto: enquanto ele roda, os projetos são processados.

**Quer que ligue sozinho (Mac)?** Pare o `npm start` (Ctrl+C) e rode uma vez:
```bash
npm run autostart      # liga com o Mac e religa se cair
npm run logs           # acompanhar o que ele está fazendo
npm run autostart:off  # desligar o automático
```
O Mac precisa estar ligado e sem dormir para processar. Depois de mudar o `.env`, rode `npm run autostart` de novo para reiniciar.
Para rodar num servidor, há um `Dockerfile` pronto (Railway, Fly.io, Render…).

**YouTube bloqueando?** O YouTube costuma bloquear servidores. Rodar o worker no seu computador (IP residencial) resolve a maioria dos casos; se ainda pedir login, adicione `YTDLP_COOKIES_FROM_BROWSER=chrome` no `.env`.

### 2b. Worker na nuvem, grátis (sem depender do Mac)
O worker também roda nos computadores do GitHub (GitHub Actions). O site avisa o GitHub a cada projeto novo; ele processa a fila e desliga.
Grátis: 2.000 min/mês em repositório privado (ilimitado se for público).

1. No GitHub: repositório → **Settings → Secrets and variables → Actions → New repository secret**. Crie:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (a `sb_secret_…`)
   - `TRANSCRIBE_API_KEY` (chave do Groq `gsk_…` já configura o Groq sozinha)
   - opcionais: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `YTDLP_COOKIES` (conteúdo de um cookies.txt do YouTube)
2. Crie um token: github.com/settings/personal-access-tokens → **Generate new token** → só o repositório `clipa` → permissão **Contents: Read and write**.
3. Na Vercel, adicione a variável `CLIPA_GITHUB_TOKEN` com esse token e faça Redeploy.

Limites: o YouTube costuma bloquear servidores (use `YTDLP_COOKIES` ou envie o arquivo); envio de arquivo no Supabase grátis vai até 50 MB. Acompanhe em **Actions** no GitHub.

### 3. Web
```bash
cd web
npm install
cp .env.example .env.local   # preencha
npm run dev                  # http://localhost:3000
```
Para publicar: importe a pasta `web` na Vercel e cadastre as mesmas variáveis do `.env.example`.

## Escolha dos momentos: Claude ou modelos grátis
- `ANTHROPIC_API_KEY`: melhor qualidade.
- `OPENROUTER_API_KEY`: modelos gratuitos (`:free`) em rodízio. O worker descobre os disponíveis na hora e passa para o próximo se um falhar, devolver lixo ou estourar o limite. Os limites grátis são baixos (~50 pedidos/dia sem crédito) e os prompts podem ser usados pelos provedores desses modelos.
- Sem nenhuma das duas: heurística simples (funciona, mas a escolha é mais fraca).

## Testar sem nenhuma chave
```bash
cd worker
npm run test:quick   # integrações com servidores falsos (rápido)
npm test             # inclui o teste de vídeo completo (leva alguns minutos)
```
O teste completo gera um vídeo sintético e valida corte 9:16, legendas, thumbnail e áudio-only.

Para rodar o pipeline sem banco, num arquivo seu:
```bash
node src/cli.js meu-video.mp4 --out ./saida
```

## Como funciona o enquadramento
- **Rosto único**: corte 9:16 centrado no rosto.
- **Várias pessoas separadas, slides, tela ou b-roll**: mostra o quadro inteiro sobre fundo desfocado (nunca corta conteúdo nem deixa alguém de fora).
- **Só áudio (podcast)**: fundo escuro com forma de onda.

O corte é fixo por clipe (não acompanha o falante trocando de lado). Detector: Haar cascade (frontal), embarcado em `worker/src/models`.

## Limites conhecidos do MVP
- Uma única senha de acesso (`APP_PASSWORD`), sem contas de usuário.
- Sem cobrança/créditos.
- Reenquadramento fixo por clipe; rostos de perfil podem não ser detectados.
- Sem publicação direta nas redes (baixe e poste).

## Uso responsável
Corte apenas conteúdo seu ou com permissão de quem detém os direitos. A Clipa não tenta esconder reposts de plataformas.
