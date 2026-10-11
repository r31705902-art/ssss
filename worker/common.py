"""Shared helpers for GitHub Actions workers: Blomp (OpenStack Swift) with retries, hooks, utils."""
import json, os, sys, time, random, subprocess, hashlib, zlib, urllib.parse
import requests

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

def retry(fn, what='op', tries=12, base=2.0, cap=60.0, ok_exc=()):
    last = None
    for i in range(tries):
        try:
            return fn()
        except ok_exc:
            raise
        except Exception as e:  # noqa
            last = e
            d = min(cap, base * (1.6 ** i)) * (0.7 + random.random() * 0.6)
            log(f'[retry] {what}: {str(e)[:200]} -> sleep {d:.1f}s ({i+1}/{tries})')
            time.sleep(d)
    raise RuntimeError(f'{what} failed after {tries} tries: {last}')


class NotFound(Exception):
    pass


class Swift:
    """Minimal Swift client for Blomp. Retries 5xx/timeouts (Blomp often returns 503)."""
    def __init__(self, user=None, key=None, auth_url=None, container=None):
        self.user = user or os.environ['BLOMP_USER']
        self.key = key or os.environ['BLOMP_PASS']
        self.put_errors = {}
        self.auth_url = (auth_url or os.environ.get('BLOMP_AUTH_URL') or 'https://authenticate.ain.net').rstrip('/')
        self.container = container or os.environ.get('BLOMP_CONTAINER') or self.user
        self.token = None; self.url = None; self.exp = 0
        self.s = requests.Session()

    def auth(self, force=False):
        if self.token and not force and time.time() < self.exp:
            return
        def go():
            r = requests.post(self.auth_url + '/v2.0/tokens', json={'auth': {'tenantName': 'storage', 'passwordCredentials': {'username': self.user, 'password': self.key}}}, timeout=60)
            if r.status_code >= 500: raise RuntimeError(f'auth {r.status_code}')
            r.raise_for_status()
            a = r.json()['access']
            ep = [s for s in a['serviceCatalog'] if s['type'] == 'object-store'][0]['endpoints'][0]['publicURL']
            return a['token']['id'], ep
        self.token, self.url = retry(go, 'blomp auth')
        self.exp = time.time() + 45 * 60

    def obj_url(self, name):
        self.auth()
        return f"{self.url}/{urllib.parse.quote(self.container, safe='')}/{urllib.parse.quote(name)}"

    def _req(self, method, name, what=None, expect=(200, 201, 202, 204, 206), **kw):
        def go():
            self.auth()
            h = dict(kw.get('headers') or {}); h['X-Auth-Token'] = self.token
            kw2 = {k: v for k, v in kw.items() if k != 'headers'}
            if callable(kw2.get('data')): kw2['data'] = kw2['data']()
            r = self.s.request(method, self.obj_url(name), headers=h, timeout=kw2.pop('timeout', 300), **kw2)
            if r.status_code == 401:
                self.auth(True); raise RuntimeError('401 reauth')
            if r.status_code == 404 and method in ('GET', 'HEAD', 'DELETE'):
                raise NotFound(name)
            if r.status_code not in expect:
                if method == 'PUT': self.put_errors[name] = self.put_errors.get(name, 0) + 1
                raise RuntimeError(f'{method} {name} -> {r.status_code} {r.text[:120]}')
            return r
        return retry(go, what or f'{method} {name}', ok_exc=(NotFound,))

    def put_bytes(self, name, b, ctype='application/octet-stream'):
        return self._req('PUT', name, data=b, headers={'Content-Type': ctype})

    def put_verified(self, name, b, ctype='application/octet-stream'):
        for attempt in range(5):
            self.put_errors.pop(name, None)
            self.put_bytes(name, b, ctype)
            for k in range(5):
                h = self.head(name)
                if h and h['size'] == len(b):
                    if not self.put_errors.get(name): return
                    time.sleep(60); h = self.head(name)
                    if h and h['size'] == len(b): return
                    log(f'{name} vanished after upload, re-put'); break
                time.sleep(2 + 3 * k)
            log(f'verify failed for {name}, re-put')
        raise RuntimeError('put verify failed: ' + name)

    def put_json(self, name, obj):
        return self.put_verified(name, json.dumps(obj, ensure_ascii=False).encode(), 'application/json')

    def get_bytes(self, name):
        return self._req('GET', name).content

    def get_json(self, name, default=None):
        try:
            return json.loads(self.get_bytes(name))
        except NotFound:
            return default

    def head(self, name):
        try:
            r = self._req('HEAD', name)
            return {'size': int(r.headers.get('Content-Length', 0)), 'etag': r.headers.get('Etag', '').strip('"'), 'meta': {k[len('X-Object-Meta-'):].lower(): v for k, v in r.headers.items() if k.lower().startswith('x-object-meta-')}}
        except NotFound:
            return None

    def delete(self, name):
        try: self._req('DELETE', name)
        except NotFound: pass

    def list(self, prefix):
        out, marker = [], ''
        while True:
            def go():
                self.auth()
                r = self.s.get(f"{self.url}/{urllib.parse.quote(self.container, safe='')}", params={'format': 'json', 'prefix': prefix, 'marker': marker, 'limit': 10000}, headers={'X-Auth-Token': self.token}, timeout=120)
                if r.status_code == 401: self.auth(True); raise RuntimeError('401')
                if r.status_code not in (200, 204): raise RuntimeError(f'list {r.status_code}')
                return r.json() if r.status_code == 200 else []
            page = retry(go, 'list ' + prefix)
            if not page: break
            out += page; marker = page[-1]['name']
            if len(page) < 10000: break
        return out

    SEG = 1024 * 1024 * 1024  # 1 GiB segments for big files (Swift single object limit is 5 GiB)

    def upload_file(self, name, path, ctype='application/octet-stream', meta=None):
        """Upload + verify (Blomp sometimes acks a PUT but loses the object). Re-uploads on mismatch."""
        size = os.path.getsize(path)
        for attempt in range(6):
            self.put_errors.pop(name, None)
            self._upload(name, path, ctype, meta)
            ok = False
            for k in range(6):
                h = self.head(name)
                if h and h['size'] == size: ok = True; break
                time.sleep(3 + 4 * k)
            if ok:
                # Blomp quirk: when a PUT attempt failed (503) and a retry succeeded, the object often vanishes
                # ~30-60 s later. Re-check after a settle period and re-upload if it was dropped.
                settle = 75 if self.put_errors.get(name) else 8
                time.sleep(settle)
                h = self.head(name)
                if h and h['size'] == size: return size
                log(f'{name} vanished after upload (settle {settle}s), re-upload {attempt+1}')
                continue
            log(f'verify failed for {name} (got {h and h["size"]}, want {size}), re-upload {attempt+1}')
        raise RuntimeError(f'upload verify failed: {name}')

    def _upload(self, name, path, ctype, meta):
        size = os.path.getsize(path)
        hdr = {'Content-Type': ctype}
        for k, v in (meta or {}).items(): hdr['X-Object-Meta-' + k] = str(v)
        t0 = time.time()
        if size <= self.SEG * 4:
            def body():
                return open(path, 'rb')
            self._req('PUT', name, data=body, headers=hdr, timeout=3600, what=f'upload {name}')
        else:  # Dynamic Large Object
            n = 0
            with open(path, 'rb') as f:
                while True:
                    off = n * self.SEG
                    if off >= size: break
                    def body(off=off):
                        f.seek(off); return f.read(self.SEG)
                    self._req('PUT', f'{name}.seg/{n:05d}', data=body, timeout=3600, what=f'upload {name} seg {n}')
                    n += 1
            h = dict(hdr); h['X-Object-Manifest'] = f'{self.container}/{name}.seg/'
            self._req('PUT', name, data=b'', headers=h)
        dt = time.time() - t0
        log(f'uploaded {name} {size/1e6:.1f} MB in {dt:.0f}s ({size/1e6/max(dt,0.01):.1f} MB/s)')

    def download_file(self, name, path, chunk=8 << 20):
        """Resumable download with Range retries."""
        def go():
            have = os.path.getsize(path) if os.path.exists(path) else 0
            self.auth()
            h = {'X-Auth-Token': self.token}
            if have: h['Range'] = f'bytes={have}-'
            with self.s.get(self.obj_url(name), headers=h, stream=True, timeout=300) as r:
                if r.status_code == 416: return
                if r.status_code == 404: raise NotFound(name)
                if r.status_code == 401: self.auth(True); raise RuntimeError('401')
                if r.status_code not in (200, 206): raise RuntimeError(f'GET {name} {r.status_code}')
                mode = 'ab' if r.status_code == 206 else 'wb'
                with open(path, mode) as f:
                    for c in r.iter_content(chunk):
                        f.write(c)
        retry(go, f'download {name}', ok_exc=(NotFound,))
        return path


