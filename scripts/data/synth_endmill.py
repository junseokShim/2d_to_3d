# Synthetic end-mill wear images with exact masks, rendered headless in Blender 4.5.
#   blender -b --factory-startup -noaudio -P synth_endmill.py -- --out <dir> --n 200 --seed 0 [--res 512] [--samples 32]
# Per sample i writes <out>/img/synth_<seed>_<i>.png (Cycles, photo-like) and <out>/mask/synth_<seed>_<i>.png
# (Workbench flat render, no AA; pixel value = 50 * class: 0 background, 1 tool, 2 flank wear VB, 3 chipping, 4 adhesion/BUE)
# and <out>/meta/synth_<seed>_<i>.json (geometry, wear, camera, px/mm at the tool axis).
# Geometry: k-flute helical end mill built as one polar mesh (side, corner radius, end face with end teeth).
# Wear is assigned per face from the distance to the cutting edges, so masks are exact by construction.
import bpy, bmesh, sys, os, json, math, random, argparse
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True); ap.add_argument('--n', type=int, default=10); ap.add_argument('--seed', type=int, default=0)
ap.add_argument('--res', type=int, default=512); ap.add_argument('--samples', type=int, default=32)
ap.add_argument('--start', type=int, default=0)
A = ap.parse_args(argv)
for d in ('img', 'mask', 'meta'): os.makedirs(os.path.join(A.out, d), exist_ok=True)

MASK_STEP = 50  # mask png grey = class * 50 (decoded with round(v / 50) in postprocess)


def clear():
    # wipe the scene without read_factory_settings (that re-inits Cycles/OptiX each time: ~15 s per image)
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.worlds, bpy.data.images, bpy.data.textures):
        if len(coll): bpy.data.batch_remove(list(coll))


def smoothstep(a, b, x):
    t = min(1, max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t)


