"""Plan job: resolve the stream URL, split it into N chunks, write plan.json to Blomp, emit GH matrix."""
import json, os, re, sys, subprocess, urllib.parse
import requests
from common import Swift, Hook, log, retry

JOB = os.environ['JOB_ID']; URL = os.environ['SRC_URL']
N = max(1, min(64, int(os.environ.get('WORKERS') or 25)))
Q = int(os.environ.get('QUALITY') or 1080)
R0 = float(os.environ.get('RANGE_START') or 0); R1 = float(os.environ.get('RANGE_END') or 0)
sw = Swift(); hook = Hook(JOB)


def ytdlp_json(url):
    def go():
        p = subprocess.run(['yt-dlp', '-J', '--no-warnings', '--no-playlist', url], capture_output=True, text=True, timeout=300)
        if p.returncode: raise RuntimeError(p.stderr[-500:])
        return json.loads(p.stdout)
    return retry(go, 'yt-dlp -J', tries=6)


def parse_m3u8(url):
    txt = retry(lambda: requests.get(url, timeout=60).text, 'm3u8 ' + url, tries=8)
    segs, dur, t, mp = [], None, 0.0, None
    for line in txt.splitlines():
        line = line.strip()
        if line.startswith('#EXT-X-MAP:'):
            m = re.search(r'URI="([^"]+)"', line); mp = urllib.parse.urljoin(url, m.group(1)) if m else None
        elif line.startswith('#EXTINF:'):
            dur = float(line[8:].split(',')[0])
        elif line and not line.startswith('#'):
            sg = {'u': urllib.parse.urljoin(url, line), 't': round(t, 3), 'd': dur or 0}
            if mp: sg['m'] = mp
            segs.append(sg)
            t += dur or 0; dur = None
    return segs


def pick_formats(info):
    fmts = [f for f in info.get('formats', []) if f.get('vcodec') not in (None, 'none') and f.get('url')]
    if not fmts and info.get('url'): fmts = [info]
    def key(f): return ((f.get('height') or 0), (f.get('fps') or 0), (f.get('tbr') or 0))
    ok = [f for f in fmts if (f.get('height') or 0) <= Q] or fmts
    main = max(ok, key=key)
    prox = [f for f in fmts if 300 <= (f.get('height') or 0) <= 480 and f.get('protocol', '').startswith('m3u8')]
    prox = min(prox, key=key) if prox else None
    audio = [f for f in info.get('formats', []) if f.get('vcodec') == 'none' and f.get('acodec') not in (None, 'none')]
    return main, prox, (max(audio, key=lambda f: f.get('tbr') or 0) if audio else None)


def split_even(segs, n):
    total = sum(s['d'] for s in segs) or 1
    n = max(1, min(n, len(segs)))
    groups, acc = [[] for _ in range(n)], 0.0
    for s in segs:
        groups[min(n - 1, int((acc + s['d'] / 2) / total * n))].append(s); acc += s['d']
    return [g for g in groups if g]


def main():
    hook.send('plan', stage='resolving')
    info = ytdlp_json(URL)
    main_f, prox_f, _ = pick_formats(info)
    meta = {k: info.get(k) for k in ('id', 'title', 'uploader', 'uploader_id', 'channel', 'timestamp', 'upload_date', 'duration', 'description', 'thumbnail', 'webpage_url', 'extractor_key', 'chapters', 'categories', 'tags', 'view_count')}
    log('source:', meta['title'], meta['duration'], 'format', main_f.get('format_id'), main_f.get('protocol'))
    plan = {'job': JOB, 'url': URL, 'meta': meta, 'workers': N, 'quality': Q,
            'format': {k: main_f.get(k) for k in ('format_id', 'height', 'width', 'fps', 'tbr', 'protocol', 'url')},
            'proxy_format': prox_f and {k: prox_f.get(k) for k in ('format_id', 'height', 'width', 'fps', 'protocol', 'url')}}
    chunks = []
    if (main_f.get('protocol') or '').startswith('m3u8'):
        segs = parse_m3u8(main_f['url'])
        psegs = parse_m3u8(prox_f['url']) if prox_f else []
        same = len(psegs) == len(segs) and all(abs(a['d'] - b['d']) < 0.05 for a, b in zip(segs, psegs))
        if not same and psegs: log('proxy playlist differs, proxy will be encoded'); psegs = []
        for i, s in enumerate(segs):
            s['i'] = i
            if psegs:
                s['p'] = psegs[i]['u']
                if psegs[i].get('m'): s['pm'] = psegs[i]['m']
        end_all = segs[-1]['t'] + segs[-1]['d'] if segs else 0
        lo, hi = R0, (R1 if R1 > 0 else end_all)
        sel = [s for s in segs if s['t'] + s['d'] > lo and s['t'] < hi]
        for gi, g in enumerate(split_even(sel, N)):
            chunks.append({'i': gi, 'mode': 'hls', 'start': g[0]['t'], 'end': round(g[-1]['t'] + g[-1]['d'], 3), 'segs': g})
        plan['mode'] = 'hls'
    else:
        dur = float(info.get('duration') or 0)
        if not dur: raise SystemExit('unknown duration and not HLS: cannot split')
        lo, hi = R0, (R1 if R1 > 0 else dur)
        step = (hi - lo) / N
        for gi in range(N):
            chunks.append({'i': gi, 'mode': 'sections', 'start': round(lo + gi * step, 3), 'end': round(lo + (gi + 1) * step, 3)})
        plan['mode'] = 'sections'
    plan['chunks'] = chunks
    plan['range'] = [chunks[0]['start'], chunks[-1]['end']]
    sw.put_json(f'autocut/jobs/{JOB}/plan.json', plan)
    log(f'{len(chunks)} chunks, range {plan["range"]}')
    hook.send('plan', stage='planned', chunks=len(chunks), meta=meta, range=plan['range'], format=plan['format'].get('format_id'))
    with open(os.environ.get('GITHUB_OUTPUT', '/dev/stdout'), 'a') as f:
        f.write('matrix=' + json.dumps({'i': [c['i'] for c in chunks]}) + '\n')


if __name__ == '__main__':
    main()