class Hook:
    """Progress events to the server (best effort, never fails the job)."""
    def __init__(self, job):
        self.url = (os.environ.get('CALLBACK_URL') or '').rstrip('/')
        self.secret = os.environ.get('HOOK_SECRET', '')
        self.job = job
        self.last = 0

    def send(self, kind, force=True, **data):
        if not self.url: return
        if not force and time.time() - self.last < 8: return
        self.last = time.time()
        try:
            requests.post(self.url + '/api/hook', json={'job': self.job, 'kind': kind, 'run': os.environ.get('GITHUB_RUN_ID'), **data}, headers={'X-Hook-Secret': self.secret}, timeout=15)
        except Exception as e:
            log('hook failed', str(e)[:100])


def sh(cmd, **kw):
    log('$', cmd if isinstance(cmd, str) else ' '.join(map(str, cmd))[:300])
    return subprocess.run(cmd, shell=isinstance(cmd, str), check=True, **kw)


def crc32_file(path):
    c = 0
    with open(path, 'rb') as f:
        while True:
            b = f.read(16 << 20)
            if not b: break
            c = zlib.crc32(b, c)
    return c & 0xffffffff


def ffprobe_duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], capture_output=True, text=True).stdout.strip()
    try: return float(out)
    except ValueError: return 0.0


def fmt_ts(t):
    t = max(0, int(round(t)))
    return f'{t//3600:02d}:{t%3600//60:02d}:{t%60:02d}'
