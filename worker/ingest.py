"""Ingest worker (one of N): download own chunk, make proxy, analyse audio/video, transcribe + diarize, upload."""
import gzip, json, os, sys, time, subprocess, concurrent.futures as cf, re
import numpy as np, requests
from common import Swift, Hook, log, retry, sh, ffprobe_duration

JOB = os.environ['JOB_ID']; IDX = int(os.environ['CHUNK'])
WM = os.environ.get('WHISPER_MODEL') or 'large-v3-turbo'
LANG = os.environ.get('LANGUAGE') or 'ru'
MODELS = os.environ.get('MODELS_DIR', os.path.expanduser('~/models'))
sw = Swift(); hook = Hook(JOB)
P = f'autocut/jobs/{JOB}'
W = os.path.abspath('work'); os.makedirs(W, exist_ok=True)


def prog(stage, pct=None, force=False, **kw):
    hook.send('chunk', force=force, chunk=IDX, stage=stage, pct=pct, **kw)


def _muted(u):
    base, dot, ext = u.rpartition('.')
    return f'{base}-muted.{ext}' if dot and not base.endswith('-muted') else None


def dl_segments(segs, key, out):
    """Download HLS segments (TS or fMP4 with EXT-X-MAP) in parallel and remux into one faststart mp4."""
    mkey = 'm' if key == 'u' else 'pm'
    d = os.path.join(W, key); os.makedirs(d, exist_ok=True)
    done = [0]
    s = requests.Session()
    def get(url):
        r = s.get(url, timeout=120)
        if r.status_code in (403, 404) and _muted(url):
            r2 = s.get(_muted(url), timeout=120)
            if r2.status_code == 200: return r2.content
        if r.status_code != 200: raise RuntimeError(f'http {r.status_code} {url[-40:]}')
        return r.content
    def one(k_seg):
        k, seg = k_seg
        fn = os.path.join(d, f'{k:05d}.seg')
        if not (os.path.exists(fn) and os.path.getsize(fn) > 0):
            b = retry(lambda: get(seg[key]), f'seg {k}', tries=10)
            open(fn + '.part', 'wb').write(b); os.replace(fn + '.part', fn)
        done[0] += 1
        if key == 'u': prog('download', round(100 * done[0] / len(segs)))
        return fn
    with cf.ThreadPoolExecutor(8) as ex:
        files = list(ex.map(one, enumerate(segs)))
    # group consecutive segments sharing the same init (map) segment
    groups = []
    for seg, fn in zip(segs, files):
        m = seg.get(mkey)
        if not groups or groups[-1][0] != m: groups.append([m, []])
        groups[-1][1].append(fn)
    parts = []
    for gi, (m, fns) in enumerate(groups):
        raw = os.path.join(W, f'{key}_{gi}.raw')
        with open(raw, 'wb') as o:
            if m: o.write(retry(lambda: get(m), 'init seg'))
            for fn in fns:
                with open(fn, 'rb') as i: o.write(i.read())
                os.remove(fn)
        part = os.path.join(W, f'{key}_{gi}.mp4') if len(groups) > 1 else out
        sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy',
            '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', part])
        os.remove(raw); parts.append(part)
    if len(parts) > 1:
        lst = os.path.join(W, key + '.txt')
        open(lst, 'w').write(''.join(f"file '{p}'\n" for p in parts))
        sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', '-movflags', '+faststart', out])
        for p in parts: os.remove(p)


def download(plan, ch):
    src = os.path.join(W, 'src.mp4'); prox = os.path.join(W, 'proxy.mp4')
    if ch['mode'] == 'hls':
        dl_segments(ch['segs'], 'u', src)
        if all('p' in s for s in ch['segs']):
            try: dl_segments(ch['segs'], 'p', prox)
            except Exception as e: log('proxy dl failed, encoding', e); prox_encode(src, prox)
        else: prox_encode(src, prox)
    else:
        fmt = plan['format']['format_id']
        dur = ch['end'] - ch['start']
        sh(['yt-dlp', '-f', f'{fmt}+bestaudio/{fmt}/best', '--no-warnings', '--download-sections', f"*{ch['start']}-{ch['end']}",
            '--merge-output-format', 'mp4', '-o', os.path.join(W, 'dl.%(ext)s'), plan['url']])
        f = [x for x in os.listdir(W) if x.startswith('dl.')][0]
        sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', os.path.join(W, f), '-c', 'copy', '-movflags', '+faststart', '-t', str(dur), src])
        prox_encode(src, prox)
    return src, prox


