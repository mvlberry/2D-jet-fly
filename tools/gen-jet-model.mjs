// Builds the jet's sprite stack (src/lib/jet-model.ts) from the four-view artwork.
// Not part of the running scene — run it by hand when the art or the jet's native size changes:
//
//   ffmpeg -i assets/jet-four-views.png -f rawvideo -pix_fmt rgba /tmp/jet.rgba
//   node tools/gen-jet-model.mjs /tmp/jet.rgba /tmp/jet-out 46      (46 = length of the jet in px)
//   cp /tmp/jet-out/jet-model.ts src/lib/jet-model.ts
//
// It also writes slices.png and stack.png (the stack turned to many angles) for a quick look.
// The top view gives the colours; the heights of the fuselage, wings and canted fins are set
// by hand below (section 3), read off the side, front and back views.
import fs from 'node:fs';
import path from 'node:path';
import { writePNG, upscale } from './png.mjs';

const SRC_W = 2172, SRC_H = 724;
const src = fs.readFileSync(process.argv[2]);
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });

// native size of the stack: length in px (the art is resampled to it)
const L = +(process.argv[4] || 48);
const W = Math.round((L * 0.75) / 2) * 2;
const S = L / 64; // heights below are written for a 64 px long jet
const H = Math.ceil(18 * S);
const DEEP = Math.max(2, Math.round(3 * S));
const TOP = { x0: 24, y0: 20, x1: 485, y1: 636 }; // exclusive end

// ---------- 1. downsample the top view (left half mirrored for symmetry)
const cellW = (TOP.x1 - TOP.x0) / W, cellH = (TOP.y1 - TOP.y0) / L;
const topRGB = new Float32Array(W * L * 3);
const topCov = new Float32Array(W * L);
function sampleCell(i, k) {
  const xa = TOP.x0 + i * cellW, xb = xa + cellW, ya = TOP.y0 + k * cellH, yb = ya + cellH;
  let r = 0, g = 0, b = 0, n = 0, cov = 0, tot = 0;
  // collect
  const px = [];
  for (let y = Math.floor(ya); y < Math.ceil(yb); y++) {
    for (let x = Math.floor(xa); x < Math.ceil(xb); x++) {
      if (x < 0 || y < 0 || x >= SRC_W || y >= SRC_H) continue;
      const o = (y * SRC_W + x) * 4;
      tot++;
      if (src[o + 3] > 128) { cov++; px.push([src[o], src[o + 1], src[o + 2]]); }
    }
  }
  if (!px.length) return { cov: 0, c: [0, 0, 0] };
  // robust colour: average of the pixels closest to the median luminance (keeps it crisp)
  px.sort((p, q) => (p[0] * 3 + p[1] * 6 + p[2]) - (q[0] * 3 + q[1] * 6 + q[2]));
  const lo = Math.floor(px.length * 0.3), hi = Math.max(lo + 1, Math.ceil(px.length * 0.8));
  for (let j = lo; j < hi; j++) { r += px[j][0]; g += px[j][1]; b += px[j][2]; n++; }
  return { cov: cov / tot, c: [r / n, g / n, b / n] };
}
for (let k = 0; k < L; k++) {
  for (let i = 0; i < W / 2; i++) {
    const a = sampleCell(i, k), bb = sampleCell(W - 1 - i, k);
    // use the left half; coverage is the mean of both sides
    const cov = (a.cov + bb.cov) / 2;
    const c = a.cov >= bb.cov ? a.c : bb.c;
    for (const ii of [i, W - 1 - i]) {
      const o = k * W + ii;
      topCov[o] = cov;
      topRGB[o * 3] = c[0]; topRGB[o * 3 + 1] = c[1]; topRGB[o * 3 + 2] = c[2];
    }
  }
}
const sil = new Uint8Array(W * L);
for (let o = 0; o < W * L; o++) sil[o] = topCov[o] >= 0.42 ? 1 : 0;
// remove orphan cells / fill single holes
for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) {
  const o = k * W + i;
  let n = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = i + dx, y = k + dy;
    if (x >= 0 && y >= 0 && x < W && y < L && sil[y * W + x]) n++;
  }
  if (sil[o] && n === 0) sil[o] = 0;
  if (!sil[o] && n === 4) sil[o] = 1;
}
const inSil = (i, k) => i >= 0 && k >= 0 && i < W && k < L && sil[k * W + i] === 1;

