// Builds the pilot (sitting, and hanging under his parachute) and his ejection seat
// (src/lib/pilot-model.ts) as three small voxel models.
// Not part of the running scene — run it by hand when the pilot changes:
//
//   node tools/gen-pilot-model.mjs /tmp/pilot-out
//   cp /tmp/pilot-out/pilot-model.ts src/lib/pilot-model.ts
//
// It also writes views.png (front / back / side / top, as in the four-view pilot artwork) for a
// quick look. The pilot is sculpted here from simple solids, read off that artwork: a seated
// figure in a dark flying suit, a grey helmet with the jet's orange stripe and teal visor, an
// oxygen mask and hose, a harness, orange shoulder patches. Under the parachute the same figure
// hangs from its risers, legs down. The colours are the jet's own palette (src/lib/jet-model.ts),
// so he is recoloured and lit with it.
import fs from 'node:fs';
import path from 'node:path';
import { writePNG, upscale } from './png.mjs';

const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });

// the grid: x across (20), k from his toes back to the seat's headrest (24), z up (32).
// Heights below are measured from the soles of his boots as he sits; hanging, his legs reach
// DROP voxels lower, so the grid starts that far down.
const W = 20, L = 24, H = 32, DROP = 8;
const PIVOT = [0, 17, 10]; // x, k, z: the middle of his body at the cockpit's sill
const at = (i, k, z) => (z * L + k) * W + i;
const inGrid = (i, k, z) => i >= 0 && k >= 0 && z >= 0 && i < W && k < L && z < H;

// ---------- 1. materials
const SUIT = 1, HELMET = 2, EARCUP = 3, RIM = 4, MASK = 5, HOSE = 6, GLOVE = 7, BOOT = 8, STRAP = 9, BUCKLE = 10,
  VISOR = 11, STRIPE = 12, PATCH = 13, SHADOW = 14, FRAME = 15, CUSHION = 16, RAIL = 17, TRIM = 18, NOZZLE = 19;
// family (0 body, 1 accent, 2 canopy), base tone, darkest and lightest tone it may be shaded to
const LOOK = {
  [SUIT]: [0, 3, 1, 4], [HELMET]: [0, 6, 4, 8], [EARCUP]: [0, 5, 3, 7], [RIM]: [0, 1, 0, 2], [MASK]: [0, 3, 2, 5],
  [HOSE]: [0, 2, 1, 3], [GLOVE]: [0, 4, 2, 6], [BOOT]: [0, 2, 0, 4], [STRAP]: [0, 6, 5, 7], [BUCKLE]: [0, 8, 7, 8],
  [VISOR]: [2, 1, 0, 5], [STRIPE]: [1, 3, 1, 4], [PATCH]: [1, 3, 2, 4], [SHADOW]: [0, 0, 0, 0],
  [FRAME]: [0, 5, 3, 7], [CUSHION]: [0, 3, 2, 4], [RAIL]: [0, 6, 4, 7], [TRIM]: [1, 3, 2, 4], [NOZZLE]: [0, 1, 0, 2],
};
const palIndex = (fam, tone) => 1 + fam * 16 + tone;

// ---------- 2. solids
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
const ellipsoid = (c, r) => (x, k, z) => ((x - c[0]) / r[0]) ** 2 + ((k - c[1]) / r[1]) ** 2 + ((z - c[2]) / r[2]) ** 2 <= 1;
function capsule(a, b, ra, rb = ra) { // a rod with rounded ends, from a (radius ra) to b (radius rb)
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  return (x, k, z) => {
    const t = Math.min(1, Math.max(0, ((x - a[0]) * d[0] + (k - a[1]) * d[1] + (z - a[2]) * d[2]) / dd));
    const r = lerp(ra, rb, t);
    return (x - a[0] - d[0] * t) ** 2 + (k - a[1] - d[1] * t) ** 2 + (z - a[2] - d[2] * t) ** 2 <= r * r;
  };
}
const box = (x0, x1, k0, k1, z0, z1) => (x, k, z) => x >= x0 && x <= x1 && k >= k0 && k <= k1 && z >= z0 && z <= z1;
/** fills every voxel the solid covers; both sides at once (the solid is given for his right, x > 0) */
function fill(grid, solid, m, only) {
  for (let z = 0; z < H; z++) for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) {
    const x = Math.abs(i - (W - 1) / 2);
    if (!solid(x, k + 0.5, z + 0.5 - DROP)) continue;
    const o = at(i, k, z);
    if (only && !only(grid[o], x, k + 0.5, z + 0.5 - DROP)) continue;
    grid[o] = m;
  }
}

