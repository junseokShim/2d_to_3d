// Tool3D render: scanner-style surface shader (procedural, no textures besides the 8 KB wear row texture).
// MeshStandardMaterial patched via onBeforeCompile; reads per-vertex aReg/aSurf from endmill-geometry.js.
//  - ground flank lands / end face / shank: bright carbide with grinding marks (bump + roughness streaks)
//  - heel, rake, chip pocket: dark AlTiN-like coating with fine speckle
//  - micro-chipping noise along the cutting edge
//  - flank wear band from the VB(z) texture: soft boundary, yellow -> red ramp toward the edge
//  - optional focus-variation point-cloud look (uCloud): fragments kept only on a jittered dot grid
// All marks fade out with fwidth() so they never alias; cost is a few noise taps per fragment.
(function () {
  'use strict';
  const T3 = window.Tool3D = window.Tool3D || {};
  const NS = T3._render = T3._render || {};

  const uniforms = {
    uWearTex: {value: null}, uZMax: {value: 1}, uVbMax: {value: 1}, uRows: {value: 8}, uWearOn: {value: 1},
    uCloud: {value: 0}, uBump: {value: 1}
  };

  const VERT_HEAD = `
attribute vec4 aReg;
attribute vec2 aSurf;
varying vec4 vReg;
varying vec2 vSurf;
`;
  const FRAG_HEAD = `
uniform sampler2D uWearTex;
uniform float uZMax, uVbMax, uRows, uWearOn, uCloud, uBump;
varying vec4 vReg;
varying vec2 vSurf;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
// band-limited line pattern: phase f in cycles; fades to its mean when a cycle is under ~1.5 px
float lines(float f) { float w = fwidth(f); return (.5 + .5 * sin(6.2832 * f)) * clamp(1.5 - 2. * w, 0., 1.) + .5 * clamp(2. * w - .5, 0., 1.); }
float aaAmp(float f) { return clamp(1.5 - 2. * fwidth(f), 0., 1.); }
vec3 bumpN(vec3 pos, vec3 n, float h, float fd) {
  vec3 sx = dFdx(pos), sy = dFdy(pos), r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * fd;
  vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - g);
}
`;
  // Computes sAlb/sRough/sMetal/sH (height, mm) for this fragment.
  const FRAG_SURF = `
  float s = vReg.y, reg = vReg.z, fl = vReg.w, tooth = vReg.x, u = vSurf.x, z = vSurf.y;
  if (uCloud > .5) {
    float pix = max(fwidth(u), fwidth(z));
    float c = .035 * exp2(ceil(log2(max(1., 3. * pix / .035))));
    vec2 q = vec2(u, z) / c, cell = floor(q);
    vec2 ctr = cell + .5 + .6 * (vec2(h21(cell), h21(cell + 17.)) - .5);
    if (length(q - ctr) > .3) discard;
  }
  vec3 sAlb; float sRough, sMetal, sH = 0.;
  // ground carbide: lines parallel to the cutting edge (constant u follows the helix)
  float fg = u * 55. + 1.6 * vn(vec2(u * 9., z * .35));
  float streak = vn(vec2(u * 38., z * .06)) * .6 + vn(vec2(u * 140., z * .2)) * .4;
  float mk = lines(fg) * .65 + lines(u * 170. + 2. * vn(vec2(u * 30., z))) * .35;
  vec3 gAlb = vec3(.60, .61, .63) * (.78 + .34 * streak);
  float gRough = .17 + .16 * streak + .06 * mk, gH = (mk - .5) * .0016;
  if (reg > 4.5 && reg < 5.5) {                       // end face: straight wheel marks across the gash
    float fe = dot(vSurf, vec2(.8, .6)) * 60. + 1.4 * vn(vSurf * 6.);
    mk = lines(fe) * .7 + lines(dot(vSurf, vec2(.8, .6)) * 190.) * .3;
    streak = vn(vec2(dot(vSurf, vec2(.8, .6)) * 30., dot(vSurf, vec2(-.6, .8)) * .5));
    gAlb = vec3(.58, .59, .61) * (.84 + .22 * streak); gRough = .22 + .1 * streak; gH = (mk - .5) * .0009;
  }
  // shank: fine circumferential cylindrical-grinding marks
  float sk = lines(z * 45. + .8 * vn(vec2(u * 3., z * 2.)));
  vec3 kAlb = vec3(.50, .51, .53) * (.9 + .15 * sk);
  float kRough = .28 + .06 * sk, kH = (sk - .5) * .0008;
  // AlTiN-like coating: near-black violet grey with droplet speckle
  float sp = vn(vec2(u, z) * 260.) * aaAmp(u * 260.) + .5 * (1. - aaAmp(u * 260.));
  vec3 cAlb = vec3(.050, .046, .056) * (.75 + .6 * sp);
  float cRough = .40 + .12 * sp, cH = (sp - .5) * .0004;
  float coated = step(1.5, reg) * step(reg, 4.5);
  float shank = reg > 5.5 ? 1. : 1. - fl;
  sAlb = mix(gAlb, cAlb, coated); sRough = mix(gRough, cRough, coated); sMetal = mix(.9, .55, coated); sH = mix(gH, cH, coated);
  sAlb = mix(sAlb, kAlb, shank); sRough = mix(sRough, kRough, shank); sMetal = mix(sMetal, .9, shank); sH = mix(sH, kH, shank);
  bool land = s < 50. && tooth > -.5;
  // micro-chipping: sparse notches along the edge plus a ragged few-micron hone
  if (land) {
    float cn = vn(vec2(z * 16., tooth * 7.3));
    float chipW = .045 * smoothstep(.62, .95, cn) + .006 + .006 * vn(vec2(z * 140., tooth));
    float ch = 1. - smoothstep(chipW - max(.003, fwidth(s)), chipW, s);
    sAlb = mix(sAlb, vec3(.13, .13, .14), ch); sRough = mix(sRough, .75, ch); sH -= ch * .004;
  }
  // flank wear band
  if (land && uWearOn > .5) {
    float vb = texture2D(uWearTex, vec2(clamp(z / uZMax, 0., 1.), (tooth + .5) / uRows)).r * uVbMax;
    float soft = max(.012, 1.5 * fwidth(s));
    float a = (1. - smoothstep(vb - soft, vb, s)) * smoothstep(.004, .02, vb);
    float t = clamp(1. - s / max(vb, 1e-4), 0., 1.);
    vec3 wc = mix(vec3(.95, .72, .08), vec3(.92, .30, .03), smoothstep(0., .12, t));
    wc = mix(wc, vec3(.52, .006, .005), smoothstep(.12, .3, t));
    sAlb = mix(sAlb, wc, a); sRough = mix(sRough, .55, a); sMetal = mix(sMetal, .05, a); sH *= 1. - .8 * a;
  }
`;

  function create() {
    const m = new THREE.MeshStandardMaterial({color: 0xffffff, metalness: .85, roughness: .3, side: THREE.DoubleSide, envMapIntensity: .8});
    m.extensions = {derivatives: true};
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = VERT_HEAD + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vReg = aReg; vSurf = aSurf;');
      sh.fragmentShader = FRAG_HEAD + sh.fragmentShader
        .replace('#include <color_fragment>', FRAG_SURF + '\n  diffuseColor.rgb = sAlb;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  roughnessFactor = sRough; metalnessFactor = sMetal;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n  normal = bumpN(-vViewPosition, normal, sH * uBump, faceDirection);');
    };
    return m;
  }

  NS.surface = {create, uniforms};
})();