class Tool:
    """Polar end mill. Angle theta around the axis, z along the axis (tip at z=0, shank up to +L)."""

    def __init__(s, rnd):
        s.k = rnd.choice([2, 3, 4, 4, 4, 5, 6])
        s.D = rnd.choice([4, 6, 6, 8, 10, 10, 12, 16])
        s.R = s.D / 2
        s.helix = rnd.uniform(25, 50) * rnd.choice([1, 1, 1, -1])  # + = right hand
        s.Lf = s.D * rnd.uniform(1.5, 3.0)   # flute length
        s.L = s.Lf + s.D * rnd.uniform(1.0, 2.5)
        s.land = rnd.uniform(0.18, 0.35)     # land fraction of the pitch
        s.depth = s.R * rnd.uniform(0.28, 0.42)
        s.relief = s.R * rnd.uniform(0.015, 0.04)
        s.cr = rnd.choice([0, 0, 0.0, 0.2, 0.5, 1.0]) * (s.D / 10)  # corner radius mm
        s.dish = math.radians(rnd.uniform(1, 4))  # end face concavity angle

    def edge_theta(s, i, z):
        # cutting edge of flute i at height z (edge = leading side of the land, u=0)
        return 2 * math.pi * i / s.k + z * math.tan(math.radians(s.helix)) / s.R

    def local(s, th, z):
        P = 2 * math.pi / s.k
        t = th - z * math.tan(math.radians(s.helix)) / s.R
        u = (t % P) / P
        return u, int((t % (2 * math.pi)) // P)

    def radius(s, th, z):
        u, _ = s.local(th, z)
        if z > s.Lf + 0.5:
            return s.R * 0.98   # shank
        if u < s.land:
            r = s.R - s.relief * (u / s.land)
        else:
            t = (u - s.land) / (1 - s.land)
            # steep rake wall at t->1 (the edge), gentle heel at t->0
            g = math.sin(math.pi * (t ** 1.6)) ** 0.8
            r = s.R - s.relief - s.depth * g
            if t > 0.9: r = r + (s.R - r) * smoothstep(0.9, 1.0, t)
        # flute run-out toward the shank
        fade = smoothstep(s.Lf - 0.3 * s.D, s.Lf + 0.5, z)
        return r * (1 - fade) + s.R * 0.98 * fade

    def arc_behind_edge(s, th, z):
        """arc length (mm) on the land from the cutting edge backward (u in [0, land))."""
        u, i = s.local(th, z)
        return u * 2 * math.pi / s.k * s.R, i, u


def build(tool, wear, rnd):
    """Return bmesh object with per-face material index = class."""
    k = tool.k
    NT = 540 if tool.D <= 8 else 720
    zs = []
    z = 0.0
    while z < tool.L:
        zs.append(z)
        z += 0.02 * tool.D if z < 0.4 * tool.D else (0.04 * tool.D if z < tool.Lf else 0.12 * tool.D)
    zs.append(tool.L)
    bm = bmesh.new()
    rows = []
    for z in zs:
        row = []
        for j in range(NT):
            th = 2 * math.pi * j / NT
            r = tool.radius(th, z)
            # corner radius: pull the lip in near z=0
            if tool.cr > 0 and z < tool.cr:
                r = r - (tool.cr - math.sqrt(max(0, tool.cr ** 2 - (tool.cr - z) ** 2)))
            r, dz = wear.displace(tool, th, z, r)
            row.append(bm.verts.new((r * math.cos(th), r * math.sin(th), z + dz)))
        rows.append(row)
    # end face: rings from the rim inward; slight dish (center recessed); end gashes cut away near center
    NR = 28
    rim = rows[0]
    rings = [rim]
    for q in range(1, NR):
        f = 1 - q / NR
        ring = []
        for j in range(NT):
            th = 2 * math.pi * j / NT
            r0 = rim[j].co.xy.length
            rr = r0 * f
            zz = (tool.R - rr) * math.tan(tool.dish)
            rr2, dz = wear.displace_end(tool, th, rr, zz)
            ring.append(bm.verts.new((rr2 * math.cos(th), rr2 * math.sin(th), zz + dz)))
        rings.append(ring)
    center = bm.verts.new((0, 0, tool.R * math.tan(tool.dish)))
    bm.verts.ensure_lookup_table()
    # side faces
    for a in range(len(rows) - 1):
        for j in range(NT):
            j2 = (j + 1) % NT
            f = bm.faces.new((rows[a][j], rows[a][j2], rows[a + 1][j2], rows[a + 1][j]))
            th = 2 * math.pi * (j + .5) / NT
            f.material_index = wear.side_class(tool, th, (zs[a] + zs[a + 1]) / 2)
    # top cap of the shank
    top = bm.verts.new((0, 0, tool.L))
    for j in range(NT):
        bm.faces.new((rows[-1][(j + 1) % NT], rows[-1][j], top)).material_index = 1
    # end face
    for a in range(len(rings) - 1):
        for j in range(NT):
            j2 = (j + 1) % NT
            f = bm.faces.new((rings[a][j2], rings[a][j], rings[a + 1][j], rings[a + 1][j2]))
            th = 2 * math.pi * (j + .5) / NT
            rr = rings[a][j].co.xy.length * (1 - .5 / NR)
            f.material_index = wear.end_class(tool, th, rr)
    for j in range(NT):
        bm.faces.new((rings[-1][(j + 1) % NT], rings[-1][j], center)).material_index = 1
    bm.normal_update()
    me = bpy.data.meshes.new('tool'); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    ob = bpy.data.objects.new('tool', me); bpy.context.collection.objects.link(ob)
    return ob


class Wear:
    """Random wear state: flank VB band (peripheral + end teeth), corner wear, chips, adhesion."""

    def __init__(s, tool, rnd):
        s.rnd = rnd
        s.state = rnd.choices(['new', 'light', 'moderate', 'severe'], [0.15, 0.3, 0.35, 0.2])[0]
        vb = {'new': 0, 'light': rnd.uniform(0.03, 0.1), 'moderate': rnd.uniform(0.1, 0.3), 'severe': rnd.uniform(0.3, 0.6)}[s.state]
        s.vb = min(vb * (tool.D / 10) ** 0.5, 0.8 * tool.land * 2 * math.pi / tool.k * tool.R)
        s.ap = tool.Lf * rnd.uniform(0.2, 0.9)          # engaged depth: peripheral band only up to ap
        s.corner = s.vb * rnd.uniform(1.5, 3.5) if s.vb else 0   # extra VB at the corner (VBC)
        s.corner_len = tool.D * rnd.uniform(0.05, 0.2)
        s.end_vb = s.vb * rnd.uniform(0.4, 1.2)
        s.end_len = tool.R * rnd.uniform(0.3, 0.8)       # radial extent of the end-tooth wear from the rim
        s.per = [rnd.uniform(0.6, 1.3) for _ in range(tool.k)]  # per-flute scale
        s.chips, s.adh = [], []
        if s.state in ('moderate', 'severe') and rnd.random() < 0.6:
            for _ in range(rnd.randint(1, 3 if s.state == 'severe' else 1)):
                i = rnd.randrange(tool.k)
                on_corner = rnd.random() < 0.6
                z = rnd.uniform(0, tool.D * 0.1) if on_corner else rnd.uniform(0.1 * tool.D, s.ap)
                s.chips.append(dict(flute=i, z=z, w=tool.D * rnd.uniform(0.03, 0.12), d=tool.D * rnd.uniform(0.01, 0.04), corner=on_corner))
        if s.state != 'new' and rnd.random() < 0.3:
            for _ in range(rnd.randint(1, 2)):
                i = rnd.randrange(tool.k)
                s.adh.append(dict(flute=i, z=rnd.uniform(0, s.ap), w=tool.D * rnd.uniform(0.04, 0.15), h=tool.D * rnd.uniform(0.005, 0.015)))
        s.noise_ph = [rnd.uniform(0, 6.28) for _ in range(6)]

    def vb_at(s, tool, i, z):
        if s.vb == 0: return 0
        n = 1 + 0.25 * math.sin(z * 7.1 + s.noise_ph[0] + i) + 0.15 * math.sin(z * 23.3 + s.noise_ph[1] * i)
        band = s.vb * s.per[i] * n * (1 - smoothstep(s.ap * 0.9, s.ap * 1.05, z))
        corner = s.corner * s.per[i] * (1 - smoothstep(0, s.corner_len, z))
        return max(0, max(band, corner))

    def _chip(s, tool, th, z):
        """chip depth (mm, radial) at this surface point, 0 if none"""
        for c in s.chips:
            e = tool.edge_theta(c['flute'], z)
            da = ((th - e + math.pi) % (2 * math.pi)) - math.pi   # >0 = on the land behind the edge
            arc = da * tool.R
            dz = z - c['z']
            q = (dz / c['w']) ** 2 + ((arc - c['w'] * 0.25) / (c['w'] * 0.7)) ** 2
            if q < 1 and -0.1 * c['w'] < arc < c['w']:
                return c['d'] * (1 - q) ** 0.5
        return 0

    def _adh(s, tool, th, z):
        for c in s.adh:
            e = tool.edge_theta(c['flute'], z)
            arc = (((th - e + math.pi) % (2 * math.pi)) - math.pi) * tool.R
            q = ((z - c['z']) / c['w']) ** 2 + ((arc + c['w'] * .1) / (c['w'] * 0.45)) ** 2
            if q < 1: return c['h'] * (1 - q) ** 0.5 * (1 + 0.3 * math.sin(z * 40 + th * 30))
        return 0

    def displace(s, tool, th, z, r):
        cd = s._chip(tool, th, z)
        ah = s._adh(tool, th, z)
        return r - cd + ah, 0.0

    def displace_end(s, tool, th, rr, zz):
        # corner chips also bite into the end face near the rim
        dz = 0
        for c in s.chips:
            if not c['corner']: continue
            e = tool.edge_theta(c['flute'], 0)
            arc = (((th - e + math.pi) % (2 * math.pi)) - math.pi) * tool.R
            dr = tool.R - rr
            q = ((dr - 0) / c['w']) ** 2 + ((arc - c['w'] * .25) / (c['w'] * .7)) ** 2
            if q < 1 and -0.1 * c['w'] < arc < c['w'] and c['z'] < c['w']:
                dz = max(dz, c['d'] * (1 - q) ** .5)
        return rr, dz

    def side_class(s, tool, th, z):
        if z > tool.Lf: return 1
        if s._chip(tool, th, z) > 1e-4: return 3
        if s._adh(tool, th, z) > 1e-4: return 4
        arc, i, u = tool.arc_behind_edge(th, z)
        if u < tool.land and arc < s.vb_at(tool, i, z): return 2
        return 1

    def end_class(s, tool, th, rr):
        # end tooth edge: radial line at the edge angle at z=0; land behind it on the end face (end clearance)
        for c in s.chips:
            if not c['corner']: continue
            e = tool.edge_theta(c['flute'], 0)
            arc = (((th - e + math.pi) % (2 * math.pi)) - math.pi) * tool.R
            q = ((tool.R - rr) / c['w']) ** 2 + ((arc - c['w'] * .25) / (c['w'] * .7)) ** 2
            if q < 1 and -0.1 * c['w'] < arc < c['w'] and c['z'] < c['w']: return 3
        if s.end_vb <= 0: return 1
        u, i = tool.local(th, 0)
        if u >= tool.land: return 1
        arc = u * 2 * math.pi / tool.k * max(rr, 1e-3)
        lim = s.end_vb * s.per[i] * (1 - smoothstep(tool.R - s.end_len, tool.R, tool.R - rr + (tool.R - s.end_len) * 0))
        # wear strongest at the rim (corner), fading inward over end_len
        lim = s.end_vb * s.per[i] * smoothstep(tool.R - s.end_len, tool.R, rr) + (s.corner * s.per[i] if tool.R - rr < s.corner_len * .5 else 0)
        return 2 if arc < lim else 1


def principled(name, col, metal, rough, bump=0.0, noise_scale=300.0, aniso=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*col, 1); b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if 'Anisotropic' in b.inputs: b.inputs['Anisotropic'].default_value = aniso
    if bump > 0:
        tex = nt.nodes.new('ShaderNodeTexNoise'); tex.inputs['Scale'].default_value = noise_scale
        tex.inputs['Detail'].default_value = 8
        bn = nt.nodes.new('ShaderNodeBump'); bn.inputs['Strength'].default_value = bump
        nt.links.new(tex.outputs['Fac'], bn.inputs['Height']); nt.links.new(bn.outputs['Normal'], b.inputs['Normal'])
    return m


COATINGS = [((0.08, 0.07, 0.1), 'AlTiN black-violet'), ((0.35, 0.36, 0.38), 'uncoated carbide'), ((0.55, 0.42, 0.12), 'TiN gold'),
            ((0.2, 0.2, 0.26), 'TiAlN dark'), ((0.25, 0.28, 0.33), 'TiCN blue-grey'), ((0.45, 0.45, 0.47), 'bright carbide')]


def materials(rnd):
    col, cname = rnd.choice(COATINGS)
    j = lambda c: tuple(min(1, max(0, x * rnd.uniform(0.85, 1.15))) for x in c)
    tool = principled('tool', j(col), rnd.uniform(0.7, 1.0), rnd.uniform(0.25, 0.5), bump=0.05, noise_scale=800)
    wear = principled('wear', j((0.62, 0.62, 0.64)), 1.0, rnd.uniform(0.12, 0.3), bump=0.15, noise_scale=rnd.uniform(200, 900), aniso=0.5)
    chip = principled('chip', j((0.45, 0.45, 0.47)), 0.8, rnd.uniform(0.45, 0.7), bump=0.6, noise_scale=150)
    adh = principled('adh', j(rnd.choice([(0.5, 0.45, 0.38), (0.55, 0.55, 0.55), (0.35, 0.3, 0.25)])), 0.5, 0.75, bump=0.8, noise_scale=90)
    return [tool, tool, wear, chip, adh], cname


def mask_materials():
    out = []
    for c in range(5):
        v = c * MASK_STEP / 255; m = bpy.data.materials.new(f'cls{c}'); m.diffuse_color = (v, v, v, 1); out.append(m)
    return out


def finger(rnd, loc, rot, size, skin):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1, location=loc, rotation=rot)
    o = bpy.context.object; o.scale = size
    bpy.ops.object.shade_smooth()
    o.data.materials.append(skin); return o