// ---------- 3. the pilot
// helmet: where it sits and how big it is
const HK = 16.2, HZ = 19.4, HRX = 4.7, HRK = 5.0, HRZ = 4.6;
// torso: it leans back a little; its middle, half width and half depth at each height
const torsoK = (z) => 15.2 + (z - 4.5) * 0.19;
const TORSO_A = [[4, 5.0], [7, 4.5], [9.5, 4.2], [13, 4.7], [15.6, 4.5]];
const TORSO_B = [[4, 3.2], [9, 2.7], [13, 2.9], [15.6, 2.6]];
const torso = (x, k, z) => {
  if (z < 4 || z > 15.6) return false;
  const round = z > 14 ? Math.sqrt(Math.max(0, 1 - ((z - 14) / 1.75) ** 2)) : 1; // the slope of the shoulders
  const a = pw(TORSO_A, z) * round, b = pw(TORSO_B, z);
  return Math.abs(x / a) ** 2.6 + Math.abs((k - torsoK(z)) / b) ** 2.6 <= 1;
};
/** a boot: its sole from z0 up, toes at k0, heel at k1 */
const boot = (k0, k1, z0) => (x, k, z) => {
  if (x < 1 || x > 5 || k < k0 || k > k1 || z < z0 || z > z0 + 4.0) return false;
  const top = k < k0 + 3 ? z0 + 2.2 + 0.6 * Math.sqrt(Math.max(0, k - k0) / 3) : z0 + 4.0; // the toe cap is lower
  const edge = Math.min(x - 1, 5 - x, k - k0, k1 - k);
  return z <= top - (edge < 0.7 && z > top - 1 ? 0.7 - edge : 0);
};
function sculpt(hanging) {
  const pilot = new Uint8Array(W * L * H);
  fill(pilot, ellipsoid([0, 15.4, 5.3], [5.3, 3.7, 2.9]), SUIT); // hips
  fill(pilot, torso, SUIT);
  fill(pilot, capsule([0, 17.2, 14.6], [0, 17.2, 16.2], 2.5), RIM); // collar
  if (hanging) {
    // legs hanging, a little bent at the knee
    fill(pilot, capsule([2.75, 15.0, 5.2], [3.0, 11.6, 0.8], 2.15, 2.0), SUIT);
    fill(pilot, capsule([3.0, 11.6, 0.8], [3.0, 13.8, -4.0], 1.95, 1.75), SUIT);
    fill(pilot, boot(9.6, 16, -8), BOOT);
    // arms up, a riser in each fist
    fill(pilot, ellipsoid([5.5, 17.0, 13.5], [2.1, 2.3, 2.1]), SUIT);
    fill(pilot, capsule([6.0, 16.8, 13.6], [7.9, 15.6, 16.8], 1.7, 1.5), SUIT);
    fill(pilot, capsule([7.9, 15.6, 16.8], [8.0, 15.4, 20.4], 1.45, 1.35), SUIT);
    fill(pilot, ellipsoid([8.0, 15.4, 21.8], [1.6, 1.7, 1.8]), GLOVE);
  } else {
    // legs: thighs up to the knees, shins down to the boots; between the thighs it is dark, not open
    fill(pilot, box(0, 1.6, 8.5, 14.5, 3.4, 5.6), SHADOW);
    fill(pilot, capsule([2.85, 14.8, 5.5], [2.85, 6.0, 7.0], 2.15, 2.05), SUIT);
    fill(pilot, capsule([2.85, 5.8, 7.0], [2.85, 4.7, 3.0], 2.0, 1.8), SUIT);
    fill(pilot, boot(0.2, 6.7, 0), BOOT);
    // arms: shoulders, down to the elbows, forward to the fists resting on the knees
    fill(pilot, ellipsoid([5.5, 17.0, 13.5], [2.1, 2.3, 2.1]), SUIT);
    fill(pilot, capsule([5.8, 16.6, 13.2], [6.0, 12.4, 10.3], 1.75, 1.65), SUIT);
    fill(pilot, capsule([6.0, 12.4, 10.3], [4.6, 8.8, 10.6], 1.6, 1.45), SUIT);
    fill(pilot, ellipsoid([4.3, 7.2, 10.8], [1.7, 1.7, 1.8]), GLOVE);
  }
  // helmet, with its ear cups, the mask over the mouth and the hose down to the chest
  fill(pilot, ellipsoid([0, HK, HZ], [HRX, HRK, HRZ]), HELMET);
  fill(pilot, (x, k, z) => x >= 4 && x <= 5 && (k - (HK + 0.4)) ** 2 + (z - (HZ - 0.9)) ** 2 <= 2.2 * 2.2, EARCUP);
  fill(pilot, ellipsoid([0, HK - 4.5, HZ - 2.7], [1.9, 1.5, 1.7]), MASK);
  fill(pilot, capsule([0, 12.2, 16.2], [0, 12.6, 12.2], 1.05), HOSE, (m) => m === 0);

  // painted on: the visor, the stripe, the dark roll at the back of the helmet
  for (let z = 0; z < H; z++) for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) {
    const o = at(i, k, z);
    const x = i - (W - 1) / 2, kk = k + 0.5, zz = z + 0.5 - DROP;
    const dk = (kk - HK) / HRK, dz = (zz - HZ) / HRZ;
    if (pilot[o] === HELMET) {
      if (dz < -0.62 && dk > -0.2) pilot[o] = RIM;
      else if (dk < -0.24 && dz > -0.4 && dz < 0.4) pilot[o] = VISOR;
      else if (Math.abs(x) < 1 && dz > -0.62) pilot[o] = STRIPE;
    } else if (pilot[o] === SUIT) {
      const ax = Math.abs(x);
      const onTorso = torso(ax, kk, zz);
      const back = kk > torsoK(zz);
      if (onTorso) {
        // harness: over the shoulders, down to the buckle (a V in front, an X behind), and a belt
        const above = 0.55 + (zz - 9.5) * 0.5;
        const below = 0.55 + (9.5 - zz) * 0.85;
        if (ax < 1 && zz > 9 && zz < 11) pilot[o] = BUCKLE;
        else if (zz >= 10.5 && zz < 14.8 && Math.abs(ax - above) <= 0.55) pilot[o] = STRAP;
        else if (zz >= 14.5 && ax > 2.6 && ax < 3.8) pilot[o] = STRAP;
        else if (back && zz < 9.5 && zz > 6 && Math.abs(ax - below) <= 0.55) pilot[o] = STRAP;
        else if (back && zz > 6.6 && zz < 7.6) pilot[o] = STRAP;
      } else if (ax > 5.7 && zz > 12.7 && zz < 15.4 && kk > 15.4 && kk < 18.6 && (zz - 13.5) ** 2 + (kk - 17) ** 2 < 5) pilot[o] = PATCH; // shoulder patches
    }
  }
  return pilot;
}
const seated = sculpt(false);
const hanging = sculpt(true);

