"""Assemble rendered pieces into final videos (stream copy), embed chapters, make thumbnails, upload + manifest."""
import json, os, time, subprocess
import sys
from common import Swift, Hook, log, sh, crc32_file, ffprobe_duration, NotFound
HERE = os.path.dirname(os.path.abspath(__file__))

JOB = os.environ['JOB_ID']; P = f'autocut/jobs/{JOB}'
sw = Swift(); hook = Hook(JOB)
W = os.path.abspath('work'); os.makedirs(W, exist_ok=True)


def esc(s):
    return s.replace('\\', '\\\\').replace('=', '\\=').replace(';', '\\;').replace('#', '\\#').replace('\n', ' ')


def main():
    rp = sw.get_json(f'{P}/render.json')
    only = [x for x in (os.environ.get('VIDEOS') or '').split(',') if x]
    man = sw.get_json(f'{P}/out/manifest.json', {}) or {}
    failed = []
    for v in rp['videos']:
        if only and v['id'] not in only: continue
        try:
            do_video(rp, v, man)
        except Exception as e:
            log(f'video {v["id"]} failed: {e}'); failed.append(v['id'])
    hook.send('assemble', stage='done' if not failed else 'error', videos=len(man), failed=failed)
    if failed: raise SystemExit(f'failed videos: {failed}')


def do_video(rp, v, man):
    if True:
        t0 = time.time()
        pcs = sorted([p for p in rp['pieces'] if p['video'] == v['id']], key=lambda p: p['idx'])
        files = []
        for p in pcs:
            fn = os.path.join(W, f'{v["id"]}_{p["idx"]:04d}.mp4')
            name = f'{P}/render/{v["id"]}/{p["idx"]:04d}.mp4'
            try:
                sw.download_file(name, fn)
            except NotFound:
                # storage lost the piece (Blomp sometimes drops fresh objects): re-render it right here
                log(f'piece {p["p"]} missing -> rendering inline')
                d = os.path.join(W, f'inline{p["p"]}'); os.makedirs(d, exist_ok=True)
                subprocess.run([sys.executable, os.path.join(HERE, 'render.py')], cwd=d, check=True,
                               env={**os.environ, 'PIECE': str(p['p']), 'PYTHONPATH': HERE})
                sw.download_file(name, fn)
            files.append(fn)
        lst = os.path.join(W, 'list.txt'); open(lst, 'w').write(''.join(f"file '{f}'\n" for f in files))
        meta = os.path.join(W, 'meta.txt')
        total = sum(ffprobe_duration(f) for f in files)
        ch = sorted(v.get('chapters') or [], key=lambda c: c['t'])
        lines = [';FFMETADATA1', f'title={esc(v["title"])}', f'comment={esc(v.get("description", "")[:900])}']
        for k, c in enumerate(ch):
            s = c['t']; e = ch[k + 1]['t'] if k + 1 < len(ch) else total
            if e - s < 1: continue
            lines += ['[CHAPTER]', 'TIMEBASE=1/1000', f'START={int(s*1000)}', f'END={int(e*1000)}', f'title={esc(c["title"])}']
        open(meta, 'w').write('\n'.join(lines) + '\n')
        out = os.path.join(W, 'final.mp4')
        sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-i', meta, '-map', '0', '-map_metadata', '1', '-map_chapters', '1',
            '-c', 'copy', '-movflags', '+faststart', out])
        thumb = os.path.join(W, 'thumb.jpg')
        tt = min(max(0, float(v.get('thumb_t') or total * 0.3)), max(0, total - 1))
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', f'{tt:.2f}', '-i', out, '-frames:v', '1', '-q:v', '2', '-vf', 'scale=1280:-2', thumb])
        d = ffprobe_duration(out)
        ent = {'file': v['file'], 'size': os.path.getsize(out), 'crc': crc32_file(out), 'duration': round(d, 3)}
        sw.upload_file(f'{P}/out/{v["id"]}.mp4', out, 'video/mp4')
        if os.path.exists(thumb):
            ent['thumb'] = {'size': os.path.getsize(thumb), 'crc': crc32_file(thumb)}
            sw.upload_file(f'{P}/out/{v["id"]}.jpg', thumb, 'image/jpeg')
        man[v['id']] = ent
        sw.put_json(f'{P}/out/manifest.json', man)
        for f in files: os.remove(f)
        os.remove(out)
        log(f'video {v["id"]} "{v["file"]}" {d:.0f}s {ent["size"]/1e6:.0f}MB in {time.time()-t0:.0f}s')
        hook.send('video', video=v['id'], stage='done', size=ent['size'], duration=ent['duration'])


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        hook.send('assemble', stage='error', error=str(e)[:400]); raise
