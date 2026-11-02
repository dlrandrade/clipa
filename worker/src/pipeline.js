import { probe } from './ffmpeg.js';
import { transcribe } from './transcribe.js';
import { pickClips } from './score.js';
import { renderClip } from './render.js';
import { cfg } from './config.js';

/**
 * Pipeline completo: transcreve -> escolhe momentos -> renderiza clips verticais.
 * `hooks` permite acompanhar o progresso (usado pelo worker e pelo CLI).
 */
export async function processMedia({ mediaPath, workdir, outDir, count = cfg.clipCount, language, transcript: provided, captions = true, hooks = {} }) {
  const info = await probe(mediaPath);
  await hooks.onInfo?.(info);

  await hooks.onStage?.('transcribe', 0);
  const transcript =
    provided ?? (await transcribe(mediaPath, workdir, { language, onProgress: (p) => hooks.onStage?.('transcribe', p) }));
  await hooks.onTranscript?.(transcript);

  await hooks.onStage?.('pick', 0);
  const picks = await pickClips(transcript, info.duration, {
    count,
    onProgress: (p) => hooks.onStage?.('pick', p),
  });
  if (!picks.length) throw new Error('Não encontrei trechos bons o bastante neste vídeo (muito curto ou sem fala).');
  await hooks.onPicks?.(picks);

  const results = [];
  for (let i = 0; i < picks.length; i++) {
    const c = picks[i];
    await hooks.onClipStart?.(c, i, picks.length);
    try {
      const name = `clip_${String(c.rank).padStart(2, '0')}`;
      let r;
      try {
        r = await renderClip({
          video: mediaPath,
          info,
          start: c.start,
          end: c.end,
          words: transcript.words,
          outDir,
          name,
          captions,
        });
      } catch (e) {
        throw new Error(`renderização: ${e.message}`);
      }
      results.push({ ...c, ...r });
      try {
        await hooks.onClipDone?.(c, r, i, picks.length);
      } catch (e) {
        throw new Error(`salvar clipe: ${e.message}`);
      }
    } catch (e) {
      await hooks.onClipFailed?.(c, e, i, picks.length);
    }
  }
  return { info, transcript, clips: results };
}
