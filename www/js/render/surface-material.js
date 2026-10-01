// Tool3D render: scanner-style surface shader (procedural, no textures besides the 8 KB wear row texture).
// MeshStandardMaterial patched via onBeforeCompile; reads per-vertex aReg/aSurf from endmill-geometry.js.
//  - ground flank lands / end face / shank: bright carbide with grinding marks (bump + roughness streaks)
//  - heel, rake, chip pocket: dark AlTiN-like coating with fine speckle
//  - micro-chipping noise along the cutting edge
//  - flank wear band from the VB(z) texture: soft boundary, yellow -> red ramp toward the edge
//  - optional focus-variation point-cloud look (uCloud): fragments kept only on a jittered dot grid
//  - display modes (uMode): 0 CAD (procedural carbide), 1 true-colour photo texture (photos projected onto the model by
//    js/map3d/photo-map.js: side azimuth x z, end disc; alpha = coverage, CAD where no photo sees the surface),
//    2 deviation vs nominal (um, symmetric rainbow, green = on nominal), 3 radial height r - R (um)
// All marks fade out with fwidth() so they never alias; cost is a few noise taps per fragment.
(function () {
  'use strict';
  const T3 = window.Tool3D = window.Tool3D || {};
  const NS = T3._render = T3._render || {};

  const uniforms = {
    uWearTex: {value: null}, uZMax: {value: 1}, uVbMax: {value: 1}, uRows: {value: 8}, uWearOn: {value: 1},
    uCloud: {value: 0}, uBump: {value: 1},
    // per-face segmentation map (js/map3d): side atlas (azimuth x z) and end atlas (X x Y), RGB = flank/chip/adhesion
    uMapOn: {value: 0}, uSideTex: {value: null}, uEndTex: {value: null}, uSideZMax: {value: 1}, uMapR: {value: 5},
    // display mode + photo texture (side: u = model azimuth, v = z * uPhotoS; end disc at uPhotoCap) + deviation / height ramps
    uMode: {value: 0}, uPhoto: {value: null}, uPhotoEnd: {value: null}, uPhotoOn: {value: 0}, uPhotoEndOn: {value: 0}, uPhotoZ: {value: 1}, uPhotoR: {value: 5},
    uDevSide: {value: null}, uDevEnd: {value: null}, uDevOn: {value: 0}, uDevRange: {value: .01}, uDevScale: {value: .01}, uDevZMax: {value: 1}, uDevR: {value: 5},
    uHMin: {value: -1}, uR: {value: 5}
  };

  const VERT_HEAD = `
attribute vec4 aReg;
attribute vec2 aSurf;
varying vec4 vReg;
varying vec2 vSurf;
varying vec3 vTool;
`;
  const FRAG_HEAD = `
uniform sampler2D uWearTex;
uniform float uZMax, uVbMax, uRows, uWearOn, uCloud, uBump, uMapOn, uSideZMax, uMapR;
uniform sampler2D uSideTex, uEndTex;
uniform float uMode, uPhotoOn, uPhotoEndOn, uPhotoZ, uPhotoR, uDevOn, uDevRange, uDevScale, uDevZMax, uDevR, uHMin, uR;
uniform sampler2D uPhoto, uPhotoEnd, uDevSide, uDevEnd;
// metrology rainbow: 0 blue -> cyan -> green (.5) -> yellow -> 1 red
vec3 ramp(float t) {
  t = clamp(t, 0., 1.);
  vec3 c = t < .25 ? mix(vec3(.05, .1, .85), vec3(0., .75, 1.), t / .25) : t < .5 ? mix(vec3(0., .75, 1.), vec3(.1, .85, .2), (t - .25) / .25) :
    t < .75 ? mix(vec3(.1, .85, .2), vec3(1., .9, 0.), (t - .5) / .25) : mix(vec3(1., .9, 0.), vec3(.9, .05, .05), (t - .75) / .25);
  return c * c;                                   // sRGB-ish -> linear
}
varying vec4 vReg;
varying vec2 vSurf;
varying vec3 vTool;
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
  // true-colour photo texture (before the wear / class overlays, so those stay on top)
  if (uMode > .5 && uMode < 1.5 && uPhotoOn > .5) {
    vec4 pc = vec4(0.);
    if (reg > 4.5 && reg < 5.5) { if (uPhotoEndOn > .5) pc = texture2D(uPhotoEnd, vTool.xy / (2. * uPhotoR) + .5); }
    else if (reg < 5.5 && vTool.z >= 0. && vTool.z < uPhotoZ) pc = texture2D(uPhoto, vec2(fract(atan(vTool.y, vTool.x) / 6.2831853), vTool.z / uPhotoZ));
    float pa = smoothstep(.05, .6, pc.a);
    sAlb = mix(sAlb, pow(pc.rgb / max(pc.a, .02), vec3(2.2)) * 1.05, pa); sRough = mix(sRough, .5, pa); sMetal = mix(sMetal, .12, pa); sH *= 1. - .5 * pa;
  }
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
  // per-face segmentation classes mapped onto the model (flank amber, chipping magenta, adhesion blue)
  if (uMapOn > .5 && reg < 5.5) {
    vec4 mc = vec4(0.);
    if (reg > 4.5) mc = texture2D(uEndTex, vTool.xy / (2. * uMapR) + .5);
    else if (vTool.z < uSideZMax) mc = texture2D(uSideTex, vec2(fract(atan(vTool.y, vTool.x) / 6.2831853), vTool.z / uSideZMax));
    float aF = smoothstep(.3, .55, mc.r), aC = smoothstep(.3, .55, mc.g), aA = smoothstep(.3, .55, mc.b);
    sAlb = mix(sAlb, vec3(.95, .38, .01), aF); sRough = mix(sRough, .6, aF); sMetal = mix(sMetal, 0., aF);
    float fr = vn(vec2(u, z) * 90.);
    sAlb = mix(sAlb, vec3(.78, .03, .32) * (.7 + .5 * fr), aC); sRough = mix(sRough, .8, aC); sMetal = mix(sMetal, .05, aC); sH += aC * (fr - .5) * .01;
    sAlb = mix(sAlb, vec3(.08, .45, .95), aA); sRough = mix(sRough, .65, aA); sMetal = mix(sMetal, .1, aA);
  }
`;
  // deviation / height modes replace the albedo after the CAD surface and overlays (the bump relief stays, damped)
  const FRAG_MODE = `
  if (uMode > 1.5 && uMode < 2.5) {                     // deviation vs nominal
    float d = 0.;
    if (uDevOn > .5) {
      if (reg > 4.5 && reg < 5.5) d = -texture2D(uDevEnd, vTool.xy / (2. * uDevR) + .5).r * uDevRange;
      else if (vTool.z < uDevZMax && reg < 5.5) d = -texture2D(uDevSide, vec2(fract(atan(vTool.y, vTool.x) / 6.2831853), vTool.z / uDevZMax)).r * uDevRange;
    }
    sAlb = ramp(.5 + .5 * d / uDevScale); sRough = .5; sMetal = .05; sH *= .3;
  } else if (uMode > 2.5) {                                    // radial height r - R
    float h = length(vTool.xy) - uR;
    sAlb = ramp(1. - clamp(h / uHMin, 0., 1.)); sRough = .5; sMetal = .05; sH *= .3;
  }
`;

  function create() {
    const m = new THREE.MeshStandardMaterial({color: 0xffffff, metalness: .85, roughness: .3, side: THREE.DoubleSide, envMapIntensity: .8});
    m.extensions = {derivatives: true};
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = VERT_HEAD + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vReg = aReg; vSurf = aSurf; vTool = position;');
      sh.fragmentShader = FRAG_HEAD + sh.fragmentShader
        .replace('#include <color_fragment>', FRAG_SURF + FRAG_MODE + '\n  diffuseColor.rgb = sAlb;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  roughnessFactor = sRough; metalnessFactor = sMetal;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n  normal = bumpN(-vViewPosition, normal, sH * uBump, faceDirection);');
    };
    return m;
  }

  NS.surface = {create, uniforms};
})();