// ---------- 4. the seat
const seat = new Uint8Array(W * L * H);
const backK = (z) => 18.7 + z * 0.1; // the front of its back, leaning like he does
fill(seat, (x, k, z) => x <= 5 && z >= 0.8 && z <= 16.6 && k >= backK(z) && k <= backK(z) + 2.2, FRAME);
fill(seat, (x, k, z) => x <= 4 && z >= 3 && z <= 15.6 && k >= backK(z) && k <= backK(z) + 0.9, CUSHION);
fill(seat, box(0, 5, 7.6, 20.4, 0.8, 2.7), FRAME); // the pan he sits on
fill(seat, box(0, 4.2, 8.4, 18.4, 1.8, 2.7), CUSHION);
fill(seat, box(0, 3.2, 21.4, 23.8, 16.2, 22.6), FRAME); // headrest
fill(seat, box(0, 3.2, 21.4, 22, 16.8, 21.8), CUSHION);
fill(seat, box(0, 3.2, 21.4, 23.8, 21.6, 22.6), TRIM);
fill(seat, (x, k, z) => x > 2.2 && x < 3.8 && z > 1.8 && z <= 16.6 && k > backK(z) + 1.4 && k <= backK(z) + 2.2, RAIL); // rails down its back
fill(seat, (x, k, z) => x < 2.2 && z > 2.8 && z < 15.8 && k > backK(z) + 1.4 && k <= backK(z) + 2.2 && Math.floor(z) % 4 !== 2, NOZZLE); // the dark channel between them, braced
fill(seat, box(0, 1.8, 16.4, 20.6, 0, 0.8), NOZZLE); // the rocket under it