def prox_encode(src, prox):
    sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', 'scale=-2:360,fps=30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
        '-g', '60', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', prox])


def video_stats(prox, off):
    """freeze (static picture) intervals + scene cuts, from the light proxy."""
    p = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', prox, '-an', '-vf',
                        "fps=2,scale=192:-2,freezedetect=n=-50dB:d=15,select='gt(scene,0.4)',showinfo", '-f', 'null', '-'],
                       capture_output=True, text=True)
    err = p.stderr
    fs = [float(x) for x in re.findall(r'freeze_start: ([\d.]+)', err)]
    fe = [float(x) for x in re.findall(r'freeze_end: ([\d.]+)', err)]
    dur = ffprobe_duration(prox)
    freeze = [[round(a + off, 1), round((fe[k] if k < len(fe) else dur) + off, 1)] for k, a in enumerate(fs)]
    scenes = [round(float(x) + off, 1) for x in re.findall(r'pts_time:([\d.]+)', err)]
    return freeze, scenes[:2000]


def audio_stats(wav):
    import soundfile as sf
    a, sr = sf.read(wav, dtype='float32')
    n = len(a) // sr
    x = a[:n * sr].reshape(n, sr) if n else np.zeros((0, sr))
    rms = np.sqrt((x ** 2).mean(axis=1) + 1e-12)
    return [int(v) for v in np.clip(20 * np.log10(rms), -90, 0)], a, sr


def ensure_models():
    os.makedirs(MODELS, exist_ok=True)
    seg = os.path.join(MODELS, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx')
    emb = os.path.join(MODELS, 'wespeaker_resnet34.onnx')
    if not os.path.exists(seg):
        sh(f'cd {MODELS} && curl -sSL --retry 5 -o seg.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 && tar xjf seg.tar.bz2 && rm seg.tar.bz2')
    if not os.path.exists(emb):
        sh(f'curl -sSL --retry 5 -o {emb} https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx')
    return seg, emb


def diarize(a, sr):
    import sherpa_onnx
    seg, emb = ensure_models()
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg), num_threads=4),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=4),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=float(os.environ.get('DIAR_THRESHOLD') or 0.5)),
        min_duration_on=0.3, min_duration_off=0.5)
    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    res = sd.process(a).sort_by_start_time()
    turns = [(r.start, r.end, int(r.speaker)) for r in res]
    # centroid embedding per local speaker (for cross-chunk matching in merge)
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=4))
    spk = {}
    for sid in sorted(set(t[2] for t in turns)):
        ts = sorted([t for t in turns if t[2] == sid], key=lambda t: t[0] - t[1])  # longest first
        vecs, used = [], 0.0
        for s0, s1, _ in ts:
            if s1 - s0 < 1.0 or used > 90: continue
            st = ex.create_stream(); st.accept_waveform(sr, a[int(s0 * sr):int(s1 * sr)]); st.input_finished()
            if ex.is_ready(st):
                v = np.array(ex.compute(st)); vecs.append(v / (np.linalg.norm(v) + 1e-9) * (s1 - s0)); used += s1 - s0
        dur = sum(t[1] - t[0] for t in turns if t[2] == sid)
        c = np.sum(vecs, axis=0) if vecs else None
        spk[sid] = {'dur': round(dur, 1), 'emb': ([round(float(x), 5) for x in c / (np.linalg.norm(c) + 1e-9)] if c is not None else None)}
    return turns, spk


def transcribe(audio, dur):
    from faster_whisper import WhisperModel
    m = WhisperModel(WM, device='cpu', compute_type='int8', cpu_threads=os.cpu_count() or 4)
    segs, info = m.transcribe(audio, language=None if LANG == 'auto' else LANG, vad_filter=True, word_timestamps=True,
                              beam_size=int(os.environ.get('BEAM') or 1), condition_on_previous_text=False,
                              vad_parameters={'min_silence_duration_ms': 700})
    words = []
    for s in segs:
        for w in (s.words or []):
            words.append([round(w.start, 2), round(w.end, 2), w.word, round(w.probability, 2)])
        prog('transcribe', round(100 * s.end / max(dur, 1)))
    return words, info.language


