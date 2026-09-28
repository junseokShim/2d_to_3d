"""절삭공구 턴테이블 사진 -> 치수(mm) 3D 메쉬 + 마모 텍스처.

가정
- 공구는 세로(생크 위, 팁 아래), 사진 상단에 홀더가 보이지 않게 크롭
- 턴테이블 등각 N장, 파일명 순서 = 회전 순서 (위에서 볼 때 CCW, 반대면 --cw)
- 원거리/텔레센트릭 촬영(정투영 근사), 단색 배경
출력: tool.obj/.mtl/_texture.png (마모 포함), tool.stl, dims.json
"""
import argparse, glob, json, os
import cv2
import numpy as np


def load(folder):
    ext = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff")
    paths = sorted(p for p in glob.glob(os.path.join(folder, "*")) if p.lower().endswith(ext))
    return [cv2.imread(p) for p in paths]


def segment(img):
    g = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    _, m = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if np.r_[m[0], m[-1], m[:, 0], m[:, -1]].mean() > 127:  # 배경이 밝으면 반전
        m = 255 - m
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    _, lab, st, _ = cv2.connectedComponentsWithStats(m)
    return lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])


def edges(mask):
    L = np.full(mask.shape[0], np.nan)
    R = L.copy()
    rows = np.where(mask.any(1))[0]
    L[rows] = mask[rows].argmax(1) - 0.5
    R[rows] = mask.shape[1] - 1 - mask[rows, ::-1].argmax(1) + 0.5
    return L, R


def write_obj(out, V, UV, F, tex_name):
    with open(out + ".mtl", "w") as f:
        f.write(f"newmtl tool\nKd 1 1 1\nmap_Kd {tex_name}\n")
    with open(out + ".obj", "w") as f:
        f.write(f"mtllib {os.path.basename(out)}.mtl\nusemtl tool\n")
        f.writelines(f"v {x:.4f} {y:.4f} {z:.4f}\n" for x, y, z in V)
        f.writelines(f"vt {u:.5f} {v:.5f}\n" for u, v in UV)
        f.writelines(f"f {a}/{a} {b}/{b} {c}/{c}\n" for a, b, c in F + 1)