// ---------- 5. shade → palette
/** which way a voxel's surface faces: away from the solid around it */
function normalOf(grid, i, k, z) {
  let nx = 0, nk = 0, nz = 0;
  for (let dz = -2; dz <= 2; dz++) for (let dk = -2; dk <= 2; dk++) for (let di = -2; di <= 2; di++) {
    if (!di && !dk && !dz) continue;
    const full = inGrid(i + di, k + dk, z + dz) && grid[at(i + di, k + dk, z + dz)] !== 0;
    if (full) continue;
    const w = 1 / (di * di + dk * dk + dz * dz);
    nx += di * w; nk += dk * w; nz += dz * w;
  }
  const l = Math.hypot(nx, nk, nz) || 1;
  return [nx / l, nk / l, nz / l];
}
function paint(grid, isPilot) {
  const out = new Uint8Array(W * L * H);
  for (let z = 0; z < H; z++) for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) {
    const o = at(i, k, z);
    const m = grid[o];
    if (!m) continue;
    const [fam, base, lo, hi] = LOOK[m];
    const x = i - (W - 1) / 2, kk = k + 0.5, zz = z + 0.5 - DROP;
    const [nx, nk, nz] = normalOf(grid, i, k, z);
    // light from above, a little from his left, the same from in front and from behind
    const lit = (nx * -0.3 + nz * 0.95) / Math.hypot(0.3, 0.95);
    let tone = base + (lit > 0.82 ? 2 : lit > 0.4 ? 1 : lit > -0.25 ? 0 : lit > -0.7 ? -1 : -2);
    if (m === HELMET) {
      // a polished shell: a hot spot high on its left, seen from in front and from behind
      const spot = Math.max(nx * -0.42 + nk * -0.4 + nz * 0.81, nx * -0.42 + nk * 0.4 + nz * 0.81);
      if (spot > 0.985) tone = 8;
      else if (spot > 0.93) tone = Math.max(tone, 7);
    } else if (m === VISOR) {
      const dz = (zz - HZ) / HRZ;
      tone = dz < -0.2 ? 3 : dz < 0.1 ? 2 : 1;
      if (Math.abs(x) > 3.6) tone -= 1;
      if (Math.abs(x + 1.5) < 0.6 && Math.abs(zz - 20.5) < 0.6) tone = 5; // its glint
      else if (Math.abs(x + 1.5) < 1.6 && Math.abs(zz - 20.5) < 0.6) tone = 4;
    } else if (m === HOSE) {
      tone = (z + DROP) % 2 ? 3 : 1; // ribbed
    } else if (m === EARCUP) {
      const d = Math.hypot(kk - (HK + 0.4), zz - (HZ - 0.9));
      tone = d < 0.9 ? 3 : d < 1.6 ? 6 : 4;
    } else if (m === BOOT) {
      if (z + 1 < H && grid[at(i, k, z + 1)] === BOOT && (z === 0 || !grid[at(i, k, z - 1)])) tone = 0; // the sole
    } else if (m === STRAP || m === BUCKLE) {
      tone = base + (lit > 0.6 ? 1 : lit < -0.4 ? -1 : 0);
    } else if (m === STRIPE) {
      tone = base + (lit > 0.85 ? 1 : lit < -0.1 ? -1 : 0) - (nk > 0.75 || nk < -0.75 ? 1 : 0);
    }
    if (isPilot && (m === SUIT || m === GLOVE)) {
      // tucked in under the helmet, the arms and the knees it is darker
      let roof = 0;
      for (let dz = 1; dz <= 3; dz++) if (inGrid(i, k, z + dz) && grid[at(i, k, z + dz)]) roof++;
      if (roof === 0) for (let dz = 2; dz <= 4; dz++) if (inGrid(i, k, z + dz) && grid[at(i, k, z + dz)]) { tone -= 1; break; }
    }
    out[o] = palIndex(fam, Math.max(lo, Math.min(hi, tone)));
  }
  return out;
}
const seatedVox = paint(seated, true);
const hangingVox = paint(hanging, true);
const seatVox = paint(seat, false);
const count = (g) => g.reduce((n, v) => n + (v ? 1 : 0), 0);
console.log('voxels: seated', count(seatedVox), 'hanging', count(hangingVox), 'seat', count(seatVox), 'dims', W, L, H);

