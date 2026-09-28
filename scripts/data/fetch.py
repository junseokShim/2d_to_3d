"""Fast fetchers for large open tool-wear datasets.

  python fetch.py pget <url> <out> [--parts 8]        parallel HTTP-range download (resumable)
  python fetch.py zipimgs <url> <outdir> [--match images/]
                                                       extract only matching members of a remote zip
                                                       via HTTP ranges (skips sensor data)
"""
import argparse, io, os, struct, sys, threading, time, urllib.request, zipfile

UA = {"User-Agent": "toolwear-dataset-fetch/1.0"}


def resolve(url):
    req = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        total = int(r.headers["Content-Range"].split("/")[-1])
        return r.geturl(), total


def get_range(url, a, b, tries=8):
    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers={**UA, "Range": f"bytes={a}-{b}"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if t == tries - 1:
                raise
            time.sleep(2 + 3 * t)


def pget(url, out, parts=8, chunk=16 << 20):
    url, total = resolve(url)
    if os.path.exists(out) and os.path.getsize(out) == total:
        print("exists", out); return
    part = out + ".part"
    mode = "r+b" if os.path.exists(part) else "wb"
    with open(part, mode) as f:
        f.truncate(total)
    donefile = part + ".done"
    done = set()
    if os.path.exists(donefile):
        done = {int(x) for x in open(donefile).read().split()}
    todo = [i for i in range(0, total, chunk) if i not in done]
    lock = threading.Lock(); t0 = time.time(); got = [0]

    def work():
        while True:
            with lock:
                if not todo: return
                a = todo.pop(0)
            b = min(a + chunk, total) - 1
            data = get_range(url, a, b)
            with lock:
                with open(part, "r+b") as f:
                    f.seek(a); f.write(data)
                with open(donefile, "a") as d:
                    d.write(f"{a}\n")
                got[0] += len(data)
                if (got[0] // chunk) % 16 == 0:
                    print(f"{out}: {got[0]/1e6:.0f} MB this run, {got[0]/1e6/(time.time()-t0):.1f} MB/s, left {len(todo)} chunks", flush=True)

    ths = [threading.Thread(target=work) for _ in range(parts)]
    [t.start() for t in ths]; [t.join() for t in ths]
    os.replace(part, out); os.remove(donefile)
    print("done", out, total)


class HttpFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.size = resolve(url); self.pos = 0
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos
    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos
    def read(self, n=-1):
        if n is None or n < 0: n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0: return b""
        data = get_range(self.url, self.pos, self.pos + n - 1)
        self.pos += len(data); return data
    def readinto(self, b):
        d = self.read(len(b)); b[:len(d)] = d; return len(d)


def zipimgs(url, outdir, match="images/", workers=6):
    hf = HttpFile(url)
    z = zipfile.ZipFile(io.BufferedReader(hf, buffer_size=1 << 20))
    names = [i for i in z.infolist() if match in i.filename and not i.is_dir()]
    print(f"{len(z.infolist())} members, {len(names)} match, {sum(i.compress_size for i in names)/1e6:.0f} MB", flush=True)
    os.makedirs(outdir, exist_ok=True)
    todo = list(names); lock = threading.Lock()

    def work():
        zz = zipfile.ZipFile(io.BufferedReader(HttpFile(hf.url) if False else hf_clone(hf), buffer_size=1 << 20))
        while True:
            with lock:
                if not todo: return
                info = todo.pop(0)
            dst = os.path.join(outdir, os.path.basename(info.filename))
            if os.path.exists(dst) and os.path.getsize(dst) == info.file_size: continue
            data = zz.read(info)
            with open(dst + ".tmp", "wb") as f: f.write(data)
            os.replace(dst + ".tmp", dst)

    ths = [threading.Thread(target=work) for _ in range(workers)]
    [t.start() for t in ths]; [t.join() for t in ths]
    print("done", outdir, len(names), flush=True)


def hf_clone(hf):
    c = HttpFile.__new__(HttpFile); io.RawIOBase.__init__(c)
    c.url, c.size, c.pos = hf.url, hf.size, 0
    return c


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd"); ap.add_argument("url"); ap.add_argument("out")
    ap.add_argument("--parts", type=int, default=8); ap.add_argument("--match", default="images/")
    a = ap.parse_args()
    if a.cmd == "pget": pget(a.url, a.out, a.parts)
    elif a.cmd == "zipimgs": zipimgs(a.url, a.out, a.match)
    else: sys.exit("unknown cmd")
