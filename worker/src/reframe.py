#!/usr/bin/env python3
"""
Decide como reenquadrar um trecho horizontal para 9:16.

Uso: reframe.py <video> <start_s> <end_s>
Saída (JSON no stdout):
  {"mode": "fill", "cropX": 420, "cropW": 608, "faceRatio": 0.9}   -> corta centrado nos rostos
  {"mode": "blur", ...}                                            -> mostra o quadro inteiro sobre fundo desfocado

Regras:
  - poucos rostos detectados (slides, tela, b-roll)  -> blur (nunca corta conteúdo)
  - rostos muito separados (mais de uma pessoa em lados opostos) -> blur (todos ficam em quadro)
  - caso contrário -> corte fixo 9:16 centrado na mediana dos rostos
"""
import json
import os
import statistics
import sys


def out(obj):
    print(json.dumps(obj))
    sys.exit(0)


def load_cascade(cv2):
    names = ["haarcascade_frontalface_default.xml"]
    # modelo embarcado no projeto (OpenCV 5 não traz os cascades)
    bases = [os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")]
    try:
        bases.append(cv2.data.haarcascades)
    except Exception:
        pass
    bases.append(os.path.join(os.path.dirname(cv2.__file__), "data"))
    for b in bases:
        for n in names:
            p = os.path.join(b, n)
            if os.path.exists(p):
                c = cv2.CascadeClassifier(p)
                if not c.empty():
                    return c
    return None


def main():
    video, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    try:
        import cv2
    except Exception:
        out({"mode": "blur", "reason": "opencv-missing"})

    cap = cv2.VideoCapture(video)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if not W or not H:
        out({"mode": "blur", "reason": "no-video"})
    if W / H <= 9 / 16 + 0.01:
        out({"mode": "blur", "reason": "already-portrait"})

    cw = int(H * 9 / 16) // 2 * 2
    cascade = load_cascade(cv2)
    if cascade is None:
        out({"mode": "blur", "reason": "no-detector"})

    # amostragem enxuta: ~24 quadros por clipe, em resolução baixa (rápido mesmo em vídeos longos)
    scale = min(1.0, 400.0 / W)
    step = max(1.0, (end - start) / 24.0)
    unions = []
    samples = 0
    t = start
    while t < end:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        t += step
        if not ok:
            continue
        samples += 1
        small = cv2.resize(frame, None, fx=scale, fy=scale) if scale < 1 else frame
        gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
        min_side = max(20, int(small.shape[0] * 0.09))
        faces = cascade.detectMultiScale(gray, 1.1, 5, minSize=(min_side, min_side))
        if len(faces) == 0:
            continue
        xs0 = [x / scale for (x, y, w, h) in faces]
        xs1 = [(x + w) / scale for (x, y, w, h) in faces]
        unions.append((min(xs0), max(xs1)))
    cap.release()

    if samples == 0:
        out({"mode": "blur", "reason": "no-samples"})
    ratio = len(unions) / samples
    if ratio < 0.2:
        out({"mode": "blur", "reason": "few-faces", "faceRatio": round(ratio, 2)})

    spreads = sorted(b - a for a, b in unions)
    p90 = spreads[min(len(spreads) - 1, int(len(spreads) * 0.9))]
    if p90 > cw * 0.92:
        out({"mode": "blur", "reason": "wide-spread", "faceRatio": round(ratio, 2)})

    center = statistics.median((a + b) / 2 for a, b in unions)
    x = int(round(center - cw / 2))
    x = max(0, min(W - cw, x)) // 2 * 2
    out({"mode": "fill", "cropX": x, "cropW": cw, "faceRatio": round(ratio, 2)})


if __name__ == "__main__":
    main()