// ---------- 6. write the model (the three grids, run-length encoded → base64)
const rle = [];
{
  const all = new Uint8Array(W * L * H * 3);
  all.set(seatedVox, 0);
  all.set(hangingVox, W * L * H);
  all.set(seatVox, W * L * H * 2);
  let run = 0, cur = all[0];
  const flush = () => { while (run > 0) { const n = Math.min(255, run); rle.push(n, cur); run -= n; } };
  for (let o = 0; o < all.length; o++) {
    if (all[o] === cur) run++;
    else { flush(); cur = all[o]; run = 1; }
  }
  flush();
}
const b64 = Buffer.from(rle).toString('base64');
console.log('rle bytes', rle.length, 'b64 chars', b64.length);
const chunks = b64.match(/.{1,120}/g).map((s) => `  '${s}',`).join('\n');
fs.writeFileSync(path.join(outDir, 'pilot-model.ts'), `// The pilot (sitting, and hanging under his parachute) and his ejection seat: three voxel models
// on one ${W}×${L}×${H} grid (across, toes → headrest, up), sculpted by tools/gen-pilot-model.mjs after the
// four-view pilot artwork. Each voxel is an index into the jet's palette (see jet-model.ts), so he
// takes the jet's colours; 0 is empty. Data is run-length encoded (count, index) → base64: the
// sitting pilot's grid, the hanging pilot's, then the seat's.

export const PILOT_W = ${W}
export const PILOT_L = ${L}
export const PILOT_H = ${H}

/** where things are on the grid, in voxels: across from the middle, back from the front, up from the bottom */
export const PILOT_PIVOT = [${PIVOT[0]}, ${PIVOT[1]}, ${PIVOT[2] + DROP}] // the middle of his body at the cockpit's sill
export const PILOT_SILL = ${11 + DROP} // sitting in the jet, he shows from here up
export const PILOT_RISER = [8, 15.4, ${23.4 + DROP}] // hanging: the top of his fists, where the parachute's risers are held (either side)
export const PILOT_SEAT_BASE = [0, 18.5, ${DROP}] // under the seat: where its rocket burns

const DATA = [
${chunks}
].join('')

/** Decodes to the three models, each a Uint8Array(PILOT_W * PILOT_L * PILOT_H): index (z * PILOT_L + k) * PILOT_W + x. */
export function decodePilot(): { seated: Uint8Array; hanging: Uint8Array; seat: Uint8Array } {
  const bin = atob(DATA)
  const size = PILOT_W * PILOT_L * PILOT_H
  const flat = new Uint8Array(size * 3)
  let o = 0
  for (let i = 0; i < bin.length; i += 2) {
    const n = bin.charCodeAt(i)
    const v = bin.charCodeAt(i + 1)
    flat.fill(v, o, o + n)
    o += n
  }
  return { seated: flat.subarray(0, size), hanging: flat.subarray(size, size * 2), seat: flat.subarray(size * 2) }
}
`);

