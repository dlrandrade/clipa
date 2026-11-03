const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

const transcribeKey = (process.env.TRANSCRIBE_API_KEY || process.env.OPENAI_API_KEY || '').trim();
const isGroq = transcribeKey.startsWith('gsk_');

export const cfg = {
  clipCount: int(process.env.CLIP_COUNT, 10),
  minSec: int(process.env.CLIP_MIN_SEC, 20),
  maxSec: int(process.env.CLIP_MAX_SEC, 75),

  // Transcrição: qualquer API compatível com /audio/transcriptions da OpenAI
  // (OpenAI whisper-1, Groq whisper-large-v3-turbo, etc.)
  // Chave do Groq (começa com "gsk_") já configura endereço e modelo do Groq sozinha.
  transcribe: {
    baseUrl: (process.env.TRANSCRIBE_BASE_URL || (isGroq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1')).replace(/\/$/, ''),
    apiKey: transcribeKey,
    model: process.env.TRANSCRIBE_MODEL || (isGroq ? 'whisper-large-v3-turbo' : 'whisper-1'),
  },

  // Escolha dos melhores momentos
  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  },

  // OpenRouter: alternativa (ou reserva) ao Claude, com rodízio de modelos gratuitos (":free").
  // OPENROUTER_MODELS é opcional: lista separada por vírgula, na ordem de preferência.
  // Sem ela, o worker descobre os modelos gratuitos disponíveis na hora.
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    models: (process.env.OPENROUTER_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxModels: int(process.env.OPENROUTER_MAX_MODELS, 6),
  },

  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  ytdlp: {
    bin: process.env.YTDLP_BIN || 'yt-dlp',
    // ex.: "chrome" para usar os cookies do navegador (ajuda com bloqueios do YouTube)
    cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || '',
    cookiesFile: process.env.YTDLP_COOKIES_FILE || '',
  },

  python: process.env.PYTHON_BIN || 'python3',
  pollMs: int(process.env.POLL_MS, 4000),
};