def build_utts(words, turns, off):
    """Assign every word a local speaker by overlap, then group into utterances."""
    def spk_at(t0, t1):
        best, bo = -1, 0.0
        for s0, s1, sid in turns:
            if s1 < t0: continue
            if s0 > t1: break
            o = min(t1, s1) - max(t0, s0)
            if o > bo: best, bo = sid, o
        if best < 0 and turns:  # nearest turn
            mid = (t0 + t1) / 2
            best = min(turns, key=lambda t: min(abs(t[0] - mid), abs(t[1] - mid)))[2]
        return best
    utts, cur = [], None
    for w in words:
        sid = spk_at(w[0], w[1])
        gap = cur and (w[0] - cur['e'] > 1.5)
        long = cur and (cur['e'] - cur['s'] > 30) and w[2][:1] == ' ' and cur['w'][-1][2].rstrip()[-1:] in '.?!…'
        if not cur or sid != cur['spk'] or gap or long or (cur['e'] - cur['s'] > 60):
            if cur: utts.append(cur)
            cur = {'s': w[0], 'e': w[1], 'spk': sid, 'w': []}
        cur['w'].append(w); cur['e'] = w[1]
    if cur: utts.append(cur)
    out = []
    for u in utts:
        out.append({'s': round(u['s'] + off, 2), 'e': round(u['e'] + off, 2), 'spk': u['spk'],
                    'text': ''.join(x[2] for x in u['w']).strip(),
                    'words': [[round(x[0] + off, 2), round(x[1] + off, 2), x[2].strip(), x[3]] for x in u['w']]})
    return out


def main():
    t0 = time.time()
    plan = sw.get_json(f'{P}/plan.json')
    ch = plan['chunks'][IDX]; off = ch['start']
    done = sw.head(f'{P}/chunks/{IDX:03d}/transcript.json.gz')
    if done and os.environ.get('FORCE') != '1':
        log('chunk already done, skipping'); prog('done', 100, force=True, skipped=True); return
    prog('download', 0, force=True)
    src, prox = download(plan, ch)
    dur = ffprobe_duration(src)
    log(f'chunk {IDX}: {ch["start"]}-{ch["end"]} dur {dur:.1f}s src {os.path.getsize(src)/1e6:.0f}MB')
    prog('upload', None, force=True)
    with cf.ThreadPoolExecutor(2) as ex:
        up = [ex.submit(sw.upload_file, f'{P}/chunks/{IDX:03d}/src.mp4', src, 'video/mp4'),
              ex.submit(sw.upload_file, f'{P}/chunks/{IDX:03d}/proxy.mp4', prox, 'video/mp4')]
        wav = os.path.join(W, 'a.wav')
        sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav])
        prog('analyse', None, force=True)
        loud, a, sr = audio_stats(wav)
        freeze, scenes = video_stats(prox, off)
        prog('diarize', None, force=True)
        try:
            turns, spk = diarize(a, sr)
        except Exception as e:
            log('diarization failed:', e); turns, spk = [], {}
        prog('transcribe', 0, force=True)
        words, lang = transcribe(a, dur)
        utts = build_utts(words, turns, off)
        for f in up: f.result()
    res = {'i': IDX, 'start': off, 'end': round(off + dur, 3), 'plan_end': ch['end'], 'lang': lang, 'model': WM,
           'utts': utts, 'speakers': {str(k): v for k, v in spk.items()}, 'turns': [[round(a0 + off, 2), round(a1 + off, 2), s] for a0, a1, s in turns],
           'loud': loud, 'freeze': freeze, 'scenes': scenes,
           'src_size': os.path.getsize(src), 'proxy_size': os.path.getsize(prox), 'elapsed': round(time.time() - t0)}
    sw.put_bytes(f'{P}/chunks/{IDX:03d}/transcript.json.gz', gzip.compress(json.dumps(res, ensure_ascii=False).encode()), 'application/gzip')
    log(f'done in {time.time()-t0:.0f}s: {len(utts)} utterances, {len(spk)} local speakers')
    prog('done', 100, force=True, utts=len(utts), speakers=len(spk), elapsed=res['elapsed'])


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        prog('error', None, force=True, error=str(e)[:500]); raise
