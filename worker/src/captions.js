// Gera legendas ASS com destaque palavra por palavra (estilo "karaokê").

const fmtTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

const esc = (s) => s.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\r?\n/g, ' ');

function group(words, { maxWords = 4, maxChars = 22, maxGap = 0.6 } = {}) {
  const groups = [];
  let cur = [];
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
    if (prev && (cur.length >= maxWords || chars > maxChars || w.start - prev.end > maxGap)) flush();
    cur.push(w);
    if (/[.!?…]$/.test(w.w)) flush();
  }
  flush();
  return groups;
}

/**
 * @param words  [{w,start,end}] em segundos absolutos do vídeo
 * @param clipStart/clipEnd  janela do clip (segundos absolutos)
 */
export function buildAss(words, clipStart, clipEnd, { width = 1080, height = 1920, uppercase = true, font = 'Inter' } = {}) {
  const inClip = words
    .filter((w) => w.end > clipStart && w.start < clipEnd)
    .map((w) => ({
      w: esc(uppercase ? w.w.toUpperCase() : w.w),
      start: Math.max(0, w.start - clipStart),
      end: Math.min(clipEnd - clipStart, Math.max(w.end, w.start + 0.05) - clipStart),
    }))
    .filter((w) => w.w);

  const groups = group(inClip);
  const events = groups.map((g, gi) => {
    const start = g[0].start;
    let end = g[g.length - 1].end;
    const next = groups[gi + 1]?.[0];
    if (next && next.start - end < 0.35) end = next.start; // evita piscar entre grupos
    const text = g
      .map((w, i) => {
        const until = g[i + 1] ? g[i + 1].start : end;
        const cs = Math.max(1, Math.round((until - w.start) * 100));
        return `{\\k${cs}}${w.w}`;
      })
      .join(' ');
    return `Dialogue: 0,${fmtTime(start)},${fmtTime(end)},Cap,,0,0,0,,${text}`;
  });

  // PrimaryColour = cor depois de "cantada" (destaque), SecondaryColour = antes.
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${font},84,&H0000E0FF,&H00FFFFFF,&H00101010,&H80000000,1,0,0,0,100,100,0,0,1,7,2,2,60,60,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}
