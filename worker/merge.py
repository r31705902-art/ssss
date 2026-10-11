"""Merge job: collect all chunk transcripts, match speakers across chunks, write final transcript + stats."""
import gzip, json, os
import numpy as np
from common import Swift, Hook, log, fmt_ts

JOB = os.environ['JOB_ID']; P = f'autocut/jobs/{JOB}'
TH = float(os.environ.get('GLOBAL_SPK_SIM') or 0.55)
sw = Swift(); hook = Hook(JOB)


def cluster(items):
    """Average-linkage agglomerative clustering on cosine similarity. items: [(key, emb, dur)]"""
    cl = [{'keys': [k], 'vec': e * d, 'dur': d} for k, e, d in items]
    def sim(a, b):
        va, vb = a['vec'] / (np.linalg.norm(a['vec']) + 1e-9), b['vec'] / (np.linalg.norm(b['vec']) + 1e-9)
        return float(va @ vb)
    while len(cl) > 1:
        best, bi, bj = -2, -1, -1
        for i in range(len(cl)):
            for j in range(i + 1, len(cl)):
                if set(k[0] for k in cl[i]['keys']) & set(k[0] for k in cl[j]['keys']):
                    continue  # same chunk: diarizer already said they differ
                s = sim(cl[i], cl[j])
                if s > best: best, bi, bj = s, i, j
        if best < TH or bi < 0: break
        a, b = cl[bi], cl.pop(bj)
        a['keys'] += b['keys']; a['vec'] = a['vec'] + b['vec']; a['dur'] += b['dur']
    return cl


def main():
    plan = sw.get_json(f'{P}/plan.json')
    chunks, missing = [], []
    for c in plan['chunks']:
        b = None
        try: b = sw.get_bytes(f'{P}/chunks/{c["i"]:03d}/transcript.json.gz')
        except Exception as e: log('missing chunk', c['i'], e)
        if b is None or not sw.head(f'{P}/chunks/{c["i"]:03d}/src.mp4') or not sw.head(f'{P}/chunks/{c["i"]:03d}/proxy.mp4'):
            missing.append(c['i']); continue
        chunks.append(json.loads(gzip.decompress(b)))
    if missing:
        hook.send('merge', stage='error', error=f'missing chunks {missing}', missing=missing)
        sw.put_json(f'{P}/missing.json', missing)
        raise SystemExit(f'missing chunks: {missing}')
    items, noemb = [], []
    for ch in chunks:
        for sid, s in ch['speakers'].items():
            if s.get('emb'): items.append(((ch['i'], int(sid)), np.array(s['emb'], dtype=np.float32), max(s['dur'], 0.1)))
            else: noemb.append((ch['i'], int(sid)))
    cl = cluster(items) if items else []
    cl.sort(key=lambda c: -c['dur'])
    gmap = {}
    for g, c in enumerate(cl, 1):
        for k in c['keys']: gmap[k] = g
    nxt = len(cl) + 1
    for k in noemb: gmap[k] = nxt; nxt += 1
    utts = []
    for ch in chunks:
        for u in ch['utts']:
            u['spk'] = gmap.get((ch['i'], u['spk']), 0); utts.append(u)
    utts.sort(key=lambda u: u['s'])
    talk = {}
    for u in utts: talk[u['spk']] = talk.get(u['spk'], 0) + (u['e'] - u['s'])
    loud, freeze, scenes = [], [], []
    for ch in chunks:
        loud += ch['loud']; freeze += ch['freeze']; scenes += ch['scenes']
    manifest = [{'i': ch['i'], 'start': ch['start'], 'end': ch['end'], 'src_size': ch['src_size'], 'proxy_size': ch['proxy_size']} for ch in chunks]
    tr = {'job': JOB, 'meta': plan['meta'], 'range': [chunks[0]['start'], chunks[-1]['end']], 'chunks': manifest,
          'speakers': {str(k): round(v, 1) for k, v in sorted(talk.items(), key=lambda x: -x[1])},
          'utts': utts, 'loud_start': chunks[0]['start'], 'loud': loud, 'freeze': freeze, 'scenes': scenes, 'lang': chunks[0]['lang']}
    sw.put_verified(f'{P}/transcript.json.gz', gzip.compress(json.dumps(tr, ensure_ascii=False).encode()), 'application/gzip')
    txt = '\n'.join(f'[{fmt_ts(u["s"])}] [{u["spk"]}] {u["text"]}' for u in utts)
    sw.put_bytes(f'{P}/transcript.txt', txt.encode(), 'text/plain; charset=utf-8')
    log(f'merged {len(chunks)} chunks, {len(utts)} utterances, {len(talk)} global speakers: {tr["speakers"]}')
    hook.send('merge', stage='done', utts=len(utts), speakers=tr['speakers'])


if __name__ == '__main__':
    main()
