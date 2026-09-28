# Tool3D headless Blender pipeline (developer tool only; the app never needs Blender).
# Input : the app's exported binary STL (mm, z = tool axis, tip at z = 0) + result.json (with .wear = wearResult).
# Output: iso.png, corner.png, turntable_NN.png (Cycles), tool3d.glb, volume_check.json.
# Usage : blender -b --factory-startup -P tools/blender/tool3d_blender.py -- --stl tool.stl --result result.json --out DIR
#         [--samples 64] [--res 1280x960] [--frames 12] [--turn-res 640x480] [--no-render] [--no-glb] [--tol 2.0]
# Volume check: the wear solid is rebuilt as a real mesh (one wedge prism per profile row, cross-section
# 1/2*VB^2*tan(clearance) normal to the edge, swept along the helix measured from the STL) and its volume
# is taken with bmesh.calc_volume, then compared with wearResult.totals.volumeMm3.
import bpy, bmesh, sys, os, json, math, gzip, tempfile, argparse
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser(prog='tool3d_blender')
ap.add_argument('--stl', required=True); ap.add_argument('--result', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--samples', type=int, default=64); ap.add_argument('--res', default='1280x960')
ap.add_argument('--frames', type=int, default=12); ap.add_argument('--turn-res', default='640x480')
ap.add_argument('--clearance', type=float, default=8.0, help='clearance angle (deg) of the wedge model, as wear-core')
ap.add_argument('--tol', type=float, default=2.0, help='volume check tolerance in percent')
ap.add_argument('--no-render', action='store_true'); ap.add_argument('--no-glb', action='store_true')
A = ap.parse_args(argv)
os.makedirs(A.out, exist_ok=True)
log = lambda *m: print('[tool3d]', *m, flush=True)

# ---------- scene + input ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
stl = A.stl
if stl.endswith('.gz'):
    tmp = os.path.join(tempfile.gettempdir(), 'tool3d_blender.stl')
    with gzip.open(stl, 'rb') as f, open(tmp, 'wb') as g: g.write(f.read())
    stl = tmp
bpy.ops.wm.stl_import(filepath=stl)
tool = bpy.context.selected_objects[0]; tool.name = 'Tool'
with open(A.result, encoding='utf-8') as f: res = json.load(f)
W = res.get('wear', res)
k, D = int(W['flutes']), float(W['diameterMm']); R = D / 2

# ---------- tool mesh stats (1 unit = 1 mm) ----------
bm = bmesh.new(); bm.from_mesh(tool.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
nonman = sum(1 for e in bm.edges if not e.is_manifold)
tool_stats = {'triangles': len(tool.data.polygons), 'verts_welded': len(bm.verts), 'nonManifoldEdges': nonman,
              'volumeMm3': round(abs(bm.calc_volume()), 3) if nonman == 0 else None}
co = [v.co.copy() for v in bm.verts]; bm.free()
zmin, zmax = min(c.z for c in co), max(c.z for c in co)
log('tool', tool_stats, 'z', round(zmin, 3), round(zmax, 3))

# ---------- cutting edges from the STL: azimuth of max-radius vertices, twist rate, flank side ----------
def edge_angles(z0, z1):
    pts = [c for c in co if z0 <= c.z <= z1 and math.hypot(c.x, c.y) > R - .01 * D]
    ang = sorted(math.atan2(c.y, c.x) % (2 * math.pi) for c in pts)
    if len(ang) < k: return None
    gaps = sorted(range(len(ang)), key=lambda i: -((ang[(i + 1) % len(ang)] - ang[i]) % (2 * math.pi)))[:k]
    out, starts = [], sorted((g + 1) % len(ang) for g in gaps)
    for j, s in enumerate(starts):
        e = starts[(j + 1) % k]; grp = ang[s:e] if s < e else ang[s:] + ang[:e]
        out.append(math.atan2(sum(math.sin(a) for a in grp), sum(math.cos(a) for a in grp)) % (2 * math.pi))
    return sorted(out)

def wrap(a): return (a + math.pi) % (2 * math.pi) - math.pi
za, zb = .2 * D, 1.6 * D
Ea, Eb = edge_angles(za, za + .1 * D), edge_angles(zb, zb + .1 * D)
tw_nom = math.tan(math.radians(W['helixDeg'])) / R
# match each edge at za to the one at zb; twist = mean angular shift / dz (sign = helix hand)
cands = []
for s in (1, -1):
    pred = [(a + s * tw_nom * (zb - za)) for a in Ea]
    err = sum(min(abs(wrap(p - b)) for b in Eb) for p in pred)
    cands.append((err, s))
hand = min(cands)[1]
shifts = [wrap(min(Eb, key=lambda b: abs(wrap(a + hand * tw_nom * (zb - za) - b))) - a) for a in Ea]
tw = sum(shifts) / len(shifts) / (zb - za)
E0 = [wrap(a - tw * (za + .05 * D)) for a in Ea]              # edge azimuth at z = 0
# flank side: the ground land (r a little under R) trails the edge on one side only
def flank_sign():
    acc = 0
    for c in co:
        if not (za <= c.z <= zb): continue
        r = math.hypot(c.x, c.y)
        if not (R - .006 * D < r < R - .0005 * D): continue
        a = math.atan2(c.y, c.x)
        d = min((wrap(a - (e + tw * c.z)) for e in E0), key=abs)
        if abs(d) < .06 * D / R: acc += 1 if d > 0 else -1
    return 1 if acc >= 0 else -1
fs = flank_sign()
helix_stl = math.degrees(math.atan(abs(tw) * R))
log('edges@z0 deg', [round(math.degrees(e), 1) for e in E0], 'helix from STL', round(helix_stl, 2), 'hand', hand, 'flank', fs)

# map photo flute i -> STL edge: flute 0 = edge nearest the app's phase convention is not exported, so use STL order
edges = sorted(E0, key=lambda e: e % (2 * math.pi))

# ---------- wear solid (volume) + wear land skin (render) ----------
tanC = math.tan(math.radians(A.clearance))
def frame(e0, z):
    a = e0 + tw * z
    u = Vector((math.cos(a), math.sin(a), 0)); t = Vector((-math.sin(a), math.cos(a), 0))
    T = (t * (R * tw) + Vector((0, 0, 1))).normalized()
    f = t * fs; b = (f - T * f.dot(T)).normalized()
    return Vector((R * u.x, R * u.y, z)), u, b

def build(name, rows_fn):
    me = bpy.data.meshes.new(name); bmx = bmesh.new()
    rows_fn(bmx); bmx.to_mesh(me); bmx.free()
    ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob); return ob

def rows(f):
    p = f.get('profile') or []
    for i, q in enumerate(p):
        if q['vbMm'] <= 0: continue
        dz = (p[min(i + 1, len(p) - 1)]['zMm'] - p[max(i - 1, 0)]['zMm']) / (2 if 0 < i < len(p) - 1 else 1) if len(p) > 1 else .25
        yield max(q['zMm'] - dz / 2, 0), q['zMm'] + dz / 2, q['vbMm']

SUB = 6
def solid(bmx, e0, f):
    for z0, z1, vb in rows(f):
        h = vb * tanC; secs = []
        for j in range(SUB + 1):
            P, u, b = frame(e0, z0 + (z1 - z0) * j / SUB)
            secs.append([bmx.verts.new(P), bmx.verts.new(P - u * h), bmx.verts.new(P + b * vb - u * h)])
        bmx.faces.new(secs[0][::-1]); bmx.faces.new(secs[-1])
        for j in range(SUB):
            s0, s1 = secs[j], secs[j + 1]
            for m in range(3):
                n = (m + 1) % 3; bmx.faces.new((s0[m], s0[n], s1[n], s1[m]))
    bmesh.ops.recalc_face_normals(bmx, faces=bmx.faces)

def skin(bmx, e0, f):
    # thin red layer on the clearance land, s = 0..VB behind the edge, 3 um proud of the surface
    p = [q for q in (f.get('profile') or [])]
    if len(p) < 2: return
    prev = None
    for q in p:
        z, vb = q['zMm'], q['vbMm']; row = []
        for s in range(5):
            P, u, b = frame(e0, z); d = vb * s / 4
            row.append(bmx.verts.new(P + b * d - u * (d * tanC - .003)))
        if prev: [bmx.faces.new((prev[m], prev[m + 1], row[m + 1], row[m])) for m in range(4)]
        prev = row

per, solids, skins = [], [], []
for i, f in enumerate(W['perFlute']):
    e0 = edges[i % len(edges)]
    ob = build('WearSolid_%d' % i, lambda bmx: solid(bmx, e0, f))
    bmv = bmesh.new(); bmv.from_mesh(ob.data); v = abs(bmv.calc_volume()); bmv.free()
    formula = sum(.5 * vb * vb * tanC * (z1 - z0) / math.cos(math.radians(W['helixDeg'])) for z0, z1, vb in rows(f))
    per.append({'flute': i, 'edgeAzimuthDeg': round(math.degrees(e0), 2), 'meshVolumeMm3': round(v, 5),
                'formulaMm3': round(formula, 5), 'appVolumeMm3': f['volumeMm3']})
    solids.append(ob); skins.append(build('WearLand_%d' % i, lambda bmx: skin(bmx, e0, f)))
mesh_total = sum(p['meshVolumeMm3'] for p in per); app_total = W['totals']['volumeMm3']
diff = 100 * (mesh_total - app_total) / app_total if app_total else 0.0
check = {'appTotalVolumeMm3': app_total, 'meshTotalVolumeMm3': round(mesh_total, 5), 'diffPct': round(diff, 3),
         'tolPct': A.tol, 'pass': abs(diff) <= A.tol, 'clearanceDeg': A.clearance,
         'helixDegResult': W['helixDeg'], 'helixDegFromStl': round(helix_stl, 3), 'hand': 'RH' if hand > 0 else 'LH',
         'perFlute': per, 'toolMesh': tool_stats, 'blender': bpy.app.version_string,
         'method': 'wear solid rebuilt as closed wedge prisms swept along the STL helix; bmesh.calc_volume'}
with open(os.path.join(A.out, 'volume_check.json'), 'w') as f: json.dump(check, f, indent=1)
log('VOLUME mesh %.5f mm3 vs app %.5f mm3 -> %+.3f %% (%s)' % (mesh_total, app_total, diff, 'PASS' if check['pass'] else 'FAIL'))

# ---------- materials ----------
def mat(name, base, metal, rough, emit=None, bump=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*base, 1); b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if 'Coat Weight' in b.inputs: b.inputs['Coat Weight'].default_value = .15 if metal else 0
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = .6
    if bump:   # fine grinding texture, like the scanner's ground carbide
        n = nt.nodes.new('ShaderNodeTexNoise'); n.inputs['Scale'].default_value = 900; n.inputs['Detail'].default_value = 8
        bp = nt.nodes.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = bump; bp.inputs['Distance'].default_value = .002
        nt.links.new(n.outputs['Fac'], bp.inputs['Height']); nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
    return m
m_tool = mat('Carbide', (.52, .53, .55), 1.0, .32, bump=.35)
m_wear = mat('Wear', (.85, .05, .03), 0.0, .45, emit=(.9, .05, .03))
m_solid = mat('WearSolid', (.85, .05, .03), 0.0, .5)
tool.data.materials.append(m_tool)
for p in tool.data.polygons: p.use_smooth = True
for o in skins: o.data.materials.append(m_wear)
for o in solids: o.data.materials.append(m_solid); o.hide_render = True

# rig: STL frame kept (tip at z = 0 pointing down, shank up, as in a holder); one pivot for the turntable
piv = bpy.data.objects.new('Tool3D', None); sc.collection.objects.link(piv)
for o in [tool] + skins + solids: o.parent = piv

# ---------- GLB ----------
if not A.no_glb:
    glb = os.path.join(A.out, 'tool3d.glb')
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', export_apply=True, export_yup=True)
    log('GLB', glb, os.path.getsize(glb), 'bytes')

if A.no_render: sys.exit(0)

# ---------- Cycles scanner-style render ----------
sc.render.engine = 'CYCLES'; cy = sc.cycles
cy.samples = A.samples; cy.use_denoising = True
try:
    pr = bpy.context.preferences.addons['cycles'].preferences
    for t in ('OPTIX', 'CUDA'):
        try:
            pr.compute_device_type = t; pr.get_devices()
            if any(d.type == t for d in pr.devices):
                for d in pr.devices: d.use = d.type == t
                cy.device = 'GPU'; break
        except TypeError: pass
except Exception as e: log('GPU setup failed', e)
log('device', cy.device, getattr(bpy.context.preferences.addons['cycles'].preferences, 'compute_device_type', ''))
sc.view_settings.view_transform = 'AgX' if 'AgX' in [i.identifier for i in sc.view_settings.bl_rna.properties['view_transform'].enum_items] else 'Filmic'
sc.view_settings.look = 'None'
sc.render.film_transparent = False

wd = bpy.data.worlds.new('World'); sc.world = wd; wd.use_nodes = True
bg = wd.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (.035, .04, .05, 1); bg.inputs['Strength'].default_value = 1.0

def light(name, loc, energy, size, color=(1, 1, 1)):
    l = bpy.data.lights.new(name, 'AREA'); l.energy = energy; l.size = size; l.color = color
    o = bpy.data.objects.new(name, l); sc.collection.objects.link(o); o.location = loc
    o.rotation_euler = (Vector((0, 0, zmax * .6)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler(); return o
S = D * 6
light('Key', (S, -S, zmax + S * .6), 9000 * (D / 10) ** 2, D * 3)
light('Fill', (-S, -S * .6, zmax * .4), 2500 * (D / 10) ** 2, D * 5, (.85, .9, 1))
light('Rim', (-S * .4, S, zmax + S), 6000 * (D / 10) ** 2, D * 2)
light('Ring', (0, 0, -D * 4), 3000 * (D / 10) ** 2, D * 3)   # coaxial ring light under the tip

cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = 85; cam.data.clip_start = .1; cam.data.clip_end = 2000
def aim(tgt, dirv, dist):
    tgt = Vector(tgt); cam.location = tgt + Vector(dirv).normalized() * dist
    cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
def shoot(path, wh):
    w, h = map(int, wh.split('x')); sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100; sc.render.filepath = path; sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True); log('wrote', path)

L = zmax
aim((0, 0, L * .45), (1, -1, .45), L * 2.9); shoot(os.path.join(A.out, 'iso.png'), A.res)
# corner: flute with the largest VB, looking at the flank land near the tip
fi = max(range(len(W['perFlute'])), key=lambda i: W['perFlute'][i]['vbMaxMm'])
e = edges[fi % len(edges)] + tw * .25 * D; ax, ay = math.cos(e), math.sin(e)
aim((ax * R * .8, ay * R * .8, .25 * D), (ax - ay * .6 * fs, ay + ax * .6 * fs, -.55), D * 2.6)
cam.data.lens = 100; shoot(os.path.join(A.out, 'corner.png'), A.res); cam.data.lens = 85
cy.samples = max(16, A.samples // 2)
aim((0, 0, L * .45), (1, -1, .35), L * 2.9)
for j in range(A.frames):
    piv.rotation_euler = (0, 0, 2 * math.pi * j / A.frames)
    shoot(os.path.join(A.out, 'turntable_%02d.png' % j), A.turn_res)
log('done')