// ---------- 7. preview: the four views of the artwork (top, side, front, back): sitting, in his seat, hanging
const RAMP = {
  0: [[14, 15, 22], [29, 31, 42], [44, 47, 60], [61, 65, 80], [84, 89, 105], [112, 118, 134], [150, 156, 170], [196, 201, 211], [236, 239, 244]],
  1: [[92, 24, 8], [150, 40, 6], [205, 62, 6], [240, 88, 14], [255, 128, 40], [255, 176, 96]],
  2: [[4, 38, 52], [6, 70, 90], [14, 106, 128], [30, 140, 160], [84, 178, 190], [214, 240, 240]],
};
const rgbOf = (v) => RAMP[(v - 1) >> 4][(v - 1) & 15];
{
  const cell = 40, cols = 4, rows = 3;
  const bw = cell * cols, bh = cell * rows;
  const img = new Uint8Array(bw * bh * 4);
  for (let p = 0; p < bw * bh; p++) { img[p * 4] = 106; img[p * 4 + 1] = 127; img[p * 4 + 2] = 150; img[p * 4 + 3] = 255; }
  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= bw || y >= bh) return;
    const c = rgbOf(v), d = (y * bw + x) * 4;
    img[d] = c[0]; img[d + 1] = c[1]; img[d + 2] = c[2];
  };
  const both = (row) => (i, k, z) => (row === 2 ? hangingVox : seatedVox)[at(i, k, z)] || (row === 1 ? seatVox[at(i, k, z)] : 0);
  for (let row = 0; row < rows; row++) {
    const get = both(row);
    const oy = row * cell + 3;
    // top: looking down, toes up the picture
    for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) for (let z = H - 1; z >= 0; z--) { const v = get(i, k, z); if (v) { put(10 + i, oy + k, v); break; } }
    // side: facing left
    for (let z = 0; z < H; z++) for (let k = 0; k < L; k++) for (let i = 0; i < W; i++) { const v = get(i, k, z); if (v) { put(cell + 3 + k, oy + H - 1 - z, v); break; } }
    // front
    for (let z = 0; z < H; z++) for (let i = 0; i < W; i++) for (let k = 0; k < L; k++) { const v = get(i, k, z); if (v) { put(cell * 2 + 10 + (W - 1 - i), oy + H - 1 - z, v); break; } }
    // back
    for (let z = 0; z < H; z++) for (let i = 0; i < W; i++) for (let k = L - 1; k >= 0; k--) { const v = get(i, k, z); if (v) { put(cell * 3 + 10 + i, oy + H - 1 - z, v); break; } }
  }
  writePNG(path.join(outDir, 'views.png'), bw * 8, bh * 8, upscale(bw, bh, img, 8));
}
console.log('done');