// ---------- 2. colour treatment → small palette
// classify hue families so they can be recoloured at runtime: 0 body, 1 accent (orange), 2 canopy (teal)
function family(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  if (sat > 0.45 && r > g && r > b && r > 110) return 1;
  if (sat > 0.35 && b >= r && g > r * 1.25) return 2;
  return 0;
}
// fixed ramps per family (hand tuned from the art), index = tone
const RAMP = {
  0: [[14, 15, 22], [29, 31, 42], [44, 47, 60], [61, 65, 80], [84, 89, 105], [112, 118, 134], [150, 156, 170], [196, 201, 211], [236, 239, 244]],
  1: [[92, 24, 8], [150, 40, 6], [205, 62, 6], [240, 88, 14], [255, 128, 40], [255, 176, 96]],
  2: [[4, 38, 52], [6, 70, 90], [14, 106, 128], [30, 140, 160], [84, 178, 190], [214, 240, 240]],
};
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
function nearestTone(fam, c) {
  const ramp = RAMP[fam];
  let best = 0, bd = 1e9;
  for (let t = 0; t < ramp.length; t++) {
    const d = (ramp[t][0] - c[0]) ** 2 + (ramp[t][1] - c[1]) ** 2 + (ramp[t][2] - c[2]) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
// palette index encoding: 1 + fam*16 + tone   (0 = empty)
const palIndex = (fam, tone) => 1 + fam * 16 + tone;
const topFam = new Uint8Array(W * L), topTone = new Uint8Array(W * L);
for (let o = 0; o < W * L; o++) {
  if (!sil[o]) continue;
  const c = [topRGB[o * 3], topRGB[o * 3 + 1], topRGB[o * 3 + 2]];
  const f = family(c[0], c[1], c[2]);
  topFam[o] = f;
  topTone[o] = nearestTone(f, c);
}
// silhouette outline → darkest body tone
const isEdge = (i, k) => !inSil(i - 1, k) || !inSil(i + 1, k) || !inSil(i, k - 1) || !inSil(i, k + 1);

// ---------- 3. heights
const lerp = (a, b, t) => a + (b - a) * t;
function pw(points, v) { // piecewise linear
  if (v <= points[0][0]) return points[0][1];
  for (let j = 1; j < points.length; j++) {
    if (v <= points[j][0]) {
      const [v0, h0] = points[j - 1], [v1, h1] = points[j];
      return lerp(h0, h1, (v - v0) / (v1 - v0));
    }
  }
  return points[points.length - 1][1];
}
const TOP_C = [[0, 5.3], [0.1, 6.7], [0.2, 8.2], [0.25, 10.4], [0.32, 12.3], [0.41, 12.6], [0.47, 11.8], [0.55, 11.1], [0.75, 10.6], [0.93, 9.8], [1, 9.2]];
const BOT_C = [[0, 4.5], [0.1, 3.5], [0.22, 2.7], [0.32, 2.0], [0.5, 2.0], [0.62, 2.3], [1, 2.6]];
const CORE_W = [[0, 0.17], [0.5, 0.17], [0.62, 0.12], [0.76, 0.06], [1, 0.05]];
const SHOULDER_T = [[0.27, 8.3], [0.4, 9.3], [0.62, 9.5], [0.7, 9.2]];
const NAC_U = 0.115, NAC_R = 0.12, NAC_CY = 5.7, NAC_RY = 4.2;
const WING_ROOT_U = 0.3;
const FIN_U0 = 0.222, FIN_U1 = 0.51;

const topH = new Float32Array(W * L).fill(-1), botH = new Float32Array(W * L).fill(-1);
const part = new Uint8Array(W * L); // 1 body 2 wing 3 stub 4 fin
for (let k = 0; k < L; k++) {
  const v = (k + 0.5) / L;
  // local silhouette half width (for nose roundness)
  let half = 0;
  for (let i = 0; i < W; i++) if (sil[k * W + i]) half = Math.max(half, Math.abs((i + 0.5 - W / 2) / (W / 2)));
  for (let i = 0; i < W; i++) {
    const o = k * W + i;
    if (!sil[o]) continue;
    const u = Math.abs((i + 0.5 - W / 2) / (W / 2));
    const tc = pw(TOP_C, v), bc = pw(BOT_C, v);
    const finLE = 0.767 + (u - 0.228) * 0.447;
    const wingTE = 0.752 + 0.036 * u;
    const bodyHalf = v < 0.29 ? half + 0.001 : v < 0.45 ? lerp(0.26, 0.335, (v - 0.29) / 0.16) : v < 0.74 ? 0.335 : 0.228;
    let p;
    if (u <= bodyHalf && !(v > 0.74 && u > 0.228)) p = 1;
    else if (v >= finLE && u >= FIN_U0) p = 4;
    else if (v > wingTE) p = 3;
    else p = 2;
    part[o] = p;
    let t = 0, b = 0;
    if (p === 1) {
      t = -99; b = 99;
      // core (rounded spine / nose / canopy)
      const cw = v < 0.29 ? Math.max(half, 0.03) : pw(CORE_W, v);
      if (u <= cw + 0.02) {
        const e = Math.sqrt(Math.max(0, 1 - (u / (cw + 0.02)) ** 2));
        const mid = (tc + bc) / 2, hh = (tc - bc) / 2;
        const round = v < 0.29 ? e : 0.45 + 0.55 * e;
        t = Math.max(t, mid + hh * round);
        b = Math.min(b, mid - hh * (v < 0.29 ? e : 0.6 + 0.4 * e));
      }
      // shoulders / intake boxes
      if (v >= 0.27 && v < 0.7 && u > 0.1) {
        const st = pw(SHOULDER_T, v);
        const tt = (u - 0.17) / (0.335 - 0.17);
        t = Math.max(t, st - Math.max(0, tt) * 1.5);
        b = Math.min(b, 2.0 + Math.max(0, tt) * 1.2 + (v > 0.5 ? (v - 0.5) * 6 : 0));
      }
      // engine nacelles
      if (v >= 0.56) {
        const d = (u - NAC_U) / NAC_R;
        if (Math.abs(d) <= 1.08) {
          const e = Math.sqrt(Math.max(0, 1 - Math.min(1, d * d)));
          const grow = Math.min(1, (v - 0.56) / 0.1);
          t = Math.max(t, NAC_CY + NAC_RY * (0.35 + 0.65 * e) * lerp(0.8, 1, grow));
          b = Math.min(b, NAC_CY - NAC_RY * (0.35 + 0.65 * e));
        }
      }
      if (t < -50) { t = 7.6; b = 5.6; }
    } else if (p === 2) {
      const tt = Math.min(1, Math.max(0, (u - WING_ROOT_U) / (1 - WING_ROOT_U)));
      t = lerp(7.7, 6.0, tt);
      b = t - lerp(2.2, 1.3, tt);
    } else if (p === 3) {
      t = 7.2; b = 5.4;
    } else {
      const tt = Math.min(1, Math.max(0, (u - FIN_U0) / (FIN_U1 - FIN_U0)));
      t = lerp(9.2, 17.95, tt);
      b = t - 2.6;
      if (u < 0.3) b = Math.min(b, 6.5);
    }
    topH[o] = t; botH[o] = b;
  }
}

// ---------- 4. voxels
const vox = new Uint8Array(W * L * H); // palette index
const at = (i, y, k) => (i < 0 || y < 0 || k < 0 || i >= W || y >= H || k >= L) ? 0 : vox[(y * L + k) * W + i];
const topIdx = new Int16Array(W * L).fill(-1), botIdx = new Int16Array(W * L).fill(-1);
for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) {
  const o = k * W + i;
  if (!sil[o]) continue;
  let yt = Math.min(H - 1, Math.max(0, Math.floor(topH[o] * S)));
  let yb = Math.min(yt, Math.max(0, Math.ceil(botH[o] * S - 0.5)));
  topIdx[o] = yt; botIdx[o] = yb;
}
const shadeTone = (fam, tone, d) => Math.max(0, tone - d);
for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) {
  const o = k * W + i;
  if (!sil[o]) continue;
  const fam = topFam[o];
  let tone = topTone[o];
  const edge = isEdge(i, k);
  for (let y = botIdx[o]; y <= topIdx[o]; y++) {
    let f = fam, t = tone;
    if (y === topIdx[o]) {
      if (edge) { f = 0; t = fam === 0 ? 0 : 0; if (fam !== 0) { f = fam; t = 0; } }
    } else {
      // body below the surface: darker; deeper = darker still
      const depth = topIdx[o] - y;
      if (fam === 2 && depth >= 3) { f = 0; t = 1; }
      else {
        t = shadeTone(fam, tone, fam === 0 ? (depth >= 3 ? 2 : 1) : (depth >= 3 ? 2 : 1));
        if (fam === 0) t = Math.max(1, Math.min(t, 4));
      }
      if (edge) t = Math.max(0, t - 1);
    }
    vox[(y * L + k) * W + i] = palIndex(f, t);
  }
}
// below the surface: the rim of every slice is a dark outline (these are the "walls" you see
// when the slices are stacked); the inside keeps the art's colour, one tone down, so a slice
// pulled out of the stack still reads as a piece of the top view.
{
  const RIM = { 0: 2, 1: 1, 2: 1 };
  const next = new Uint8Array(vox);
  for (let y = 0; y < H; y++) for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) {
    const o = k * W + i;
    if (!at(i, y, k) || y >= topIdx[o]) continue;
    const fam = topFam[o], tone = topTone[o], depth = topIdx[o] - y;
    const rim = !at(i - 1, y, k) || !at(i + 1, y, k) || !at(i, y, k - 1) || !at(i, y, k + 1);
    let f = fam, t;
    if (fam === 2 && depth >= DEEP) { f = 0; t = rim ? 2 : 3; }
    else if (rim) t = Math.min(RIM[fam], tone);
    else t = Math.max(1, tone - 1);
    next[(y * L + k) * W + i] = palIndex(f, t);
  }
  vox.set(next);
}
// rear faces of the nacelles → glowing nozzles ; front faces of the shoulders → dark intakes
const GLOW = 3; // extra family: engine glow
const GLOW_RAMP = [[70, 22, 14], [176, 48, 10], [248, 110, 16], [255, 178, 54], [255, 236, 170]];
for (let i = 0; i < W; i++) {
  const u = Math.abs((i + 0.5 - W / 2) / (W / 2));
  for (let y = 0; y < H; y++) {
    // rear-most body voxel along k
    for (let k = L - 1; k >= 0; k--) {
      if (!at(i, y, k)) continue;
      const o = k * W + i;
      if (part[o] === 1 && (k + 0.5) / L > 0.85) {
        const dx = (u - NAC_U) / NAC_R, dy = (y + 0.5 - NAC_CY * S) / (NAC_RY * S);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 0.86) {
          const tone = d < 0.3 ? 4 : d < 0.52 ? 3 : d < 0.7 ? 2 : 1;
          vox[(y * L + k) * W + i] = palIndex(GLOW, tone);
          // one voxel deeper so it also reads from above/behind at an angle
          if (k > 0 && at(i, y, k - 1) && d < 0.6) vox[(y * L + k - 1) * W + i] = palIndex(GLOW, Math.max(0, tone - 2));
        } else if (d < 1.15) {
          vox[(y * L + k) * W + i] = palIndex(0, 1);
        }
      }
      break;
    }
    // front-most voxel along k
    for (let k = 0; k < L; k++) {
      if (!at(i, y, k)) continue;
      const o = k * W + i, v = (k + 0.5) / L;
      if (part[o] === 1 && v > 0.26 && v < 0.5 && u > 0.15 && u < 0.36 && y < topIdx[o] && y > botIdx[o]) {
        vox[(y * L + k) * W + i] = palIndex(0, 0);
      }
      break;
    }
  }
}