def write_stl(path, V, F):
    tri = V[F].astype(np.float32)
    rec = np.zeros(len(F), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["v"] = tri
    with open(path, "wb") as f:
        f.write(b"\0" * 80 + np.uint32(len(F)).tobytes() + rec.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images")
    ap.add_argument("--shank-d", type=float, required=True, help="생크 실측 직경 mm (스케일 기준)")
    ap.add_argument("--shank-frac", type=float, default=0.15, help="상단 몇 %%를 생크로 볼지")
    ap.add_argument("--flutes", type=int, help="날 수 (미지정 시 자동 추정)")
    ap.add_argument("--core", type=float, default=0.6, help="심압비 core/D (사진으로 측정 불가)")
    ap.add_argument("--cw", action="store_true", help="턴테이블이 위에서 볼 때 시계방향")
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    imgs = load(a.images)
    N = len(imgs)
    E = np.array([edges(segment(i)) for i in imgs])  # N,2,H
    rows = np.where(~np.isnan(E).any((0, 1)))[0]
    top, tip = rows[0], rows[-1]
    Lx, Rx = E[:, 0, top:tip + 1], E[:, 1, top:tip + 1]
    nz = tip - top + 1
    rr = np.arange(nz)

    # 회전축: 한 바퀴 평균 중점 = 축 (행별 1차 피팅으로 기울기 보정)
    ax = np.polyval(np.polyfit(rr, ((Lx + Rx) / 2).mean(0), 1), rr)
    ppm = np.median((Rx - Lx)[:, : max(3, int(nz * a.shank_frac))]) / a.shank_d
    z = (nz - 1 - rr) / ppm  # 팁에서부터 높이 mm

    # 실루엣 좌/우 모서리 = 단면의 지지함수 h(phi) 샘플
    th = (-1 if a.cw else 1) * 2 * np.pi * np.arange(N) / N
    phi = np.r_[-th, np.pi - th]
    h = np.vstack([(Rx - ax) / ppm, (ax - Lx) / ppm])
    Renv = h.max(0)

    # 날 수 / 헬릭스 : 지지함수의 k차 고조파 위상이 z에 따라 선형으로 회전
    kmax = min(8, (N if N % 2 == 0 else 2 * N) // 2 - 1)
    C = {k: (h * np.exp(-1j * k * phi)[:, None]).mean(0) for k in range(2, kmax + 1)}
    tipzone = slice(int(nz * 0.7), nz)
    k = a.flutes or max(C, key=lambda k: np.mean(np.abs(C[k][tipzone])))
    amp = np.convolve(np.abs(C[k]) / Renv, np.ones(int(ppm)) / int(ppm), "same")
    fl = amp > 0.3 * amp[tipzone].max()
    n_up = np.argmin(fl[::-1]) if not fl.all() else nz  # 팁에서 연속된 날 구간
    fidx = np.arange(nz - n_up, nz)
    ph = np.unwrap(np.angle(C[k][fidx][::-1]))
    a1, a0 = np.polyfit(z[fidx][::-1], ph, 1)
    s, phi0 = -a1 / k, -a0 / k  # 날 위치 = phi0 + s*z
    Dcut = 2 * np.median(Renv[fidx])
    helix = np.degrees(np.arctan(abs(s) * Dcut / 2))

    def radius(A, j):  # A: (1,M) 방위각, j: 행 인덱스 배열 -> (len(j),M) 반경
        R = Renv[j][:, None]
        g = ((1 + np.cos(k * (A - phi0 - s * z[j][:, None]))) / 2) ** 0.35
        return np.where((j >= nz - n_up)[:, None], R * (a.core + (1 - a.core) * g), R)

    # 텍스처: 각 방위각을 정면으로 본 뷰에서 샘플 (원통 언랩)
    W = int(min(4096, np.pi * Dcut * ppm))
    A = 2 * np.pi * (np.arange(W) + 0.5) / W
    vi = np.round((-np.pi / 2 - A) / (th[1] - th[0])).astype(int) % N
    tex = np.zeros((nz, W, 3), np.uint8)
    Rm = radius(A[None, :], rr)
    U = np.round(ax[:, None] + ppm * Rm * np.cos(A[None, :] + th[vi][None, :])).astype(int)
    for i in range(N):
        cols = np.where(vi == i)[0]
        tex[:, cols] = imgs[i][top + rr[:, None], np.clip(U[:, cols], 0, imgs[i].shape[1] - 1)]
    cv2.imwrite(os.path.join(a.out, "tool_texture.png"), tex)

    # 메쉬: (z 레벨) x (방위각) 격자 + 상/하 캡
    M = 180
    js = np.unique(np.r_[np.arange(nz - 1, -1, -max(1, nz // 300)), 0])  # 팁->상단
    js = js[np.argsort(z[js])]
    Ag = 2 * np.pi * np.arange(M + 1) / M
    Rg = radius(Ag[None, :], js)
    Zg = np.repeat(z[js][:, None], M + 1, 1)
    V = np.stack([Rg * np.cos(Ag), Rg * np.sin(Ag), Zg], -1).reshape(-1, 3)
    UV = np.stack([np.broadcast_to(Ag / (2 * np.pi), Zg.shape), Zg / z[0]], -1).reshape(-1, 2)
    nL, idx = len(js), np.arange(len(js) * (M + 1)).reshape(len(js), M + 1)
    p00, p01, p10, p11 = idx[:-1, :-1], idx[:-1, 1:], idx[1:, :-1], idx[1:, 1:]
    F = [np.stack([p00, p01, p11], -1).reshape(-1, 3), np.stack([p00, p11, p10], -1).reshape(-1, 3)]
    cb, ct = len(V), len(V) + 1
    V = np.vstack([V, [0, 0, 0], [0, 0, z[0]]])
    UV = np.vstack([UV, [0.5, 0.5 / nz], [0.5, 1 - 0.5 / nz]])
    m = np.arange(M)
    F += [np.stack([np.full(M, cb), idx[0, m + 1], idx[0, m]], -1),
          np.stack([np.full(M, ct), idx[-1, m], idx[-1, m + 1]], -1)]
    F = np.vstack(F)

    out = os.path.join(a.out, "tool")
    write_obj(out, V, UV, F, "tool_texture.png")
    write_stl(out + ".stl", V, F)
    dims = dict(views=N, px_per_mm=round(ppm, 3), overall_length_mm=round(z[0], 3),
                cutting_diameter_mm=round(Dcut, 3),
                shank_diameter_measured_mm=round(2 * np.median(Renv[: max(3, int(nz * a.shank_frac))]), 3),
                flute_length_mm=round(n_up / ppm, 3), flutes=int(k), helix_deg=round(helix, 2),
                helix_hand="right" if s > 0 else "left", flute_phase_deg=round(np.degrees(phi0) % (360 / k), 2),
                flute_signal=round(float(amp[tipzone].max()), 4), core_ratio_assumed=a.core)
    json.dump(dims, open(os.path.join(a.out, "dims.json"), "w"), indent=2)
    print(json.dumps(dims, indent=2))


if __name__ == "__main__":
    main()