def scene_setup(rnd, tool, view):
    sc = bpy.context.scene
    sc.render.resolution_x = sc.render.resolution_y = A.res
    # world: studio-ish gradient, random brightness
    w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    dark = rnd.random() < 0.6
    bg.inputs['Color'].default_value = (*([rnd.uniform(0.01, 0.06)] * 3 if dark else [rnd.uniform(0.3, 0.8)] * 3), 1)
    bg.inputs['Strength'].default_value = rnd.uniform(0.3, 1.0)
    # backdrop plane far behind: random colour (dark desk, grey card, white paper, wood-ish)
    bcol = rnd.choice([(0.02, 0.02, 0.025), (0.05, 0.05, 0.06), (0.18, 0.18, 0.19), (0.7, 0.7, 0.68), (0.25, 0.15, 0.08), (0.03, 0.05, 0.08)]) if dark or rnd.random() < .5 else (0.75, 0.75, 0.73)
    bm = principled('backdrop', bcol, 0.0, rnd.uniform(0.4, 0.9), bump=0.05, noise_scale=30)
    return dark, bm


def light(rnd, name, loc, energy, size):
    L = bpy.data.lights.new(name, 'AREA'); L.energy = energy; L.size = size
    o = bpy.data.objects.new(name, L); o.location = loc; bpy.context.collection.objects.link(o)
    d = Vector((0, 0, 0)) - Vector(loc); o.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return o