// ---------- 5. palette
const palette = new Array(1 + 4 * 16).fill(null); // [r,g,b,family]
for (const f of [0, 1, 2]) RAMP[f].forEach((c, t) => { palette[palIndex(f, t)] = [...c, f]; });
GLOW_RAMP.forEach((c, t) => { palette[palIndex(GLOW, t)] = [...c, GLOW]; });

let count = 0;
for (let o = 0; o < vox.length; o++) if (vox[o]) count++;
console.log('voxels', count, 'dims', W, L, H);
const perSlice = [];
for (let y = 0; y < H; y++) { let c = 0; for (let o = 0; o < W * L; o++) if (vox[y * W * L + o]) c++; perSlice.push(c); }
console.log('per slice', perSlice.join(' '));

let nozzleK = 0;
for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) if (part[k * W + i] === 1 && topIdx[k * W + i] >= 0) nozzleK = Math.max(nozzleK, k + 0.6);
console.log('nozzle row', nozzleK);

// ---------- 6. write model (json for previews + rle/base64 for the app)
const rle = [];
{
  let run = 0, cur = vox[0];
  const flush = () => { while (run > 0) { const n = Math.min(255, run); rle.push(n, cur); run -= n; } };
  for (let o = 0; o < vox.length; o++) {
    if (vox[o] === cur) run++;
    else { flush(); cur = vox[o]; run = 1; }
  }
  flush();
}
const b64 = Buffer.from(rle).toString('base64');
console.log('rle bytes', rle.length, 'b64 chars', b64.length);
fs.writeFileSync(path.join(outDir, 'model.json'), JSON.stringify({ W, L, H, palette, vox: Array.from(vox) }));
const palLines = palette.map((p, idx) => (p ? `  [${idx}, ${p[0]}, ${p[1]}, ${p[2]}, ${p[3]}],` : null)).filter(Boolean).join('\n');
const chunks = b64.match(/.{1,120}/g).map((s) => `  '${s}',`).join('\n');
fs.writeFileSync(path.join(outDir, 'jet-model.ts'), `// Sprite stack of the fighter jet: ${H} horizontal slices of ${W}×${L} px, cut from the
// four-view pixel art (top / side / front / back). Slice 0 is the belly, slice ${H - 1} the fin tips.
// Each voxel is a palette index; 0 is empty. Data is run-length encoded (count, index) → base64.

export const JET_W = ${W}
export const JET_L = ${L}
export const JET_H = ${H}

/** where things sit on the model, in px: pivot, engines (off-centre, height, radius, nozzle row), wingtips */
export const JET_PIVOT_K = ${(L * 0.55).toFixed(2)}
export const JET_PIVOT_Y = ${Math.round(7 * S)}
export const JET_ENGINE_A = ${(NAC_U * W / 2).toFixed(2)}
export const JET_ENGINE_Y = ${(NAC_CY * S).toFixed(2)}
export const JET_ENGINE_R = ${(NAC_R * W / 2 * 0.8).toFixed(2)}
export const JET_NOZZLE_K = ${nozzleK.toFixed(1)}
export const JET_WINGTIP_A = ${(W / 2 - 1.5).toFixed(1)}
export const JET_WINGTIP_K = ${Math.round(0.72 * L)}
export const JET_WINGTIP_Y = ${Math.floor(6.0 * S)}

/** [index, r, g, b, family] — family 0 body, 1 accent, 2 canopy, 3 engine glow */
export const JET_PALETTE: number[][] = [
${palLines}
]

const DATA = [
${chunks}
].join('')

/** Decodes to JET_H slices, each a Uint8Array(JET_W * JET_L) of palette indices (row = nose → tail). */
export function decodeJet(): Uint8Array[] {
  const bin = atob(DATA)
  const flat = new Uint8Array(JET_W * JET_L * JET_H)
  let o = 0
  for (let i = 0; i < bin.length; i += 2) {
    const n = bin.charCodeAt(i)
    const v = bin.charCodeAt(i + 1)
    flat.fill(v, o, o + n)
    o += n
  }
  const slices: Uint8Array[] = []
  for (let y = 0; y < JET_H; y++) slices.push(flat.subarray(y * JET_W * JET_L, (y + 1) * JET_W * JET_L))
  return slices
}
`);

