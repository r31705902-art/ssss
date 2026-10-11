"""Render one piece: cut keep-ranges out of the source chunks, blur regions, bleep profanity, encode."""
import json, os, time, subprocess
from common import Swift, Hook, log, sh, retry, ffprobe_duration

JOB = os.environ['JOB_ID']; PIECE = int(os.environ['PIECE']); P = f'autocut/jobs/{JOB}'
sw = Swift(); hook = Hook(JOB)
W = os.path.abspath('work'); os.makedirs(W, exist_ok=True)


def overl(a0, a1, b0, b1):
    return max(a0, b0) < min(a1, b1)


def even(x):
    return int(x) // 2 * 2


def main():
    t0 = time.time()
    rp = sw.get_json(f'{P}/render.json')
    pc = rp['pieces'][PIECE]
    name = f'{P}/render/{pc["video"]}/{pc["idx"]:04d}.mp4'
    if sw.head(name) and os.environ.get('FORCE') != '1':
        log('piece exists'); hook.send('piece', piece=PIECE, stage='done', skipped=True); return
    hook.send('piece', piece=PIECE, stage='download')
    chunks = rp['chunks']
    # sub-ranges: split keep ranges at chunk borders
    subs = []
    for s, e in pc['keep']:
        for c in chunks:
            if overl(s, e, c['start'], c['end']):
                subs.append({'c': c['i'], 's': max(s, c['start']), 'e': min(e, c['end']), 'cs': c['start']})
    need = sorted(set(x['c'] for x in subs))
    files = {}
    for ci in need:
        fn = os.path.join(W, f'c{ci:03d}.mp4')
        if not os.path.exists(fn) or os.path.getsize(fn) != next(c['src_size'] for c in chunks if c['i'] == ci):
            sw.download_file(f'{P}/chunks/{ci:03d}/src.mp4', fn)
        files[ci] = fn
    # source geometry
    pr = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', files[need[0]]], capture_output=True, text=True).stdout)['streams'][0]
    SW, SH = pr['width'], pr['height']
    num, den = map(int, pr['r_frame_rate'].split('/')); fps = num / den if den else 30
    enc = rp.get('encode', {})
    th = int(enc.get('height') or 0)
    out_fps = min(fps, float(enc.get('fps') or 60))
    args, fc, vs, as_ = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-stats_period', '30', '-y'], [], [], []
    for k, x in enumerate(subs):
        args += ['-ss', f"{x['s'] - x['cs']:.3f}", '-to', f"{x['e'] - x['cs']:.3f}", '-i', files[x['c']]]
        v = f'[{k}:v:0]setpts=PTS-STARTPTS,fps={out_fps:g}'
        a = f'[{k}:a:0]asetpts=PTS-STARTPTS,aresample=48000'
        # blur boxes active in this sub-range (local time = stream time - x.s)
        blurs = [b for b in rp.get('blur', []) if overl(b['s'], b['e'], x['s'], x['e'])]
        cur = f'v{k}'
        fc.append(v + f'[{cur}]')
        for bi, b in enumerate(blurs):
            y0, x0, y1, x1 = b['box']
            X, Y = even(x0 / 1000 * SW), even(y0 / 1000 * SH)
            BW, BH = max(8, even((x1 - x0) / 1000 * SW)), max(8, even((y1 - y0) / 1000 * SH))
            BW, BH = min(BW, SW - X), min(BH, SH - Y)
            ls, le = max(0, b['s'] - x['s']), min(x['e'], b['e']) - x['s']
            r = max(4, min(BW, BH) // 6)
            eff = f'boxblur={min(r, BW//2-1, BH//2-1)}:3' if b.get('mode', 'blur') == 'blur' else (
                f'scale={max(2, BW//16)}:{max(2, BH//16)},scale={BW}:{BH}:flags=neighbor' if b['mode'] == 'pixelate' else f'drawbox=0:0:{BW}:{BH}:black:fill')
            fc.append(f'[{cur}]split[m{k}_{bi}][c{k}_{bi}];[c{k}_{bi}]crop={BW}:{BH}:{X}:{Y},{eff}[b{k}_{bi}];'
                      f"[m{k}_{bi}][b{k}_{bi}]overlay={X}:{Y}:enable='between(t,{ls:.3f},{le:.3f})'[o{k}_{bi}]")
            cur = f'o{k}_{bi}'
        bl = [(max(0, s - x['s']), min(x['e'], e) - x['s']) for s, e in rp.get('bleep', []) if overl(s, e, x['s'], x['e'])]
        if bl:
            expr = '+'.join(f'between(t,{s:.3f},{e:.3f})' for s, e in bl)
            mode = rp.get('bleep_mode', 'beep')
            a += f",volume=0:enable='{expr}'[am{k}]"
            fc.append(a)
            if mode == 'beep':
                fc.append(f"aevalsrc='0.18*sin(2*PI*1000*t)*({expr})':s=48000:d={x['e'] - x['s']:.3f}[bp{k}];[am{k}][bp{k}]amix=inputs=2:normalize=0:duration=first[a{k}]")
            else:
                fc.append(f'[am{k}]anull[a{k}]')
        else:
            fc.append(a + f'[a{k}]')
        vs.append(f'[{cur}]'); as_.append(f'[a{k}]')
    n = len(subs)
    tail = ''.join(f'{vs[k]}{as_[k]}' for k in range(n)) + f'concat=n={n}:v=1:a=1[cv][ca]'
    fc.append(tail)
    vout = '[cv]'
    if th and th < SH:
        fc.append(f'[cv]scale=-2:{th}[sv]'); vout = '[sv]'
    script = os.path.join(W, 'fc.txt'); open(script, 'w').write(';\n'.join(fc))
    out = os.path.join(W, 'piece.mp4')
    gop = int(round(out_fps * 2))
    args += ['-filter_complex_script', script, '-map', vout, '-map', '[ca]',
             '-c:v', 'libx264', '-preset', enc.get('preset', 'veryfast'), '-crf', str(enc.get('crf', 21)), '-pix_fmt', 'yuv420p',
             '-g', str(gop), '-keyint_min', str(gop), '-sc_threshold', '0', '-profile:v', 'high',
             '-c:a', 'aac', '-b:a', enc.get('abitrate', '160k'), '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out]
    hook.send('piece', piece=PIECE, stage='encode')
    log(f'piece {PIECE}: video {pc["video"]} #{pc["idx"]}: {n} sub-ranges, {sum(x["e"]-x["s"] for x in subs):.0f}s, src {SW}x{SH}@{fps:.2f}')
    sh(args)
    d = ffprobe_duration(out)
    sw.upload_file(name, out, 'video/mp4', meta={'duration': f'{d:.3f}'})
    log(f'piece done in {time.time()-t0:.0f}s, {d:.1f}s output')
    hook.send('piece', piece=PIECE, stage='done', elapsed=round(time.time() - t0), duration=d)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        hook.send('piece', piece=PIECE, stage='error', error=str(e)[:400]); raise