def render_one(idx):
    rnd = random.Random(A.seed * 100003 + idx)
    clear()
    sc = bpy.context.scene
    import time; t0 = time.time()
    tool = Tool(rnd); wear = Wear(tool, rnd)
    ob = build(tool, wear, rnd)
    print('TIMING build', round(time.time() - t0, 2))
    mats, cname = materials(rnd)
    for m in mats: ob.data.materials.append(m)
    # tip up (as the operator holds it) or tip down
    tip_up = rnd.random() < 0.75
    ob.rotation_euler = (math.pi if tip_up else 0, 0, rnd.uniform(0, 2 * math.pi))
    ob.location = (0, 0, tool.L if tip_up else 0)  # tip at world z = L when tip up
    tipz = tool.L if tip_up else 0.0
    bpy.context.view_layer.update()
    view = rnd.choices(['side', 'top', 'oblique'], [0.6, 0.2, 0.2])[0]
    dark, backmat = scene_setup(rnd, tool, view)
    skin = principled('skin', rnd.choice([(0.8, 0.55, 0.45), (0.65, 0.42, 0.32), (0.45, 0.3, 0.22), (0.9, 0.7, 0.6)]), 0.0, 0.5)
    try:
        b = next(n for n in skin.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        b.inputs['Subsurface Weight'].default_value = 0.3
    except Exception: pass
    extra = []
    # camera
    cam = bpy.data.cameras.new('cam'); cam.lens = rnd.uniform(35, 80); co = bpy.data.objects.new('cam', cam)
    bpy.context.collection.objects.link(co); sc.camera = co; cam.clip_start = 0.05; cam.clip_end = 1e5
    show = tool.D * rnd.uniform(1.6, 4.0)   # field of view height in mm around the tip
    fov = 2 * math.atan(cam.sensor_width / 2 / cam.lens)
    dist = show / 2 / math.tan(fov / 2)
    dirz = 1 if tip_up else -1
    if view == 'side': elev = rnd.uniform(-12, 20)
    elif view == 'top': elev = rnd.uniform(70, 88)
    else: elev = rnd.uniform(25, 60)
    az = rnd.uniform(0, 2 * math.pi)
    e = math.radians(elev)
    # target: a point on the axis near the tip (side) or the tip itself (top)
    tz = tipz - dirz * (show * rnd.uniform(0.15, 0.4) if view != 'top' else 0)
    tgt = Vector((rnd.uniform(-.1, .1) * tool.D, rnd.uniform(-.1, .1) * tool.D, tz))
    pos = tgt + Vector((math.cos(az) * math.cos(e), math.sin(az) * math.cos(e), dirz * math.sin(e))) * dist
    co.location = pos; co.rotation_euler = (tgt - pos).to_track_quat('-Z', 'Y').to_euler()
    co.rotation_euler.rotate_axis('Z', math.radians(rnd.uniform(-15, 15)))
    # backdrop plane behind the tool, facing the camera
    bpy.ops.mesh.primitive_plane_add(size=dist * 20, location=tgt - (pos - tgt).normalized() * dist * rnd.uniform(1.5, 4))
    bp = bpy.context.object; bp.rotation_euler = (pos - tgt).to_track_quat('Z', 'Y').to_euler(); bp.data.materials.append(backmat); extra.append(bp)
    # fingers holding the shank (side / oblique) or around the body (top)
    if rnd.random() < 0.7:
        fr = tool.R * rnd.uniform(1.0, 1.6)
        n_f = rnd.randint(1, 3)
        for q in range(n_f):
            ang = az + math.pi + rnd.uniform(-1.2, 1.2) if view != 'top' else rnd.uniform(0, 2 * math.pi)
            zf = tipz - dirz * (tool.Lf * rnd.uniform(0.6, 1.3) if view != 'top' else rnd.uniform(0.2, 0.6) * tool.D)
            rr = tool.R + fr * 0.8
            loc = (rr * math.cos(ang), rr * math.sin(ang), zf)
            extra.append(finger(rnd, loc, (rnd.uniform(-.4, .4), rnd.uniform(-.4, .4), ang), (fr * 0.9, fr * 0.9, fr * rnd.uniform(1.6, 2.6)), skin))
    # lights
    key = rnd.uniform(0.5, 3.0) * dist ** 2 * 4
    light(rnd, 'key', tuple(pos + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(0, 1))) * dist), key, dist * rnd.uniform(0.2, 1.0))
    if rnd.random() < 0.7:
        light(rnd, 'fill', tuple(tgt + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-.5, 1))) * dist), key * rnd.uniform(0.1, 0.6), dist)
    if rnd.random() < 0.5:  # ring light / phone flash near the camera
        light(rnd, 'flash', tuple(pos * 1.0), key * rnd.uniform(0.2, 0.8), dist * 0.1)
    # ---- photo render (Cycles GPU)
    sc.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'; prefs.get_devices()
        for d in prefs.devices: d.use = True
        sc.cycles.device = 'GPU'
    except Exception:
        pass
    sc.cycles.samples = A.samples; sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'AgX' if rnd.random() < 0.5 else 'Standard'
    sc.view_settings.exposure = rnd.uniform(-0.8, 0.6)
    # depth of field like a phone macro
    if rnd.random() < 0.5:
        cam.dof.use_dof = True; cam.dof.focus_distance = dist
        cam.dof.aperture_fstop = rnd.uniform(1.8, 8)
    name = f'synth_{A.seed}_{idx:05d}'
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'
    sc.render.filepath = os.path.join(A.out, 'img', name + '.png')
    t1 = time.time(); bpy.ops.render.render(write_still=True); print('TIMING cycles', round(time.time() - t1, 2))
    # ---- mask render (Workbench flat, no AA, class value in 0..4)
    mm = mask_materials()
    for s_ in range(len(ob.data.materials)): ob.data.materials[s_] = mm[[1, 1, 2, 3, 4][s_]]
    for o in extra:
        for s_ in range(len(o.data.materials)): o.data.materials[s_] = mm[0]
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'FLAT'; sc.display.shading.color_type = 'MATERIAL'
    sc.display.render_aa = 'OFF'; sc.display.shading.show_shadows = False; sc.display.shading.show_cavity = False
    sc.world.color = (0, 0, 0)
    sc.view_settings.view_transform = 'Raw'; sc.view_settings.exposure = 0; sc.view_settings.look = 'None'
    sc.display_settings.display_device = 'sRGB'
    sc.render.image_settings.color_mode = 'BW'; sc.render.dither_intensity = 0
    sc.render.filepath = os.path.join(A.out, 'mask', name + '.png')
    cam.dof.use_dof = False
    t1 = time.time(); bpy.ops.render.render(write_still=True); print('TIMING mask', round(time.time() - t1, 2))
    pxmm = A.res / show if view != 'oblique' else None
    meta = dict(name=name, flutes=tool.k, diameterMm=tool.D, helixDeg=tool.helix, cornerRadiusMm=tool.cr, coating=cname,
                wearState=wear.state, vbMm=round(wear.vb, 4), vbCornerMm=round(wear.corner, 4), apMm=round(wear.ap, 3),
                endVbMm=round(wear.end_vb, 4), chips=wear.chips, adhesion=wear.adh, view=view, elevationDeg=elev,
                tipUp=tip_up, pxPerMm=pxmm, darkBackground=dark, fingers=len(extra) - 1)
    json.dump(meta, open(os.path.join(A.out, 'meta', name + '.json'), 'w'))


bpy.ops.wm.read_factory_settings(use_empty=True)
for i in range(A.start, A.start + A.n):
    render_one(i)
print('SYNTH DONE', A.n)