// ---------- 7. previews
const rgbaOf = (idx) => { const p = palette[idx]; return p ? [p[0], p[1], p[2], 255] : [255, 0, 255, 255]; };
// (a) top map + slices sheet
{
  const cols = 10, rows = Math.ceil(H / cols), pad = 2;
  const sw = cols * (W + pad) + pad, sh = rows * (L + pad) + pad;
  const img = new Uint8Array(sw * sh * 4);
  for (let p = 0; p < sw * sh; p++) { img[p * 4] = 106; img[p * 4 + 1] = 127; img[p * 4 + 2] = 150; img[p * 4 + 3] = 255; }
  for (let y = 0; y < H; y++) {
    const ox = pad + (y % cols) * (W + pad), oy = pad + Math.floor(y / cols) * (L + pad);
    for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) {
      const v = vox[(y * L + k) * W + i];
      if (!v) continue;
      const c = rgbaOf(v), d = ((oy + k) * sw + ox + i) * 4;
      img[d] = c[0]; img[d + 1] = c[1]; img[d + 2] = c[2]; img[d + 3] = 255;
    }
  }
  writePNG(path.join(outDir, 'slices.png'), sw * 3, sh * 3, upscale(sw, sh, img, 3));
}
// (b) stacked renders
function renderStack(buf, bw, bh, cx, cy, yaw, roll, pitch, spread) {
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  // world axes: +x right, +y down-screen, +z up.  heading 0 = flying up-screen
  let f = [sn, -cs, 0], r = [cs, sn, 0], u = [0, 0, 1];
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const r2 = [r[0] * cr - u[0] * sr, r[1] * cr - u[1] * sr, r[2] * cr - u[2] * sr];
  const u2 = [u[0] * cr + r[0] * sr, u[1] * cr + r[1] * sr, u[2] * cr + r[2] * sr];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const f3 = [f[0] * cp + u2[0] * sp, f[1] * cp + u2[1] * sp, f[2] * cp + u2[2] * sp];
  const u3 = [u2[0] * cp - f[0] * sp, u2[1] * cp - f[1] * sp, u2[2] * cp - f[2] * sp];
  const P = (v) => [v[0], v[1] - v[2]];
  const Pr = P(r2), Pf = P(f3), Pu = P(u3);
  const facing = u3[1] + u3[2]; // dot with view dir (0,1,1)
  const order = [];
  for (let y = 0; y < H; y++) order.push(facing >= 0 ? y : H - 1 - y);
  const pivK = L * 0.55, pivY = Math.round(7 * S);
  for (const y of order) {
    const hy = (y - pivY) * spread;
    const bx = cx + hy * Pu[0], by = cy + hy * Pu[1];
    for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) {
      const v = vox[(y * L + k) * W + i];
      if (!v) continue;
      const c = palette[v];
      for (let s = 0; s < 4; s++) {
        const a = i - (W - 1) / 2 + ((s & 1) ? 0.25 : -0.25), b = pivK - k + ((s & 2) ? 0.25 : -0.25);
        const px = Math.round(bx + a * Pr[0] + b * Pf[0]), py = Math.round(by + a * Pr[1] + b * Pf[1]);
        if (px < 0 || py < 0 || px >= bw || py >= bh) continue;
        const d = (py * bw + px) * 4;
        buf[d] = c[0]; buf[d + 1] = c[1]; buf[d + 2] = c[2]; buf[d + 3] = 255;
      }
    }
  }
}
{
  const cell = 96, cols = 6;
  const shots = [];
  for (let a = 0; a < 12; a++) shots.push([a * Math.PI / 6, 0, 0, 1]);
  for (const rr of [-0.9, -0.5, 0.5, 0.9, 1.5, 3.14]) shots.push([0.6, rr, 0, 1]);
  for (const rr of [-0.6, 0.6]) shots.push([Math.PI / 2, rr, 0, 1]);
  shots.push([0.6, 0, 0.35, 1], [0.6, 0, -0.35, 1], [0.6, 0, 0, 2.5], [2.2, 0, 0, 4]);
  const rows = Math.ceil(shots.length / cols);
  const bw = cell * cols, bh = cell * rows;
  const img = new Uint8Array(bw * bh * 4);
  for (let p = 0; p < bw * bh; p++) { img[p * 4] = 58; img[p * 4 + 1] = 130; img[p * 4 + 2] = 176; img[p * 4 + 3] = 255; }
  shots.forEach(([yaw, roll, pitch, spread], n) => {
    renderStack(img, bw, bh, (n % cols) * cell + cell / 2, Math.floor(n / cols) * cell + cell / 2 + (spread > 1 ? 14 : 4), yaw, roll, pitch, spread);
  });
  writePNG(path.join(outDir, 'stack.png'), bw * 3, bh * 3, upscale(bw, bh, img, 3));
}
console.log('done');
