"""Fetch only segmentation masks (+ the matching microscope images) from the ExtraDrey
(TUHH, DOI 10.15480/882.17237) per-edge .tar archives without downloading them whole.

Each uncompressed tar stores members in the order Experiment_Data/, Images/Heightmap/,
Images/Image/, Images/Mask/, so the images and masks sit at the END of the archive.
We read the tail with HTTP Range requests in backward chunks until a Heightmap or
Experiment_Data header is seen, parse the tar headers in that tail, and save
Images/Mask/*.png plus the Images/Image/*.jpg that have a mask.
Usage: python fetch_masked.py [EDGE ...]   (default: all 67 edges)
"""
import http.client, json, os, sys, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

HOST = "tore.tuhh.de"
API = "/dspace-cris-server/api/core"
ITEM = "83322c14-70fe-4d09-b491-2506bd6689a3"
OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHUNK = 24 * 2**20
_local = threading.local()


def get(path, rng=None):
    for attempt in range(5):
        try:
            if not hasattr(_local, "c"):
                _local.c = http.client.HTTPSConnection(HOST, timeout=600)
            h = {"Range": f"bytes={rng[0]}-{rng[1]}"} if rng else {}
            _local.c.request("GET", path, headers=h)
            r = _local.c.getresponse()
            if r.status in (301, 302, 303, 307):
                loc = r.getheader("Location"); r.read()
                path = loc.replace("https://" + HOST, "")
                continue
            data = r.read()
            if r.status not in (200, 206):
                raise IOError(f"{r.status} {path}")
            return data
        except (http.client.HTTPException, OSError):
            if attempt == 4:
                raise
            _local.c = http.client.HTTPSConnection(HOST, timeout=600)


def bitstreams():
    b = json.loads(get(f"{API}/items/{ITEM}/bundles"))
    out = []
    for bu in b["_embedded"]["bundles"]:
        if bu["name"] != "ORIGINAL":
            continue
        page = 0
        while True:
            r = json.loads(get(f"{API}/bundles/{bu['uuid']}/bitstreams?size=100&page={page}"))
            out += [(s["name"], s["uuid"], s["sizeBytes"]) for s in r["_embedded"]["bitstreams"]]
            page += 1
            if page >= r["page"]["totalPages"]:
                break
    return out


def is_header(blk):
    if len(blk) < 512 or blk[:3] != b"CT0":
        return False
    try:
        chk = int(blk[148:156].split(b"\0")[0].strip() or b"-1", 8)
    except ValueError:
        return False
    return chk == sum(blk[:148]) + 256 + sum(blk[156:512])


def parse(buf, base):
    """Return [(name, abs_data_offset, size)] for headers found in buf (buf starts at abs offset base, 512-aligned)."""
    mem, i = [], 0
    while i + 512 <= len(buf):
        blk = buf[i:i + 512]
        if is_header(blk):
            name = blk[:100].split(b"\0")[0].decode()
            pre = blk[345:500].split(b"\0")[0].decode()
            if pre:
                name = pre + "/" + name
            sz = int(blk[124:136].split(b"\0")[0].strip() or b"0", 8)
            mem.append((name, base + i + 512, sz))
            i += 512 + ((sz + 511) // 512) * 512
        else:
            i += 512
    return mem


def do_edge(name, uuid, size):
    edge = name[:-4]
    path = f"{API}/bitstreams/{uuid}/content"
    end = size
    buf, start = b"", size
    while True:
        s = max(0, ((end - CHUNK) // 512) * 512)
        buf = get(path, (s, end - 1)) + buf
        start, end = s, s
        mem = parse(buf, start)
        if start == 0 or any("/Images/Heightmap/" in m[0] or "/Experiment_Data/" in m[0] for m in mem):
            break
    masks = [m for m in mem if "/Images/Mask/" in m[0] and m[2] > 0]
    imgs = {os.path.basename(m[0]): m for m in mem if "/Images/Image/" in m[0] and m[2] > 0}
    rows = []
    for m in masks:
        b = os.path.basename(m[0]).replace("_mask.png", "")
        img = imgs.get(b + ".jpg")
        for nm, o, sz in [m] + ([img] if img else []):
            dst = os.path.join(OUT, nm)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as f:
                f.write(buf[o - start:o - start + sz])
        rows.append({"edge": edge, "mask": m[0], "image": img[0] if img else None})
    print(f"{edge}: tail {(size - start) / 1e6:.0f} MB, {len(imgs)} images, {len(masks)} masks", flush=True)
    return rows


def main():
    bs = sorted(b for b in bitstreams() if b[0].endswith(".tar"))
    only = set(sys.argv[1:])
    if only:
        bs = [b for b in bs if b[0][:-4] in only]
    idx_path = os.path.join(OUT, "_meta", "masked_index.json")
    index = json.load(open(idx_path)) if os.path.exists(idx_path) else []
    done = {r["edge"] for r in index} | {l.split(":")[0] for l in open(os.path.join(OUT, "_meta", "done_edges.txt"))} if os.path.exists(os.path.join(OUT, "_meta", "done_edges.txt")) else set()
    bs = [b for b in bs if b[0][:-4] not in done]
    with ThreadPoolExecutor(6) as ex:
        futs = {ex.submit(do_edge, *b): b for b in bs}
        for f in as_completed(futs):
            try:
                rows = f.result()
                index += rows
                with open(os.path.join(OUT, "_meta", "done_edges.txt"), "a") as g:
                    g.write(futs[f][0][:-4] + ":" + str(len(rows)) + "\n")
                json.dump(index, open(idx_path, "w"), indent=1)
            except Exception as e:
                print("FAIL", futs[f][0], e, flush=True)


if __name__ == "__main__":
    main()
