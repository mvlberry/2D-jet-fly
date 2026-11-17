// Sprite-stack fighter scene — a small software renderer.
//
// Everything is drawn into one low-resolution pixel buffer, the way the technique works:
//   · the jet is a stack of horizontal slices drawn 1 px apart, turned to any angle
//   · the islands and the clouds are stacks too (a height per ground pixel)
// The buffer is then shown scaled up with hard pixels.
//
// Two views share one camera: the overhead sprite-stack view, and a chase view from behind
// the jet. The camera slides between them, so the switch is a single continuous move.

import {
  JET_W, JET_L, JET_H, JET_PALETTE, decodeJet,
  JET_PIVOT_K, JET_PIVOT_Y, JET_ENGINE_A, JET_ENGINE_Y, JET_ENGINE_R, JET_NOZZLE_K,
  JET_WINGTIP_A, JET_WINGTIP_K, JET_WINGTIP_Y,
} from './jet-model'
import { buildCockpit, drawCockpit } from './cockpit'
import type { CockpitArt } from './cockpit'

export type TimeOfDay = 'day' | 'sunset' | 'night'
export type ViewMode = 'top' | 'chase' | 'cockpit'
export type FlameStyle = 'pixel' | 'realistic'

export interface SceneParams {
  speed: number // px per second
  boost: number // how many times faster it flies while the thrusters are held open
  agility: number // max turn rate, rad per second
  altitude: number // cruising height, px above the sea
  ceiling: number // the highest it can climb, px above the sea
  clearance: number // the closest it gets to the ground, trees and water, px
  bank: number // max bank angle, degrees
  spread: number // px between slices (1 = stacked)
  jetScale: number // size of the jet against the world (1 = one art pixel per world pixel)
  cameraFollow: number // 0 = north-up camera, 1 = camera turns with the jet
  view: ViewMode // overhead, from behind the jet, or from the pilot's seat
  chaseDistance: number // how far behind the jet the chase camera sits, in jet lengths
  chaseAngle: number // how high above the jet it sits, degrees
  chaseSize: number // how wide the jet is drawn in the chase view, as a share of the frame
  transition: number // seconds the camera takes to move between the views
  timeOfDay: TimeOfDay
  clouds: number // 0..1 cover
  land: number // 0..1 share of land
  seed: number
  afterburner: number // 0..1
  flameStyle: FlameStyle // flames drawn in pixels like the jet, or as smooth fire laid over the picture
  trails: boolean
  wingmen: number // 0..2
  shadow: boolean
  followPointer: boolean
  invertY: boolean // up and down work like a flight stick: pull down to climb, push up to dive
  stunts: boolean
  intro: boolean
  bodyColor: string
  accentColor: string
  canopyColor: string
}

export const DEFAULT_PARAMS: SceneParams = {
  speed: 92,
  boost: 1.8,
  agility: 1.25,
  altitude: 64,
  ceiling: 300,
  clearance: 7,
  bank: 52,
  spread: 1,
  jetScale: 1,
  cameraFollow: 0.6,
  view: 'top',
  chaseDistance: 2.6,
  chaseAngle: 12,
  chaseSize: 0.19,
  transition: 1.4,
  timeOfDay: 'day',
  clouds: 0.45,
  land: 0.33,
  seed: 7,
  afterburner: 0.8,
  flameStyle: 'pixel',
  trails: true,
  wingmen: 0,
  shadow: true,
  followPointer: true,
  invertY: true,
  stunts: true,
  intro: true,
  bodyColor: '#545969',
  accentColor: '#f0580e',
  canopyColor: '#1e8ca0',
}

// ───────────────────────────────────────────────────────────── constants
const N = 2048 // world size (wraps)
const NM = N - 1
const NSHIFT = 11
const HMAX = 40 // tallest terrain stack, trees included

const NC = 1024 // cloud map size (wraps)
const NCM = NC - 1
const NCSHIFT = 10
const CK = 8 // cloud stack height
const CLOUD_ALT = 40

const PIV_K = JET_PIVOT_K // pivot along the fuselage
const PIV_Y = JET_PIVOT_Y // pivot slice (wing level)
const ENGINE_A = JET_ENGINE_A // engines, px off the centre line
const ENGINE_Y = JET_ENGINE_Y // engine centre height
const ENGINE_R = JET_ENGINE_R
const NOZZLE_K = JET_NOZZLE_K
const WINGTIP_A = JET_WINGTIP_A
const WINGTIP_K = JET_WINGTIP_K
const WINGTIP_Y = JET_WINGTIP_Y

const TRAIL_N = 160
const SMOKE_N = 96 // puffs of exhaust smoke kept alive at once
const SMOKE_F = 9 // numbers kept per puff

const ZTOP = CLOUD_ALT + CK // the tallest thing in the world
const VIEW_DIST = 1500 // how far the chase view sees
const FOG_START = 300
const FOG_STEPS = 10 // shades of haze between here and the horizon
const NSKY = 8 // bands in the sky gradient
const EPS = 1e-5
const HOLD = 0.2 // seconds: shorter is a click (roll), longer is a hold (thrusters)
const COCKPIT_LOOK = 64 // the cockpit view is centred this far ahead of the jet, px
const COCKPIT_EYE = 3 // the pilot's eyes, px above the jet's middle
const FLAME_MAX = 6 // smooth flames: two a jet
const FLAME_F = 16 // numbers kept per smooth flame
const FLAME_GROW = 1.3 // a smooth flame fades out along its length, so it is drawn this much longer

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

// ───────────────────────────────────────────────────────────── helpers
const pack = (r: number, g: number, b: number) =>
  ((255 << 24) | (clamp255(b) << 16) | (clamp255(g) << 8) | clamp255(r)) >>> 0
// the light that falls into the cockpit
const SUN_DAY = pack(255, 246, 222)
const SUN_SUNSET = pack(255, 170, 92)
const SUN_NIGHT = pack(150, 190, 255)
function clamp255(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const lum = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

function mulberry32(seed: number) {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hash8(o: number) {
  let h = Math.imul(o ^ (o >>> 13), 0x5bd1e995)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  return (h >>> 24) & 255
}
function wrapAngle(a: number) {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2))
}

export function parseColor(str: string | undefined, fallback: number[]): number[] {
  if (!str) return fallback
  let s = String(str).trim()
  if (s[0] === '#') {
    s = s.slice(1)
    if (s.length === 3 || s.length === 4) s = s.split('').map((ch) => ch + ch).join('')
    if (s.length >= 6) {
      const n = parseInt(s.slice(0, 6), 16)
      if (!isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    return fallback
  }
  const m = s.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const parts = m[1].split(/[ ,/]+/).map(parseFloat)
    if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) return [parts[0], parts[1], parts[2]]
  }
  return fallback
}

/** colour grading per time of day (amount 0..1) */
function grade(c: number[], tod: TimeOfDay, amount: number): number[] {
  if (tod === 'day' || amount <= 0) return c
  let r: number, g: number, b: number
  if (tod === 'sunset') {
    r = 0.95 * c[0] + 0.1 * c[1] + 12
    g = 0.72 * c[1] + 0.05 * c[0] + 4
    b = 0.7 * c[2] + 0.08 * c[0] + 10
  } else {
    r = 0.22 * c[0] + 2
    g = 0.3 * c[1] + 6
    b = 0.5 * c[2] + 22
  }
  return [c[0] + (r - c[0]) * amount, c[1] + (g - c[1]) * amount, c[2] + (b - c[2]) * amount]
}

// tileable value noise, one octave added into `field`
function addOctave(field: Float32Array, n: number, cell: number, amp: number, rnd: () => number) {
  const P = n / cell
  const lat = new Float32Array(P * P)
  for (let i = 0; i < lat.length; i++) lat[i] = rnd()
  const x0 = new Int32Array(n)
  const x1 = new Int32Array(n)
  const tx = new Float32Array(n)
  for (let x = 0; x < n; x++) {
    const g = x / cell
    const i = Math.floor(g)
    const f = g - i
    x0[x] = i % P
    x1[x] = (i + 1) % P
    tx[x] = f * f * (3 - 2 * f)
  }
  for (let y = 0; y < n; y++) {
    const ra = x0[y] * P
    const rb = x1[y] * P
    const ty = tx[y]
    const row = y * n
    for (let x = 0; x < n; x++) {
      const a0 = lat[ra + x0[x]]
      const b0 = lat[rb + x0[x]]
      const va = a0 + (lat[ra + x1[x]] - a0) * tx[x]
      const vb = b0 + (lat[rb + x1[x]] - b0) * tx[x]
      field[row + x] += amp * (va + (vb - va) * ty)
    }
  }
}
function normalise(field: Float32Array) {
  let mn = Infinity
  let mx = -Infinity
  for (let i = 0; i < field.length; i++) {
    const v = field[i]
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  const k = 1 / (mx - mn || 1)
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - mn) * k
}

// ───────────────────────────────────────────────────────────── materials
// index: 0 deep · 1 mid · 2 shallow · 3 surf · 4 sand · 5 sand speck · 6 grass · 7 grass dark · 8 grass light
//        9 tree top · 10 tree · 11 tree edge · 12 rock · 13 rock dark · 14 rock light · 15 snow · 16 snow shade
const MAT_TOP = [
  [36, 104, 180], [44, 124, 198], [66, 160, 216], [104, 204, 214],
  [238, 220, 164], [222, 200, 140],
  [96, 178, 52], [70, 148, 44], [134, 206, 76],
  [70, 158, 64], [42, 122, 54], [28, 92, 46],
  [146, 140, 134], [118, 112, 110], [178, 172, 162],
  [246, 250, 255], [214, 226, 244],
]
const MAT_SIDE = [
  [36, 104, 180], [44, 124, 198], [66, 160, 216], [104, 204, 214],
  [204, 180, 122], [204, 180, 122],
  [56, 120, 44], [50, 108, 42], [60, 128, 46],
  [24, 78, 42], [22, 72, 40], [20, 64, 38],
  [96, 90, 92], [86, 82, 86], [104, 98, 98],
  [186, 202, 228], [176, 192, 220],
]
const NMAT = MAT_TOP.length

interface Jet {
  x: number
  y: number
  z: number
  yaw: number
  yawRate: number
  roll: number
  pitch: number
  stunt: number // 0..1 progress of an aileron roll, -1 idle
  stuntDir: number
  stuntDelay: number
  vx: number
  vy: number
  trail: Float32Array[] // [left, right] ring buffers of x,y,z,t
  trailHead: number
  trailLen: number
  g: number // how hard it is turning, 0..1 (smoothed)
  lastTrailX: number
  lastTrailY: number
}

function makeJet(x: number, y: number, z: number, yaw: number): Jet {
  return {
    x, y, z, yaw, yawRate: 0, roll: 0, pitch: 0, stunt: -1, stuntDir: 1, stuntDelay: 0, vx: 0, vy: 0,
    trail: [new Float32Array(TRAIL_N * 4), new Float32Array(TRAIL_N * 4)],
    trailHead: 0, trailLen: 0, g: 0, lastTrailX: x, lastTrailY: y,
  }
}

export function createScene(initial: SceneParams) {
  let p: SceneParams = { ...initial }

  // ── the jet's slices as lists of voxels
  const slices = decodeJet()
  const sliceA: Float32Array[] = []
  const sliceB: Float32Array[] = []
  const sliceC: Uint8Array[] = []
  const shadowMask = new Uint8Array(JET_W * JET_L)
  let firstSlice = JET_H
  for (let y = 0; y < JET_H; y++) {
    const s = slices[y]
    let n = 0
    for (let o = 0; o < s.length; o++) if (s[o]) n++
    const a = new Float32Array(n)
    const b = new Float32Array(n)
    const c = new Uint8Array(n)
    let j = 0
    for (let k = 0; k < JET_L; k++) {
      for (let i = 0; i < JET_W; i++) {
        const v = s[k * JET_W + i]
        if (!v) continue
        a[j] = i - (JET_W - 1) / 2
        b[j] = PIV_K - k
        c[j] = v
        j++
        shadowMask[k * JET_W + i] = 1
      }
    }
    if (n && y < firstSlice) firstSlice = y
    sliceA.push(a)
    sliceB.push(b)
    sliceC.push(c)
  }

  // the jet from above, for the cockpit's status screen: 0 empty, 1 body, 2 paint, 3 glass
  const jetTop = { w: JET_W, h: JET_L, cells: new Uint8Array(JET_W * JET_L) }
  for (let y = JET_H - 1; y >= 0; y--) {
    for (let o = 0; o < JET_W * JET_L; o++) {
      const v = slices[y][o]
      if (v && jetTop.cells[o] === 0) jetTop.cells[o] = 1 + Math.min(2, (v - 1) >> 4)
    }
  }

  // ── palettes (rebuilt when colours or the time of day change)
  const jetPal = new Uint32Array(96)
  const jetPalLit = new Uint32Array(96) // one tone up, for surfaces turned to the sun
  const jetPalDim = new Uint32Array(96) // one tone down, for surfaces turned away
  let outlineCol = 0
  const topLit = new Uint32Array(NMAT)
  const topShade = new Uint32Array(NMAT)
  const sideLit = new Uint32Array(NMAT)
  const sideShade = new Uint32Array(NMAT)
  const cloudTop = new Uint32Array(CK)
  const cloudSide = new Uint32Array(CK)
  const flamePal = new Uint32Array(6)
  const trailPal = new Uint32Array(3)
  const skyPal = new Uint32Array(NSKY)
  let hazeCol = 0
  let cloudUnder = 0
  let sunCol = 0
  let sunGlow = 0
  let sparkA = 0
  let sparkB = 0
  let foamCol = 0
  let sunX = 0.45
  let sunY = 0.3

  function rebuildPalettes() {
    const tod = p.timeOfDay
    // jet: recolour each family from its key tone
    const keys: Record<number, { key: number; col: number[]; def: number[] }> = {
      0: { key: 4, col: parseColor(p.bodyColor, [84, 89, 105]), def: [84, 89, 105] },
      1: { key: 3, col: parseColor(p.accentColor, [240, 88, 14]), def: [240, 88, 14] },
      2: { key: 3, col: parseColor(p.canopyColor, [30, 140, 160]), def: [30, 140, 160] },
    }
    const keyLum: Record<number, number> = {}
    for (const row of JET_PALETTE) {
      const fam = row[4]
      if (fam < 3 && ((row[0] - 1) & 15) === keys[fam].key) keyLum[fam] = lum([row[1], row[2], row[3]])
    }
    const jetAmount = tod === 'sunset' ? 0.5 : tod === 'night' ? 0.16 : 0
    for (const row of JET_PALETTE) {
      const idx = row[0]
      const fam = row[4]
      let c = [row[1], row[2], row[3]]
      if (fam < 3) {
        const k = keys[fam]
        const same = k.col[0] === k.def[0] && k.col[1] === k.def[1] && k.col[2] === k.def[2]
        if (!same) {
          const l = lum(c)
          const kl = keyLum[fam] || 100
          if (l <= kl) {
            const f = l / kl
            c = [k.col[0] * f, k.col[1] * f, k.col[2] * f]
          } else {
            const f = (l - kl) / (255 - kl)
            c = [k.col[0] + (255 - k.col[0]) * f, k.col[1] + (255 - k.col[1]) * f, k.col[2] + (255 - k.col[2]) * f]
          }
        }
        c = grade(c, tod, jetAmount)
      }
      jetPal[idx] = pack(c[0], c[1], c[2])
    }
    for (const row of JET_PALETTE) {
      const idx = row[0]
      const fam = row[4]
      jetPalLit[idx] = fam < 3 && jetPal[idx + 1] ? jetPal[idx + 1] : jetPal[idx]
      jetPalDim[idx] = fam < 3 && ((idx - 1) & 15) > 0 ? jetPal[idx - 1] : jetPal[idx]
    }
    cockpit = null // repainted in the new colours shortly
    cockpitDue = 0.3
    const oc = tod === 'night' ? [44, 64, 118] : grade([13, 15, 26], tod, 0.3)
    outlineCol = pack(oc[0], oc[1], oc[2])
    // world
    for (let m = 0; m < NMAT; m++) {
      const t = grade(MAT_TOP[m], tod, 1)
      const s = grade(MAT_SIDE[m], tod, 1)
      topLit[m] = pack(t[0], t[1], t[2])
      sideLit[m] = pack(s[0], s[1], s[2])
      topShade[m] = pack(t[0] * 0.62, t[1] * 0.67, t[2] * 0.8)
      sideShade[m] = pack(s[0] * 0.62, s[1] * 0.67, s[2] * 0.8)
    }
    for (let k = 0; k < CK; k++) {
      const f = k / (CK - 1)
      const ft = Math.min(1, k / 2)
      const ca = tod === 'night' ? 0.72 : 1
      const t = grade([218 + 37 * ft, 230 + 25 * ft, 247 + 8 * ft], tod, ca)
      const s = grade([158 + 44 * f, 182 + 36 * f, 222 + 18 * f], tod, ca)
      cloudTop[k] = pack(t[0], t[1], t[2])
      cloudSide[k] = pack(s[0], s[1], s[2])
    }
    const sa = tod === 'sunset' ? [255, 170, 110] : tod === 'night' ? [70, 110, 190] : [120, 190, 236]
    const sb = tod === 'sunset' ? [255, 226, 170] : tod === 'night' ? [170, 200, 240] : [236, 250, 255]
    const fm = tod === 'sunset' ? [255, 226, 214] : tod === 'night' ? [110, 140, 200] : [240, 252, 255]
    sparkA = pack(sa[0], sa[1], sa[2])
    sparkB = pack(sb[0], sb[1], sb[2])
    foamCol = pack(fm[0], fm[1], fm[2])
    const flames = [[255, 252, 224], [255, 224, 120], [255, 164, 44], [246, 96, 20], [176, 48, 26], [96, 34, 40]]
    for (let i = 0; i < 6; i++) flamePal[i] = pack(flames[i][0], flames[i][1], flames[i][2])
    const tr = [grade([255, 255, 255], tod, 0.8), grade([214, 232, 250], tod, 0.8), grade([170, 204, 240], tod, 0.8)]
    for (let i = 0; i < 3; i++) trailPal[i] = pack(tr[i][0], tr[i][1], tr[i][2])
    // sky: from the horizon up
    const skyA = tod === 'sunset' ? [255, 198, 132] : tod === 'night' ? [36, 56, 110] : [198, 232, 250]
    const skyM = tod === 'sunset' ? [238, 122, 130] : tod === 'night' ? [18, 28, 70] : [122, 190, 240]
    const skyB = tod === 'sunset' ? [84, 68, 150] : tod === 'night' ? [7, 10, 34] : [62, 142, 222]
    for (let i = 0; i < NSKY; i++) {
      const f = i / (NSKY - 1)
      const a = f < 0.5 ? skyA : skyM
      const b = f < 0.5 ? skyM : skyB
      const g = f < 0.5 ? f * 2 : f * 2 - 1
      skyPal[i] = pack(a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g, a[2] + (b[2] - a[2]) * g)
    }
    const hz = tod === 'sunset' ? [250, 182, 134] : tod === 'night' ? [28, 44, 92] : [188, 224, 246]
    hazeCol = pack(hz[0], hz[1], hz[2])
    const cu = grade([138, 160, 200], tod, tod === 'night' ? 0.72 : 1)
    cloudUnder = pack(cu[0], cu[1], cu[2])
    const sc2 = tod === 'night' ? [232, 238, 255] : [255, 244, 200]
    const sg = tod === 'night' ? [70, 96, 160] : [255, 222, 150]
    sunCol = pack(sc2[0], sc2[1], sc2[2])
    sunGlow = pack(sg[0], sg[1], sg[2])
    if (tod === 'sunset') { sunX = 0.95; sunY = 0.5 } else if (tod === 'night') { sunX = 0.3; sunY = 0.42 } else { sunX = 0.5; sunY = 0.32 }
  }

  // ── the world: a height and a material per ground pixel
  const heightMap = new Uint8Array(N * N)
  const matMap = new Uint8Array(N * N)
  const cloudN = new Uint8Array(NC * NC)
  const nz = new Uint8Array(256 * 256)
  let spawnX = N / 2
  let spawnY = N / 2

  function buildWorld() {
    const rnd = mulberry32((p.seed | 0) * 7919 + 13)
    for (let i = 0; i < nz.length; i++) nz[i] = (rnd() * 256) | 0

    const E = new Float32Array(N * N)
    addOctave(E, N, 512, 0.55, rnd)
    addOctave(E, N, 256, 1, rnd)
    addOctave(E, N, 128, 0.5, rnd)
    addOctave(E, N, 64, 0.25, rnd)
    addOctave(E, N, 32, 0.11, rnd)
    addOctave(E, N, 16, 0.05, rnd)
    normalise(E)

    // sea level from the wanted share of land
    const bins = new Uint32Array(1024)
    for (let o = 0; o < E.length; o++) bins[(E[o] * 1023) | 0]++
    const land = clamp(p.land, 0.02, 0.9)
    let acc = 0
    let sea = 1
    const target = (1 - land) * E.length
    for (let b = 0; b < 1024; b++) {
      acc += bins[b]
      if (acc >= target) { sea = (b + 1) / 1023; break }
    }
    const SAND = 0.012
    const span = Math.max(0.05, 1 - sea - SAND)

    for (let y = 0; y < N; y++) {
      const row = y << NSHIFT
      const rowNW = ((y - 2) & NM) << NSHIFT
      const rowSE = ((y + 2) & NM) << NSHIFT
      for (let x = 0; x < N; x++) {
        const o = row | x
        const e = E[o]
        const hs = hash8(o)
        const d = e - sea
        if (d < 0) {
          const dd = -d + (hs - 128) * 0.00004
          matMap[o] = dd > 0.07 ? 0 : dd > 0.03 ? 1 : dd > 0.008 ? 2 : 3
          heightMap[o] = 0
          continue
        }
        if (d < SAND) {
          matMap[o] = hs < 34 ? 5 : 4
          heightMap[o] = 0
          continue
        }
        const hr = (d - SAND) / span
        // terraces: 8 grass levels (2 px each), 4 rock levels and the snow cap (3 px each)
        let lv = hr < 0.5 ? 1 + ((hr * 16) | 0) : hr < 0.78 ? 9 + (((hr - 0.5) / 0.07) | 0) : 13 + (((hr - 0.78) / 0.09) | 0)
        if (lv > 15) lv = 15
        heightMap[o] = lv <= 8 ? lv * 2 : 16 + (lv - 8) * 3
        const g = E[rowNW | ((x - 2) & NM)] - E[rowSE | ((x + 2) & NM)]
        const lit = g < -0.007
        const shaded = g > 0.007
        if (lv >= 13) matMap[o] = shaded ? 16 : 15
        else if (lv >= 9) matMap[o] = lit ? 14 : shaded ? 13 : hs < 26 ? 13 : 12
        else matMap[o] = lit ? 8 : shaded ? 7 : hs < 22 ? 7 : hs > 240 ? 8 : 6
      }
    }

    // forests: little cones of leaves
    const STEP = 5
    for (let gy = 0; gy < N; gy += STEP) {
      for (let gx = 0; gx < N; gx += STEP) {
        const hs = hash8(gy * 977 + gx * 131 + 7)
        const cx = (gx + (hs & 3)) & NM
        const cy = (gy + ((hs >> 2) & 3)) & NM
        const o = (cy << NSHIFT) | cx
        const m = matMap[o]
        if (m < 6 || m > 8) continue
        const h0 = heightMap[o]
        if (h0 > 14) continue
        const f = E[(((cy + 613) & NM) << NSHIFT) | ((N - 1 - cx + 911) & NM)]
        const pr = (f - sea) * 30
        if (pr <= 0 || pr * 255 < hash8(o + 99)) continue
        const r = 2 + ((hs >> 4) & 1)
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist > r + 0.3) continue
            const oo = (((cy + dy) & NM) << NSHIFT) | ((cx + dx) & NM)
            if (matMap[oo] < 4) continue
            const nh = h0 + 1 + Math.round((1 - dist / (r + 0.5)) * (r + 1))
            if (nh > heightMap[oo]) {
              heightMap[oo] = nh
              matMap[oo] = dist < 1.1 ? 9 : dist < r - 0.5 ? 10 : 11
            }
          }
        }
      }
    }

    // a start over open water next to land
    let best = -1
    for (let tries = 0; tries < 400; tries++) {
      const x = (rnd() * N) | 0
      const y = (rnd() * N) | 0
      const here = matMap[(y << NSHIFT) | x]
      if (here > 2) continue
      let landNear = 0
      for (let a = 0; a < 8; a++) {
        const xx = (x + Math.cos(a * 0.785) * 120) & NM
        const yy = (y + Math.sin(a * 0.785) * 120) & NM
        if (matMap[(yy << NSHIFT) | xx] >= 4) landNear++
      }
      if (landNear > best && landNear <= 5) { best = landNear; spawnX = x; spawnY = y }
    }

    // clouds: clusters of round puffs. Each cell holds (rank << 4) | thickness; a cloud shows
    // when its rank is under the cover setting, so the slider adds and removes whole clouds.
    cloudN.fill(0)
    for (let i = 0; i < 200; i++) {
      const rank = i & 15
      const cx = rnd() * NC
      const cy = rnd() * NC
      const sc = 0.6 + rnd() * rnd() * 1.25
      const ang = 0.35 + (rnd() - 0.5) * 1.3
      const len = (12 + rnd() * 24) * sc
      const puffs = 4 + ((rnd() * 7) | 0)
      for (let q = 0; q < puffs; q++) {
        const t = (q / (puffs - 1)) * 2 - 1
        const pxc = cx + Math.cos(ang) * t * len + (rnd() - 0.5) * 9 * sc
        const pyc = cy + Math.sin(ang) * t * len + (rnd() - 0.5) * 9 * sc
        const r = (6 + rnd() * 8) * sc * (1 - 0.45 * Math.abs(t))
        const maxT = clamp(Math.round(r * 0.6), 2, CK)
        const ri = Math.ceil(r)
        for (let dy = -ri; dy <= ri; dy++) {
          for (let dx = -ri; dx <= ri; dx++) {
            const d2 = (dx * dx + dy * dy) / (r * r)
            if (d2 > 1) continue
            const tk = Math.max(1, Math.round(Math.sqrt(1 - d2) * maxT))
            const xx = (Math.round(pxc) + dx) & NCM
            const yy = (Math.round(pyc) + dy) & NCM
            const oo = (yy << NCSHIFT) | xx
            if (tk > (cloudN[oo] & 15)) cloudN[oo] = (rank << 4) | tk
          }
        }
      }
    }
  }

  // ── state
  let W = 0
  let H = 0
  let fb = new Uint32Array(0)
  let bytes = new Uint8ClampedArray(0)
  let jetMask = new Uint8Array(0)
  let time = 0
  let introT = 0
  let spreadNow = p.spread
  let holding = false
  let holdT = 0
  let pointerOn = false
  let pointerX = 0
  let pointerY = 0
  let pointerIdle = 99
  let autoStunt = 6
  let burn = 0 // afterburner, eased in after the intro
  let boost = 0 // 0..1: how hard the thrusters are being pushed (hold)
  let boostKey = false
  let padThrust = 0 // 0..1: how far a game controller's trigger is squeezed
  let keyTurn = 0 // flying with the keys: −1 left … +1 right
  let keyClimb = 0 // −1 dive … +1 climb
  let keyMode = false // the keys fly the jet until the pointer moves again
  let altGoal = p.altitude // the height the jet is heading for
  let climbV = 0 // how fast it is climbing, px per second (smoothed)
  let climbTilt = 0 // the jet's climb angle, which the chase camera leans with
  let worldDirty = 0 // seconds until the world is rebuilt (waits for a slider to settle)
  let reseat = false
  const cam = { x: 0, y: 0, yaw: 0, alt: p.altitude } // what the view is centred on (yaw: the overhead heading)
  const follow = { x: 0, y: 0, alt: p.altitude } // the same point as it trails the jet; the cockpit locks on instead
  let jets: Jet[] = []
  let colY = new Int32Array(0) // per screen column: the highest row the ground has reached
  let zbuf = new Float32Array(0) // per pixel: how deep into the view the world is, so it can hide a jet behind it
  // the cockpit view is drawn on a larger square sheet and then turned (the horizon rolls)
  let sheetSide = 0
  let sheet = new Uint32Array(0)
  let sheetMask = new Uint8Array(0)
  let sheetColY = new Int32Array(0)
  let sheetZ = new Float32Array(0)
  let pivotY = 0 // the screen row the cockpit view rolls about
  let cockpit: CockpitArt | null = null
  let cockpitDue = 0.3 // seconds until the cockpit is (re)painted; it is done ahead of time, never mid-move
  let colLo = 0 // the columns and rows being drawn (all of them, except on the sheet)
  let colHi = 0
  let rowLo = 0
  let rowHi = 0
  let frameH = 0 // height of the frame on screen (H is the sheet's while the world is drawn on it)
  let backdrop = new Uint32Array(0) // what was behind a jet, kept while it fades in or out
  let sheetBackdrop = new Uint32Array(0)

  // the view: 0 = overhead, 1 = behind the jet, 2 = in the cockpit, and anywhere between while it moves
  const viewIndex = (v: ViewMode) => (v === 'cockpit' ? 2 : v === 'chase' ? 1 : 0)
  let viewTarget = viewIndex(p.view)
  // How much of each view the camera is in. Each weight glides to its goal through three soft
  // stages, so a change starts and ends gently, goes straight from any view to any other, and
  // can be redirected half-way without a jolt.
  const wChase = [0, 0, 0]
  const wCock = [0, 0, 0]
  wChase.fill(viewTarget === 1 ? 1 : 0)
  wCock.fill(viewTarget === 2 ? 1 : 0)
  let vC = wChase[2] // chase
  let vK = wCock[2] // cockpit (what is left over is the overhead view)
  let jetFade = 1 // how solid the leader is drawn: it fades out as the camera moves into it
  let camSpin = 0 // 1 while the camera is going round with a roll that began in the cockpit
  let chaseYaw = 0 // heading of the chase camera (lags the jet a little in turns)
  let yawDiff = 0 // how far the chase heading is from the overhead one, kept continuous
  let vQ = 0 // 1 / camera distance: 0 is the flat sprite-stack view
  let vTan = 1 // how steeply the camera looks down
  let vS = 1 // scale at the jet
  let vCx = 0 // where the jet sits on screen
  let vCy = 0
  let vCos = 1
  let vSin = 0
  let vYaw = 0
  let vIn = 0 // 0..1: how far into the cockpit the camera is
  const smoke = new Float32Array(SMOKE_N * SMOKE_F) // x, y, z, born, size, push x, push y, strength, life
  let smokeHead = 0
  let smokeClock = 0
  let vRoll = 0 // the camera's roll (cockpit only)
  let vSteerY = 0 // the screen row that means "hold this height" when pointing to climb or dive
  let vLean = 1 // how steeply the chase camera would look down if nothing were in its way
  let camFix = 0 // how far the chase camera is moved up or down to stay clear of hills and clouds, px
  let camFloor = 0 // the lowest the chase camera may sit right now, px
  let floorS = 0 // the lowest the jet may fly right now (the ground ahead plus clearance), smoothed
  let speedNow = p.speed
  // the pilot's head, swaying with the flying (design pixels; right and down are positive)
  let headX = 0
  let headY = 0
  let headVX = 0
  let headVY = 0
  // Smooth flames are not drawn into the picture: the fire layer over it draws them. For each:
  // nozzle x y, a point straight behind it x y, tip x y (frame px), radius at the nozzle,
  // how much larger things are at the tip, thrust 0..1, strength 0..1, how much of the nozzle,
  // middle and tip can be seen, which flame it is, the afterburner setting, and its true
  // length in nozzle radii.
  const flameData = new Float32Array(FLAME_MAX * FLAME_F)
  const flameOut = { count: 0, data: flameData }
  const flameSeen = new Float32Array(FLAME_MAX * 3).fill(1)
  const flameV = [0, 0, 0]

  /** 0..1: how far the cockpit has slid into place round the camera */
  function cockpitIn() {
    const u = clamp((vK - 0.16) / 0.84, 0, 1)
    return u * u * u * (u * (u * 6 - 15) + 10)
  }

  function updateView() {
    const sc = jetSize()
    const lead = jets[0]
    const top = 1 - vC - vK
    vCx = W >> 1
    vIn = vK
    cam.x = follow.x
    cam.y = follow.y
    cam.alt = follow.alt
    if ((vC === 0 && vK === 0) || !lead) {
      // the plain overhead view, exactly
      vQ = 0
      vTan = 1
      vLean = 1
      vS = 1
      vCy = H >> 1
      vSteerY = vCy
      vRoll = 0
      jetFade = 1
      vYaw = cam.yaw
    } else {
      // Each view is a camera pose; the frame shows a blend of the three.
      // chase: behind the jet (under boost it closes in a little, which widens the view)
      const dist = clamp(p.chaseDistance, 1, 8) * JET_L * sc * (1 - 0.16 * boost)
      const zoom = Math.max(1, (clamp(p.chaseSize, 0.05, 0.6) * W) / (JET_W * sc))
      // cockpit: at the pilot's eyes, looking at a point ahead of the nose
      const focalIn = W * 0.6 * (1 - 0.1 * boost)
      const ahead = COCKPIT_LOOK * vK
      const sn = Math.sin(lead.yaw)
      const cs = Math.cos(lead.yaw)
      cam.x += (lead.x + sn * ahead - follow.x) * vK
      cam.y += (lead.y - cs * ahead - follow.y) * vK
      cam.alt += (lead.z + COCKPIT_EYE * sc - follow.alt) * vK
      vQ = vC / dist + vK / COCKPIT_LOOK
      vS = Math.exp(vC * Math.log(zoom) + vK * Math.log(focalIn / COCKPIT_LOOK))
      // how steeply it looks down: 45° overhead, the chase angle behind, level in the cockpit.
      // The chase camera drops behind the jet as it climbs and rises over it as it dives, and
      // camFix lifts or lowers it to stay clear of the hills and out of the cloud layer.
      const angle = (45 * top + clamp(p.chaseAngle, 2, 40) * vC) * (Math.PI / 180)
      vLean = Math.tan(angle) - 0.5 * climbTilt * vC
      const free = 1 - vK
      vTan = Math.max(vLean + camFix * vQ * free, (camFloor - cam.alt) * vQ * free, (2 - cam.alt) * vQ)
      // where the jet (or, in the cockpit, the horizon) sits in the frame; a climb drops the horizon
      const focal = vS / vQ
      const cyChase = (H >> 1) + H * (0.14 - 0.03 * boost)
      const cyIn = pivotY + focal * Math.tan(clamp(lead.pitch * 0.8, -0.6, 0.6))
      vCy = top * (H >> 1) + vC * cyChase + vK * cyIn
      vSteerY = top * (H >> 1) + vC * cyChase + vK * H * 0.34
      // in the cockpit the view rolls and turns exactly with the jet
      // (a full roll is followed either all the way round or not at all, so it always ends level)
      vRoll = lead.roll * vK + spinOf(lead) * camSpin
      const behind = cam.yaw + yawDiff
      vYaw = cam.yaw + yawDiff * (vC + vK) + wrapAngle(-lead.yaw - behind) * vK
      // the jet fades away as the camera moves into it
      const f = clamp((vK - 0.12) / 0.4, 0, 1)
      jetFade = 1 - f * f * (3 - 2 * f)
    }
    vCos = Math.cos(vYaw)
    vSin = Math.sin(vYaw)
  }

  /** how long the afterburner flames are, in jet pixels (before the flicker) */
  function flameLength() {
    return (0.07 + 0.17 * p.afterburner) * JET_L * burn * clamp(1.6 - spreadNow * 0.6, 0, 1) * (1 + 1.6 * boost)
  }
  /** how far the flames bend: the exhaust trails round the inside of a turn */
  function flameBend() {
    const lead = jets[0]
    return lead ? clamp(lead.yawRate / Math.max(0.1, p.agility), -1, 1) * 0.36 : 0
  }
  /** how far through a full roll a jet is, as an angle (0 when it is not rolling) */
  function spinOf(j: Jet) {
    if (j.stunt < 0 || j.stuntDelay > 0) return 0
    const t = j.stunt
    return j.stuntDir * Math.PI * 2 * (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
  }
  /** a jet's bank angle, including any roll it is half-way through */
  function rollOf(j: Jet) {
    return j.roll + spinOf(j)
  }
  const groundAt = (x: number, y: number) => heightMap[(((y | 0) & NM) << NSHIFT) | ((x | 0) & NM)]
  /** the tallest ground under a jet and along the next stretch of its path */
  function groundAhead(j: Jet, speed: number) {
    const sn = Math.sin(j.yaw)
    const cs = Math.cos(j.yaw)
    let top = 0
    for (let i = 0; i <= 4; i++) {
      const d = speed * 0.16 * i
      for (let side = -1; side <= 1; side++) {
        const h = groundAt(j.x + sn * d + cs * side * 7, j.y - cs * d + sn * side * 7)
        if (h > top) top = h
      }
    }
    return top
  }

  const jetSize = () => clamp(p.jetScale || 1, 0.4, 2)
  const formX = () => JET_W * 1.2 * jetSize() + 2
  const formY = () => JET_L * 0.74 * jetSize()

  function resetFlight() {
    const yaw = 0.9
    jets = [makeJet(spawnX, spawnY, p.altitude, yaw)]
    cam.x = follow.x = spawnX
    cam.y = follow.y = spawnY
    cam.yaw = -yaw * p.cameraFollow
    cam.alt = follow.alt = p.altitude
    camFix = 0
    camFloor = 0
    floorS = 0
    chaseYaw = -yaw
    yawDiff = wrapAngle(chaseYaw - cam.yaw)
    introT = p.intro ? 0 : 99
    burn = p.intro ? 0 : 1
    autoStunt = 7
    altGoal = p.altitude
    climbV = 0
    climbTilt = 0
    boost = 0
  }
  function syncWingmen() {
    const want = 1 + clamp(Math.round(p.wingmen), 0, 2)
    const lead = jets[0]
    while (jets.length < want) {
      const side = jets.length === 1 ? -1 : 1
      const j = makeJet(
        lead.x + Math.cos(lead.yaw) * side * formX() - Math.sin(lead.yaw) * formY(),
        lead.y + Math.sin(lead.yaw) * side * formX() + Math.cos(lead.yaw) * formY(),
        lead.z, lead.yaw,
      )
      jets.push(j)
    }
    if (jets.length > want) jets.length = want
  }

  rebuildPalettes()
  buildWorld()
  resetFlight()
  syncWingmen()

  function setParams(next: SceneParams) {
    const prev = p
    p = { ...next }
    if (prev.seed !== p.seed) { worldDirty = 0.2; reseat = true }
    if (prev.land !== p.land) worldDirty = 0.2
    if (
      prev.timeOfDay !== p.timeOfDay || prev.bodyColor !== p.bodyColor ||
      prev.accentColor !== p.accentColor || prev.canopyColor !== p.canopyColor
    ) rebuildPalettes()
    if (prev.intro !== p.intro && p.intro) { introT = 0; burn = 0 }
    if (prev.view !== p.view) viewTarget = viewIndex(p.view)
    syncWingmen()
  }

  function resize(w: number, h: number) {
    W = Math.max(8, w | 0)
    H = Math.max(8, h | 0)
    const buf = new ArrayBuffer(W * H * 4)
    fb = new Uint32Array(buf)
    bytes = new Uint8ClampedArray(buf)
    jetMask = new Uint8Array(W * H)
    colY = new Int32Array(W)
    zbuf = new Float32Array(W * H)
    // the square sheet reaches every corner of the frame however far the view is rolled
    pivotY = Math.round(H * 0.34)
    cockpit = null
    cockpitDue = 0.3
    const tall = Math.max(pivotY, H - pivotY)
    sheetSide = (Math.ceil(Math.sqrt((W / 2) * (W / 2) + tall * tall)) + 2) * 2
    sheet = new Uint32Array(sheetSide * sheetSide)
    sheetMask = new Uint8Array(sheetSide * sheetSide)
    sheetColY = new Int32Array(sheetSide)
    sheetZ = new Float32Array(sheetSide * sheetSide)
    backdrop = new Uint32Array(W * H)
    sheetBackdrop = new Uint32Array(sheetSide * sheetSide)
    updateView()
  }

  function pointerMove(x: number, y: number) {
    keyMode = false
    pointerOn = true
    pointerX = x
    pointerY = y
    pointerIdle = 0
  }
  function pointerLeave() {
    pointerOn = false
    holding = false
  }
  function press() {
    holding = true
    holdT = 0
  }
  function release() {
    if (holding && holdT < HOLD) startRoll() // a click rolls; a hold was the thrusters
    holding = false
  }
  /**
   * Arrow keys / WASD or a game controller's stick: turn −1..1, climb −1..1, whether the boost
   * key is down, and how far a controller's trigger is squeezed (0..1: it opens the thrusters
   * part of the way).
   */
  function setKeys(turn: number, climb: number, boostHeld: boolean, thrust = 0) {
    keyTurn = clamp(turn, -1, 1)
    keyClimb = clamp(climb, -1, 1)
    boostKey = boostHeld
    padThrust = clamp(thrust, 0, 1)
    if (keyTurn !== 0 || keyClimb !== 0) keyMode = true
  }
  function startRoll() {
    const lead = jets[0]
    if (lead.stunt >= 0) return
    const dir = lead.yawRate >= 0 ? 1 : -1
    camSpin = vK > 0.5 ? 1 : 0
    jets.forEach((j, i) => {
      j.stunt = 0
      j.stuntDir = dir
      j.stuntDelay = i * 0.16
    })
  }
  /** on to the next view: overhead → behind the jet → cockpit → overhead */
  function toggleView() {
    viewTarget = (viewTarget + 1) % 3
  }
  function replayIntro() {
    introT = 0
    burn = 0
  }

  // ── simulation
  function step(dtRaw: number) {
    const dt = clamp(dtRaw, 0, 0.05)
    time += dt
    introT += dt
    pointerIdle += dt
    if (holding) holdT += dt
    if (worldDirty > 0) {
      worldDirty -= dt
      if (worldDirty <= 0) {
        buildWorld()
        if (reseat) {
          const dx = spawnX - jets[0].x
          const dy = spawnY - jets[0].y
          for (const j of jets) { j.x += dx; j.y += dy; j.trailLen = 0; j.lastTrailX = j.x; j.lastTrailY = j.y }
          follow.x += dx
          follow.y += dy
          reseat = false
        }
      }
    }
    if (!cockpit && W > 0) {
      cockpitDue -= dt
      if (cockpitDue <= 0) cockpitArt()
    }
    const introDone = introT > 1.9
    burn += ((introDone ? 1 : 0) - burn) * (1 - Math.exp(-dt * 5))

    // holding down opens the thrusters: longer flames, more speed
    const pushing = introDone && ((holding && holdT >= HOLD) || boostKey)
    const boostGoal = pushing ? 1 : introDone ? padThrust : 0
    boost += (boostGoal - boost) * (1 - Math.exp(-dt * (boostGoal > boost ? 5 : 2.4)))
    if (boost < 0.0005 && boostGoal === 0) boost = 0
    const speed = p.speed * (1 + (clamp(p.boost, 1, 4) - 1) * boost)
    speedNow = speed
    spreadNow += (p.spread - spreadNow) * (1 - Math.exp(-dt * 11))

    const lead = jets[0]
    const maxRate = Math.max(0.1, p.agility)
    // how low and how high it may fly: it skims whatever ground lies ahead, with a little
    // room to spare, so it can get close but never hit anything; the ceiling is a setting
    const clearance = clamp(p.clearance, 2, 60)
    const floorNow = groundAhead(lead, speed) + clearance
    if (floorS === 0) floorS = floorNow
    floorS += (floorNow - floorS) * (1 - Math.exp(-dt * (floorNow > floorS ? 9 : 3)))
    const altLo = floorS
    const altHi = Math.max(altLo, p.altitude, clamp(p.ceiling, 20, 900))
    const climbMax = speed * 0.55
    const chase = vC + vK > 0.5 // flying from behind or from the seat

    // where to turn and, from behind, how high to fly
    let want = 0
    let flown = false // true while the player is choosing the height
    const stick = p.invertY ? -1 : 1 // like a flight stick, down climbs and up dives
    const steering = p.followPointer && pointerOn && pointerIdle < 5
    if (!introDone) {
      want = 0
    } else if (keyMode) {
      want = keyTurn * maxRate
      altGoal += keyClimb * stick * climbMax * dt
      flown = true
    } else if (steering && (chase || project(lead.x, lead.y, lead.z))) {
      const vx = pointerX - prX
      const vy = pointerY - prY
      if (chase) {
        // from behind: point left or right of the jet to turn, above or below it to climb or dive
        const t = clamp((pointerX - vCx) / (W * 0.26), -1, 1)
        if (Math.abs(t) > 0.06) want = t * maxRate
        const raw = pointerY < vSteerY ? (vSteerY - pointerY) / Math.max(1, vSteerY) : -(pointerY - vSteerY) / Math.max(1, H - vSteerY)
        const up = stick * Math.sign(raw) * Math.max(0, Math.abs(raw) - 0.08) / 0.92
        altGoal = up >= 0 ? p.altitude + up * (altHi - p.altitude) : p.altitude + up * (p.altitude - altLo)
        flown = true
      } else {
        flown = true // overhead: keep the height it was flown to
        if (vx * vx + vy * vy > 18 * 18) {
        const fx = vx * vCos + vy * vSin
        const fy = -vx * vSin + vy * vCos
          const err = wrapAngle(Math.atan2(fx, -fy) - lead.yaw)
          want = clamp(err * 2.6, -maxRate, maxRate)
        }
      }
    } else {
      want = maxRate * (0.62 * Math.sin(time * 0.31 + 1.3) + 0.38 * Math.sin(time * 0.73 + 0.4) + 0.22 * Math.sin(time * 0.17))
      want = clamp(want, -maxRate, maxRate)
      if (p.stunts) {
        autoStunt -= dt
        if (autoStunt <= 0) { startRoll(); autoStunt = 9 + (hash8((time * 10) | 0) / 255) * 7 }
      }
    }
    lead.yawRate += (want - lead.yawRate) * (1 - Math.exp(-dt * 2.6))
    lead.yaw += lead.yawRate * dt
    const bankMax = (p.bank * Math.PI) / 180
    const rollTarget = clamp(lead.yawRate / maxRate, -1, 1) * bankMax
    lead.roll += (rollTarget - lead.roll) * (1 - Math.exp(-dt * 5))
    lead.vx = Math.sin(lead.yaw) * speed
    lead.vy = -Math.cos(lead.yaw) * speed
    lead.x += lead.vx * dt
    lead.y += lead.vy * dt
    // height: left alone it drifts back to cruising; it climbs and dives at a limited rate
    if (!flown) altGoal += (p.altitude - altGoal) * (1 - Math.exp(-dt * 0.9))
    altGoal = clamp(altGoal, altLo, altHi)
    let dz = (altGoal + Math.sin(time * 0.9) * 1.5 - lead.z) * (1 - Math.exp(-dt * 3))
    dz = clamp(dz, -climbMax * dt, climbMax * dt)
    lead.z += dz
    // last resort: never closer to what is right underneath than most of the clearance
    const hard = groundAt(lead.x, lead.y) + clearance * 0.7
    if (lead.z < hard) lead.z += (hard - lead.z) * (1 - Math.exp(-dt * 22))
    climbV += (dz / Math.max(dt, 1e-4) - climbV) * (1 - Math.exp(-dt * 6))
    // nose up in a climb, down in a dive (the gentle cruise bob does not count)
    const climbing = Math.sign(climbV) * Math.max(0, Math.abs(climbV) - 3)
    climbTilt = clamp((climbing / Math.max(20, speed)) * 1.25, -0.5, 0.5)
    const pitchTarget = Math.abs(lead.yawRate / maxRate) * 0.1 + climbTilt
    lead.pitch += (pitchTarget - lead.pitch) * (1 - Math.exp(-dt * 4))
    // the pilot's head: it leans into a turn, sinks in a climb and under thrust, lifts in a
    // dive, and is never quite still. On a soft spring, so it overshoots a little and settles.
    const hxGoal = clamp(lead.yawRate / maxRate, -1, 1) * 6.4 + Math.sin(time * 0.53) * 0.3
    const hyGoal = clamp(climbTilt / 0.5, -1, 1) * 3.4 + boost * 1.6 + Math.sin(time * 0.71 + 1) * 0.25
    headVX += ((hxGoal - headX) * 64 - headVX * 11) * dt
    headVY += ((hyGoal - headY) * 64 - headVY * 11) * dt
    headX = clamp(headX + headVX * dt, -8, 8)
    headY = clamp(headY + headVY * dt, -5, 5)

    // wingmen hold formation
    for (let i = 1; i < jets.length; i++) {
      const j = jets[i]
      const side = i === 1 ? -1 : 1
      const tx = lead.x + Math.cos(lead.yaw) * side * formX() - Math.sin(lead.yaw) * formY()
      const ty = lead.y + Math.sin(lead.yaw) * side * formX() + Math.cos(lead.yaw) * formY()
      const k = 1 - Math.exp(-dt * 3.2)
      const ox = j.x
      const oy = j.y
      j.x += lead.vx * dt + (tx - (j.x + lead.vx * dt)) * k
      j.y += lead.vy * dt + (ty - (j.y + lead.vy * dt)) * k
      j.vx = (j.x - ox) / Math.max(dt, 1e-4)
      j.vy = (j.y - oy) / Math.max(dt, 1e-4)
      j.yaw += wrapAngle(lead.yaw - j.yaw) * (1 - Math.exp(-dt * 4))
      j.roll += (lead.roll - j.roll) * (1 - Math.exp(-dt * 3.2))
      j.pitch = lead.pitch
      j.z += (lead.z + Math.sin(time * 1.1 + i * 2) * 1.2 - j.z) * (1 - Math.exp(-dt * 3))
      j.z = Math.max(j.z, groundAt(j.x, j.y) + clearance * 0.7)
    }

    for (const j of jets) {
      const gNow = clamp(Math.abs(lead.yawRate) / maxRate + (j.stunt >= 0 ? 0.7 : 0) + boost * 0.9 + Math.abs(climbTilt), 0, 1)
      j.g += (gNow - j.g) * (1 - Math.exp(-dt * 2.5))
      if (j.stunt >= 0) {
        if (j.stuntDelay > 0) j.stuntDelay -= dt
        else {
          j.stunt += dt / 0.85
          if (j.stunt >= 1) j.stunt = -1
        }
      }
      // wingtip trails
      const ddx = j.x - j.lastTrailX
      const ddy = j.y - j.lastTrailY
      if (ddx * ddx + ddy * ddy > 6.25) {
        j.lastTrailX = j.x
        j.lastTrailY = j.y
        const ax = axes(j)
        for (let w = 0; w < 2; w++) {
          const sc = jetSize()
          const a = (w === 0 ? -WINGTIP_A : WINGTIP_A) * sc
          const b = (PIV_K - WINGTIP_K) * sc
          const hy = (WINGTIP_Y - PIV_Y) * sc
          const o = j.trailHead * 4
          j.trail[w][o] = j.x + a * ax.rx + b * ax.fx + hy * ax.ux
          j.trail[w][o + 1] = j.y + a * ax.ry + b * ax.fy + hy * ax.uy
          j.trail[w][o + 2] = j.z + a * ax.rz + b * ax.fz + hy * ax.uz
          j.trail[w][o + 3] = time
        }
        j.trailHead = (j.trailHead + 1) % TRAIL_N
        if (j.trailLen < TRAIL_N) j.trailLen++
      }
    }

    // a little dark smoke off the end of each flame, left hanging in the air behind the jet
    smokeClock += dt
    const every = 0.034 - 0.012 * boost
    if (smokeClock >= every && burn > 0.6 && p.afterburner > 0.05 && spreadNow < 2) {
      smokeClock = 0
      const len = flameLength()
      const sc = jetSize()
      for (let i = 0; i < jets.length; i++) {
        const j = jets[i]
        const ax = axes(j)
        const side = (smokeHead + i) & 1 ? 1 : -1
        const t = len * 0.78
        const a = (side * ENGINE_A + flameBend() * ((t * t) / Math.max(1, len))) * sc
        const b = (PIV_K - NOZZLE_K - t) * sc
        const hy = (ENGINE_Y - PIV_Y) * sc
        const o = smokeHead * SMOKE_F
        smoke[o] = j.x + a * ax.rx + b * ax.fx + hy * ax.ux
        smoke[o + 1] = j.y + a * ax.ry + b * ax.fy + hy * ax.uy
        smoke[o + 2] = j.z + a * ax.rz + b * ax.fz + hy * ax.uz
        smoke[o + 3] = time
        smoke[o + 4] = (1.3 + (hash8(smokeHead * 31 + 7) / 255) * 1.2) * sc
        smoke[o + 5] = -lead.vx * 0.3 + (hash8(smokeHead * 17 + 3) - 128) * 0.05
        smoke[o + 6] = -lead.vy * 0.3 + (hash8(smokeHead * 13 + 5) - 128) * 0.05
        smoke[o + 7] = (0.46 + 0.36 * boost) * clamp(p.afterburner * 1.4, 0, 1)
        smoke[o + 8] = 0.75 + 0.5 * boost + (hash8(smokeHead * 5) / 255) * 0.3
        smokeHead = (smokeHead + 1) % SMOKE_N
      }
    }

    // the view weights glide to their goals (three soft stages each)
    const goC = viewTarget === 1 ? 1 : 0
    const goK = viewTarget === 2 ? 1 : 0
    const ease = 1 - Math.exp((-dt * 7.6) / clamp(p.transition, 0.2, 8))
    let settled = true
    for (let i = 0; i < 3; i++) {
      wChase[i] += ((i === 0 ? goC : wChase[i - 1]) - wChase[i]) * ease
      wCock[i] += ((i === 0 ? goK : wCock[i - 1]) - wCock[i]) * ease
      if (Math.abs(wChase[i] - goC) > 0.0004 || Math.abs(wCock[i] - goK) > 0.0004) settled = false
    }
    if (settled) {
      wChase.fill(goC)
      wCock.fill(goK)
    }
    vC = wChase[2]
    vK = wCock[2]

    // camera: ahead of the leader, turning part of the way with it
    const look = (22 + 16 * boost) * (1 - vC - vK)
    const tx = lead.x + Math.sin(lead.yaw) * look
    const ty = lead.y - Math.cos(lead.yaw) * look
    const kc = 1 - Math.exp(-dt * 3.5)
    follow.x += lead.vx * dt + (tx - (follow.x + lead.vx * dt)) * kc
    follow.y += lead.vy * dt + (ty - (follow.y + lead.vy * dt)) * kc
    cam.yaw += (-lead.yaw * clamp(p.cameraFollow, 0, 1) - cam.yaw) * (1 - Math.exp(-dt * 1.6))
    follow.alt += (lead.z - follow.alt) * (1 - Math.exp(-dt * 3))
    // the chase camera keeps clear of the hills behind the jet, and stays out of the cloud
    // layer: under it while the jet is low, over it otherwise
    let fix = 0
    camFloor = 0
    if (vC > 0.3 && vQ > 1e-4) {
      const back = 1 / vQ
      const gx = cam.x + vSin * back
      const gy = cam.y + vCos * back
      let top = 0
      for (let iy = -1; iy <= 1; iy++) for (let ix = -1; ix <= 1; ix++) top = Math.max(top, groundAt(gx + ix * 9, gy + iy * 9))
      camFloor = top + 5
      const nominal = follow.alt + vLean * back
      let want = Math.max(nominal, camFloor)
      if (want > CLOUD_ALT - 3 && want < ZTOP + 3) want = lead.z < CLOUD_ALT - 8 ? Math.max(camFloor, CLOUD_ALT - 3) : ZTOP + 3
      fix = want - nominal
    }
    camFix += (fix - camFix) * (1 - Math.exp(-dt * 7))
    // the chase camera sits behind the jet and swings round a beat late in turns
    chaseYaw += (-lead.yaw - chaseYaw) * (1 - Math.exp(-dt * 3.4))
    const raw = chaseYaw - cam.yaw
    if (vC === 0 && vK === 0) yawDiff = wrapAngle(raw)
    else yawDiff += wrapAngle(raw - yawDiff)
    updateView()
  }

  // the jet's own axes in the world (x right, y down the map, z up)
  function axes(j: Jet) {
    const cs = Math.cos(j.yaw)
    const sn = Math.sin(j.yaw)
    const roll = rollOf(j)
    const cr = Math.cos(roll)
    const sr = Math.sin(roll)
    // right wing dips for a positive roll
    const rx = cs * cr
    const ry = sn * cr
    const rz = -sr
    const u2x = cs * sr
    const u2y = sn * sr
    const u2z = cr
    const cp = Math.cos(j.pitch)
    const sp = Math.sin(j.pitch)
    const fx = sn * cp + u2x * sp
    const fy = -cs * cp + u2y * sp
    const fz = u2z * sp
    const ux = u2x * cp - sn * sp
    const uy = u2y * cp + cs * sp
    const uz = u2z * cp
    return { rx, ry, rz, fx, fy, fz, ux, uy, uz, cr }
  }

  // ── drawing
  //
  // One camera covers both views. A world point lands on screen at
  //   scale = S / (1 + q·depth)     x = Cx + scale·across     y = Cy − scale·(height + slope·depth)
  // With q = 0 this is the flat sprite-stack view: every layer is drawn one pixel above the last.
  // Raising q brings the camera in behind the jet: far things shrink and a horizon appears.
  // Switching views only slides q, the slope, the scale and the heading, so there is no cut.
  const sjx = new Float64Array(3)
  const sjy = new Float64Array(3)
  const srx = new Float64Array(3)
  const sry = new Float64Array(3)
  const sfx = new Float64Array(3)
  const sfy = new Float64Array(3)
  const sic = new Float64Array(3)
  const rowNow = new Int32Array(64) // screen row of every height at this depth step
  const rowPrev = new Int32Array(64) // … and at the step before
  const offX = new Float32Array(64)
  const offY = new Float32Array(64)
  const sliceOrder = new Int32Array(JET_H)
  const sliceKey = new Float64Array(JET_H)
  let prX = 0
  let prY = 0
  let prM = 0
  let prV = 0

  /** world point → screen (prX, prY) and its scale (prM); false when it is behind the camera */
  function project(x: number, y: number, z: number) {
    const dx = x - cam.x
    const dy = y - cam.y
    const depth = -(dx * vSin + dy * vCos)
    const den = 1 + vQ * depth
    if (den < 0.12) return false
    prV = depth
    prM = vS / den
    prX = vCx + prM * (dx * vCos - dy * vSin)
    prY = vCy - prM * (z - cam.alt + vTan * depth)
    return true
  }

  // The islands and clouds, drawn from the nearest ground to the farthest. Every ground pixel
  // is a column of stacked layers: its top is drawn where the column ends and its wall where it
  // starts, and a pixel that is already taken stays taken (nearer things win).
  function drawWorld() {
    const _fb = fb
    const _zb = zbuf
    if (rowLo === 0 && rowHi === H && colLo === 0 && colHi === W) {
      _fb.fill(0)
      _zb.fill(1e9)
    } else {
      for (let y = rowLo; y < rowHi; y++) {
        _fb.fill(0, y * W + colLo, y * W + colHi)
        _zb.fill(1e9, y * W + colLo, y * W + colHi)
      }
    }
    colY.fill(rowHi)
    const c = vCos
    const s = vSin
    const q = vQ
    const S = vS
    const tn = vTan
    const Cx = vCx
    const Cy = vCy
    const A = cam.alt
    const bx = cam.x - Math.floor(cam.x / N) * N + N * 2
    const by = cam.y - Math.floor(cam.y / N) * N + N * 2
    const rankMax = Math.round(clamp(p.clouds, 0, 1) * 16)
    const cloudsOn = rankMax > 0
    const cdx = (time * 7) % NC
    const cdy = (time * 3) % NC
    const csx = sunX * CLOUD_ALT - cdx + NC
    const csy = sunY * CLOUD_ALT - cdy + NC
    const tW1 = ((time * 6) | 0) & 1023
    const tW2 = ((time * 4) | 0) & 1023
    const tF = (time * 36) | 0
    const sx = sunX
    const sy = sunY
    const isc = 1 / jetSize()
    const reach = JET_L * 0.75 * jetSize() + 3
    let nShadow = 0
    if (p.shadow && introT > 0.3) {
      for (let j = 0; j < jets.length && j < 3; j++) {
        const jet = jets[j]
        const ax = axes(jet)
        sjx[j] = bx + (jet.x - cam.x) + sx * jet.z
        sjy[j] = by + (jet.y - cam.y) + sy * jet.z
        const cs = Math.cos(jet.yaw)
        const sn = Math.sin(jet.yaw)
        srx[j] = cs
        sry[j] = sn
        sfx[j] = sn
        sfy[j] = -cs
        sic[j] = 1 / (Math.max(0.3, Math.abs(ax.cr)) * jetSize())
        nShadow++
      }
    }
    const _h = heightMap
    const _m = matMap
    const _cn = cloudN
    const _nz = nz
    const _cy = colY
    const hzR = hazeCol & 255
    const hzG = (hazeCol >> 8) & 255
    const hzB = (hazeCol >> 16) & 255
    const mixHaze = (col: number, keep: number, fog: number) =>
      ((255 << 24) |
        (((((col >> 16) & 255) * keep + hzB * fog) >> 8) << 16) |
        (((((col >> 8) & 255) * keep + hzG * fog) >> 8) << 8) |
        (((col & 255) * keep + hzR * fog) >> 8)) >>> 0

    // start where the tallest thing sits on the bottom row; stop when the sea leaves the top
    // of the frame, or at the view distance once there is a horizon
    // (a camera down among the hills and clouds starts right in front of itself instead)
    const below = rowHi - Cy
    const nearest = q > 0 ? -0.85 / q : -1e9
    const camHigh = q > 0 ? A + tn / q : 1e9
    const dn = S * tn + q * below
    let v = camHigh > ZTOP + 1 && dn > 1e-6 ? Math.max(nearest, (S * (A - ZTOP) - below) / dn - 2) : nearest
    // from higher up it sees further, and the haze starts further out
    const viewDist = VIEW_DIST + 3 * A
    const fogStart = FOG_START + 2 * A
    const above = Cy - rowLo + 2
    let vEnd = viewDist
    if (S * tn > q * above) vEnd = Math.min(viewDist, (S * A + above) / (S * tn - q * above))
    let den = 1 + q * v
    let m = S / den
    let R = Cy - m * (tn * v - A) + EPS
    for (let z = 0; z <= ZTOP; z++) rowNow[z] = Math.floor(R - m * z)
    const rowsK = S * (tn + q * A)
    for (let guard = 0; v < vEnd && guard < 4000; guard++) {
      // one step deeper: about one screen row of sea, never coarser than a few pixels across
      let dv = (den * den) / rowsK
      const cap = (2.5 * den) / S
      if (dv > cap) dv = cap
      if (dv < 0.5) dv = 0.5
      v += dv
      den = 1 + q * v
      m = S / den
      R = Cy - m * (tn * v - A) + EPS
      for (let z = 0; z <= ZTOP; z++) {
        rowPrev[z] = rowNow[z]
        rowNow[z] = Math.floor(R - m * z)
      }
      const inv = den / S
      const ax = c * inv
      const ay = -s * inv
      let wx = bx - Cx * ax - v * s
      let wy = by - Cx * ay - v * c
      // distance haze: colours step towards the horizon colour, a few shades at a time
      let fog = 0
      if (q > 0 && v > fogStart) {
        const f = (v - fogStart) / (viewDist - fogStart)
        fog = Math.min(256, ((Math.sqrt(f) * FOG_STEPS + 0.5) | 0) * (256 / FOG_STEPS)) | 0
      }
      const keep = 256 - fog
      const fine = inv < 1.8
      wx += ax * colLo
      wy += ay * colLo
      for (let px = colLo; px < colHi; px++, wx += ax, wy += ay) {
        // clouds: a stack of up to CK layers floating at CLOUD_ALT
        if (cloudsOn) {
          const cv = _cn[((((wy - cdy + NC) | 0) & NCM) << NCSHIFT) | (((wx - cdx + NC) | 0) & NCM)]
          if (cv !== 0 && cv >> 4 < rankMax) {
            const tk = cv & 15
            const zt = CLOUD_ALT + tk - 1
            let y0 = rowNow[zt]
            let y1 = rowPrev[zt]
            if (y0 < rowLo) y0 = rowLo
            if (y1 > rowHi) y1 = rowHi
            if (y0 < y1) {
              let col = cloudTop[tk - 1]
              if (fog > 0) col = mixHaze(col, keep, fog)
              for (let y = y0, o = y0 * W + px; y < y1; y++, o += W) {
                // the thinnest rim is a checker, so the cloud edge is soft
                if (_fb[o] !== 0 || (tk === 1 && ((px + y) & 1) === 0)) continue
                _fb[o] = col
                _zb[o] = v
              }
            }
            // its underside, when the camera is below the clouds
            let u0 = rowPrev[CLOUD_ALT]
            let u1 = rowNow[CLOUD_ALT]
            if (u0 < u1) {
              if (u0 < rowLo) u0 = rowLo
              if (u1 > rowHi) u1 = rowHi
              const col = fog > 0 ? mixHaze(cloudUnder, keep, fog) : cloudUnder
              for (let y = u0, o = u0 * W + px; y < u1; y++, o += W) {
                if (_fb[o] !== 0 || (tk === 1 && ((px + y) & 1) === 0)) continue
                _fb[o] = col
                _zb[o] = v
              }
            }
            for (let k = tk - 2; k >= 0; k--) {
              let ya = rowPrev[CLOUD_ALT + k + 1]
              let yb = rowPrev[CLOUD_ALT + k]
              if (ya < rowLo) ya = rowLo
              if (yb > rowHi) yb = rowHi
              if (ya >= yb) continue
              let col = cloudSide[k]
              if (fog > 0) col = mixHaze(col, keep, fog)
              for (let y = ya, o = ya * W + px; y < yb; y++, o += W) {
                if (_fb[o] === 0) { _fb[o] = col; _zb[o] = v }
              }
            }
          }
        }
        // terrain
        const gx = wx | 0
        const gy = wy | 0
        const idx = ((gy & NM) << NSHIFT) | (gx & NM)
        const h = _h[idx]
        let cY = _cy[px]
        const yT = rowNow[h]
        let yR = rowPrev[h]
        if (yT >= cY && yR >= cY) continue
        const mat = _m[idx]
        // shadows: clouds, then the jets
        let shade = 0
        if (cloudsOn) {
          const sv = _cn[((((gy + csy) | 0) & NCM) << NCSHIFT) | (((gx + csx) | 0) & NCM)]
          if ((sv & 15) > 1 && sv >> 4 < rankMax) shade = 1
        }
        if (shade === 0 && nShadow > 0) {
          for (let j = 0; j < nShadow; j++) {
            const dx = gx - sjx[j] + sx * h
            const dy = gy - sjy[j] + sy * h
            if (dx > -reach && dx < reach && dy > -reach && dy < reach) {
              const a = (dx * srx[j] + dy * sry[j]) * sic[j]
              const b = (dx * sfx[j] + dy * sfy[j]) * isc
              const i = Math.floor(a + JET_W / 2)
              const k = Math.floor(PIV_K - b + 0.5)
              if (i >= 0 && i < JET_W && k >= 0 && k < JET_L && shadowMask[k * JET_W + i] === 1) { shade = 1; break }
            }
          }
        }
        let top: number
        let side: number
        if (mat < 4) {
          top = shade ? topShade[mat] : topLit[mat]
          if (mat === 3) {
            if (((_nz[((gy & 255) << 8) | (gx & 255)] + tF) & 255) < 120) top = shade ? topShade[2] : foamCol
          } else if (shade === 0 && fine) {
            const n1 = _nz[((gy & 255) << 8) | (((gx + tW1) >> 2) & 255)]
            if (n1 > 243) {
              const n2 = _nz[(((gy + 91) & 255) << 8) | (((gx + 1024 - tW2) >> 2) & 255)]
              if (n2 > 128) top = n1 > 252 ? sparkB : sparkA
            }
          }
          side = top
        } else {
          top = shade ? topShade[mat] : topLit[mat]
          side = shade ? sideShade[mat] : sideLit[mat]
        }
        if (fog > 0) {
          top = mixHaze(top, keep, fog)
          side = mixHaze(side, keep, fog)
        }
        // the wall of this column, where it starts …
        if (yR < cY) {
          if (yR < rowLo) yR = rowLo
          for (let y = yR, o = yR * W + px; y < cY; y++, o += W) {
            if (_fb[o] === 0) { _fb[o] = side; _zb[o] = v }
          }
          cY = yR
        }
        // … and its top, up to where it ends (unless the camera is below it)
        if (yT < cY) {
          const y0 = yT < rowLo ? rowLo : yT
          for (let y = y0, o = y0 * W + px; y < cY; y++, o += W) {
            if (_fb[o] === 0) { _fb[o] = top; _zb[o] = v }
          }
          cY = yT
        }
        _cy[px] = cY
      }
    }
  }

  // whatever the ground left empty: sky above the horizon, haze below it
  function drawSky() {
    if (vC === 0 && vK === 0) return
    const _fb = fb
    const q = vQ
    const horizon = q > 1e-7 ? vCy - (vS * vTan) / q : -1e9
    const hz = horizon > H ? H : Math.floor(horizon)
    const focal = q > 1e-7 ? vS / q : 1e9
    const tod = p.timeOfDay
    // sun or moon, low over the horizon, opposite the shadows
    if (hz > 0 && tod !== 'day') {
      const sl = Math.sqrt(sunX * sunX + sunY * sunY) || 1
      const dx = -sunX / sl
      const dy = -sunY / sl
      const du = dx * vCos - dy * vSin
      const dv = -(dx * vSin + dy * vCos)
      if (dv > 0.2) {
        const rad = tod === 'sunset' ? W * 0.05 : W * 0.022
        const cxs = vCx + (focal * du) / dv
        const cys = horizon - (focal * (tod === 'sunset' ? 0.12 : 0.3)) / dv
        const reach = rad * 1.9
        const xa = Math.max(0, Math.floor(cxs - reach))
        const xb = Math.min(W - 1, Math.ceil(cxs + reach))
        const ya = Math.max(0, Math.floor(cys - reach))
        const yb = Math.min(hz - 1, Math.ceil(cys + reach))
        for (let y = ya; y <= yb; y++) {
          for (let x = xa; x <= xb; x++) {
            const o = y * W + x
            if (_fb[o] !== 0) continue
            const d = Math.sqrt((x - cxs) * (x - cxs) + (y - cys) * (y - cys)) / rad
            if (d < 1) _fb[o] = sunCol
            else if (d < 1.9 && (1.9 - d) * 14 > BAYER[((y & 3) << 2) | (x & 3)]) _fb[o] = sunGlow
          }
        }
      }
    }
    const span = frameH * 0.75
    const starOff = ((vYaw * focal) | 0) & 4095
    const stars = tod === 'night'
    for (let y = rowLo; y < rowHi; y++) {
      let o = y * W
      o += colLo
      if (y < hz) {
        const t = ((hz - y) / span) * (NSKY - 1)
        for (let x = colLo; x < colHi; x++, o++) {
          if (_fb[o] !== 0) continue
          let b = t | 0
          const edge = (t - b - 0.7) * 3.4
          if (edge > 0 && edge * 16 > BAYER[((y & 3) << 2) | (x & 3)]) b++
          if (b >= NSKY) b = NSKY - 1
          _fb[o] = stars && b > 1 && hash8(((x + starOff) & 4095) * 73 + y * 9973) < 2 ? sunCol : skyPal[b]
        }
      } else {
        for (let x = colLo; x < colHi; x++, o++) if (_fb[o] === 0) _fb[o] = hazeCol
      }
    }
  }

  function drawTrails() {
    if (!p.trails) return
    const LIFE = 2.6
    const _fb = fb
    const _zb = zbuf
    for (const j of jets) {
      if (j === jets[0] && jetFade < 0.5) continue
      const g = j.g
      for (let w = 0; w < 2; w++) {
        const tr = j.trail[w]
        let prevX = 0
        let prevY = 0
        let has = false
        for (let n = 0; n < j.trailLen; n++) {
          const o = ((j.trailHead - 1 - n + TRAIL_N * 2) % TRAIL_N) * 4
          const age = (time - tr[o + 3]) / (LIFE * (0.3 + 0.7 * g))
          if (age >= 1) break
          if (!project(tr[o], tr[o + 1], tr[o + 2])) { has = false; continue }
          const sxp = prX
          const syp = prY
          if (has) {
            // short line from the previous point, thicker when it is close to the camera
            const span = Math.max(Math.abs(sxp - prevX), Math.abs(syp - prevY))
            if (span < 600) {
              const steps = Math.max(1, Math.ceil(span))
              const alpha = age < 0.5 ? 1 : (1 - age) * 2
              const col = age < 0.25 ? trailPal[0] : age < 0.6 ? trailPal[1] : trailPal[2]
              const thick = prM > 2.4 ? 2 : 1
              for (let k = 0; k < steps; k++) {
                const x0 = Math.round(prevX + ((sxp - prevX) * k) / steps)
                const y0 = Math.round(prevY + ((syp - prevY) * k) / steps)
                for (let yy = y0; yy < y0 + thick; yy++) {
                  for (let xx = x0; xx < x0 + thick; xx++) {
                    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
                    if (_zb[yy * W + xx] < prV - 1) continue // behind a hill or a cloud
                    if (alpha * 16 > BAYER[((yy & 3) << 2) | (xx & 3)]) _fb[yy * W + xx] = col
                  }
                }
              }
            }
          }
          prevX = sxp
          prevY = syp
          has = true
        }
      }
    }
  }

  // dark exhaust smoke: soft round puffs that swell, pale and thin out as they hang in the air
  function drawSmoke() {
    const _fb = fb
    const _zb = zbuf
    const night = p.timeOfDay === 'night' ? 0.55 : 1
    for (let i = 0; i < SMOKE_N; i++) {
      const o = i * SMOKE_F
      const life = smoke[o + 8]
      if (life <= 0) continue
      const age = time - smoke[o + 3]
      if (age < 0 || age >= life) continue
      const u = age / life
      // the exhaust shoves it backwards at first; then it just hangs and rises a little
      const push = (1 - Math.exp(-age * 5)) / 5
      if (!project(smoke[o] + smoke[o + 5] * push, smoke[o + 1] + smoke[o + 6] * push, smoke[o + 2] + age * 2.5)) continue
      const rad = Math.max(0.8, smoke[o + 4] * (1 + 2.4 * u) * prM)
      if (rad > 60) continue
      const alpha = smoke[o + 7] * (1 - u) * (1 - u) * (u < 0.08 ? u / 0.08 : 1) * night
      const shade = 26 + 70 * u
      const cr = shade
      const cg = shade + 1
      const cb = shade + 7
      const x0 = Math.max(0, Math.floor(prX - rad))
      const x1 = Math.min(W - 1, Math.ceil(prX + rad))
      const y0 = Math.max(0, Math.floor(prY - rad))
      const y1 = Math.min(H - 1, Math.ceil(prY + rad))
      const inv = 1 / (rad * rad)
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d2 = ((x - prX) * (x - prX) + (y - prY) * (y - prY)) * inv
          if (d2 > 1) continue
          const at = y * W + x
          if (_zb[at] < prV - 1) continue
          const k = (alpha * (1 - d2 * 0.7) * 256) | 0
          const bg = _fb[at]
          const r = ((bg & 255) * (256 - k) + cr * k) >> 8
          const g = (((bg >> 8) & 255) * (256 - k) + cg * k) >> 8
          const b = (((bg >> 16) & 255) * (256 - k) + cb * k) >> 8
          _fb[at] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
        }
      }
    }
  }

  function drawJet(j: Jet, index: number) {
    const c = vCos
    const s = vSin
    const q = vQ
    const S = vS
    const tn = vTan
    const ax = axes(j)
    const sc = jetSize()
    // the jet's own axes in view space, per voxel: across the screen (U), into it (V), up (W)
    const rU = (ax.rx * c - ax.ry * s) * sc
    const rV = -(ax.rx * s + ax.ry * c) * sc
    const rW = ax.rz * sc
    const fU = (ax.fx * c - ax.fy * s) * sc
    const fV = -(ax.fx * s + ax.fy * c) * sc
    const fW = ax.fz * sc
    const uU = (ax.ux * c - ax.uy * s) * sc
    const uV = -(ax.ux * s + ax.uy * c) * sc
    const uW = ax.uz * sc
    const dx = j.x - cam.x
    const dy = j.y - cam.y
    const cU = dx * c - dy * s
    const cV = -(dx * s + dy * c)
    const cW = j.z - cam.alt
    // going into the cockpit, the camera moves into the leader, which fades away
    const fade = index === 0 ? jetFade : 1
    if (fade < 0.004) return
    const fading = fade < 1
    const _bg = backdrop
    const den0 = 1 + q * cV
    if (den0 < 0.2) return
    const m0 = S / den0
    const cx = vCx + m0 * cU
    const cy = vCy - m0 * (cW + tn * cV)
    const far = JET_L * sc * m0 + 40
    if (cx < -far || cy < -far - H || cx > W + far || cy > H + far) return
    // screen steps for one voxel along the wing and along the fuselage, at the jet's centre
    const prx = m0 * rU
    const pry = -m0 * (rW + tn * rV)
    const pfx = m0 * fU
    const pfy = -m0 * (fW + tn * fV)
    const _fb = fb
    const _mk = jetMask
    const _zb = zbuf
    // light: which way each half of the jet faces the sun
    const lx = -sunX
    const ly = -sunY
    const lz = 1.1
    const ll = Math.sqrt(lx * lx + ly * ly + lz * lz)
    const night = p.timeOfDay === 'night'
    const litAt = night ? 0.74 : 0.9
    const dimAt = night ? 0.4 : 0.66
    const lit = (side: number) => {
      const nx = ax.ux + side * 0.4 * ax.rx
      const ny = ax.uy + side * 0.4 * ax.ry
      const nz2 = ax.uz + side * 0.4 * ax.rz
      const b = (nx * lx + ny * ly + nz2 * lz) / (ll * Math.sqrt(nx * nx + ny * ny + nz2 * nz2))
      return b > litAt ? jetPalLit : b < dimAt ? jetPalDim : jetPal
    }
    const palL = lit(-1)
    const palR = lit(1)
    let x0 = W
    let y0 = H
    let x1 = -1
    let y1 = -1
    // several samples per voxel, more the larger it is drawn, so a turned slice has no pin-holes
    const big = (sc * S) / Math.max(0.2, den0 - q * JET_L * 0.6 * sc)
    const ns = clamp(Math.ceil(big * 2 - 0.24), 2, 8)
    for (let i = 0; i < ns; i++) {
      for (let k = 0; k < ns; k++) {
        const oi = (i + 0.5) / ns - 0.5
        const ok = (k + 0.5) / ns - 0.5
        offX[i * ns + k] = oi * prx + ok * pfx
        offY[i * ns + k] = oi * pry + ok * pfy
      }
    }
    const nOff = ns * ns
    // slices are drawn from the one farthest from eye level to the nearest, so nearer ones cover
    let eye: number
    if (q < 1e-6) eye = tn * uW - uV >= 0 ? 1e9 : -1e9
    else eye = (-cU * uU + (-1 / q - cV) * uV + (tn / q - cW) * uW) / (sc * sc)
    for (let y = 0; y < JET_H; y++) {
      sliceOrder[y] = y
      sliceKey[y] = Math.abs((y - PIV_Y) * spreadNow - eye)
    }
    for (let i = 1; i < JET_H; i++) {
      const y = sliceOrder[i]
      const key = sliceKey[y]
      let k = i - 1
      while (k >= 0 && sliceKey[sliceOrder[k]] < key) { sliceOrder[k + 1] = sliceOrder[k]; k-- }
      sliceOrder[k + 1] = y
    }
    const it = introT - index * 0.25
    const flameOn = burn > 0.02 && p.afterburner > 0.01 && spreadNow < 2.6
    const flick = 0.82 + 0.18 * Math.sin(time * 47 + index * 2) * Math.sin(time * 31)
    const flameLen = flameLength() * flick
    const flameWide = 1.15 * (1 + 0.22 * boost)
    const behind = vC + vK > 0.5 // seen from behind, the flames sit in front of the whole tail
    const bend = flameBend()
    const arch = climbTilt * 0.35
    const smooth = p.flameStyle === 'realistic'
    const dropOf = (y: number) => {
      // the intro: slices fall in from the top one after another and land on the stack
      if (it >= 2) return 0
      const tt = (it - (y - firstSlice) * 0.07) / 0.36
      if (tt <= 0) return NaN
      return tt < 1 ? -(1 - tt * tt) * ((H >> 1) + 44) : 0
    }
    // afterburner, sliced the same way so it stacks with the jet
    const flames = (y: number, bU: number, bV: number, bW: number, drop: number) => {
      const dyv = (y + 0.5 - ENGINE_Y) / (ENGINE_R * 1.25)
      if (dyv <= -1 || dyv >= 1 || flameLen <= 0.5) return
      const prof = Math.sqrt(1 - dyv * dyv)
      for (let e = -1; e <= 1; e += 2) {
        for (let t = 0; t < flameLen; t += 0.5) {
          const u = t / flameLen
          const rad = ENGINE_R * flameWide * Math.pow(1 - u, 0.75) * prof * (0.9 + 0.2 * Math.sin(t * 1.9 - time * 40 + e))
          if (rad < 0.2) continue
          const b = PIV_K - NOZZLE_K - t
          // the plume trails round the inside of a turn, and along the arc of a climb or dive
          const curl = (t * t) / flameLen
          const swing = bend * curl
          const lift = arch * curl
          for (let a = -rad; a <= rad; a += 0.5) {
            const aa = e * ENGINE_A + a + swing
            const V = bV + aa * rV + b * fV + lift * uV
            const den = 1 + q * V
            if (den < 0.2) continue
            const m = S / den
            const heat = u * 0.9 + (Math.abs(a) / (rad + 0.01)) * 0.55 + Math.abs(dyv) * 0.3 - 0.16 * boost
            const col = flamePal[heat < 0.28 ? 0 : heat < 0.5 ? 1 : heat < 0.75 ? 2 : heat < 1.0 ? 3 : heat < 1.25 ? 4 : 5]
            const fx = Math.round(vCx + m * (bU + aa * rU + b * fU + lift * uU))
            const fy = Math.round(vCy - m * (bW + aa * rW + b * fW + lift * uW + tn * V) + drop)
            const size = Math.max(1, Math.ceil(m * sc * 0.55))
            for (let yy = fy; yy < fy + size; yy++) {
              for (let xx = fx; xx < fx + size; xx++) {
                if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
                const at = yy * W + xx
                if (_zb[at] < V - 1) continue
                if (fading && _mk[at] === 0) _bg[at] = _fb[at]
                _fb[at] = col
                _mk[at] = 2 // flame: never outlined
              }
            }
            if (fx < x0) x0 = fx
            if (fx + size > x1) x1 = fx + size
            if (fy < y0) y0 = fy
            if (fy + size > y1) y1 = fy + size
          }
        }
      }
    }
    // a smooth flame is only measured here: where its nozzle, a point straight behind it and its
    // tip (which swings out in a turn) fall in the frame, and how much of it the world hides
    const smoothFlames = () => {
      // (the fire flickers by itself, so its length is held much steadier than the pixel flames')
      const L = flameLength() * (0.94 + 0.3 * (flick - 0.82)) * FLAME_GROW
      const wide = ENGINE_R * (1 + 0.12 * boost) * 1.5
      const show = fade * (1 - cockpitIn())
      if (L <= 0.6 || show < 0.01) return
      const hgt = (ENGINE_Y - 0.5 - PIV_Y) * spreadNow
      const bU = cU + hgt * uU
      const bV = cV + hgt * uV
      const bW = cW + hgt * uW
      for (let e = -1; e <= 1; e += 2) {
        if (flameOut.count >= FLAME_MAX) return
        const o = flameOut.count * FLAME_F
        let inView = true
        let mA = 0
        let mC = 0
        for (let n = 0; n < 3; n++) {
          const curl = n === 2 ? L : 0
          const aa = e * ENGINE_A + bend * curl
          const b = PIV_K - NOZZLE_K - n * 0.5 * L
          const lift = arch * curl
          const V = bV + aa * rV + b * fV + lift * uV
          const den = 1 + q * V
          if (den < 0.2) { inView = false; break }
          const m = S / den
          flameData[o + n * 2] = vCx + m * (bU + aa * rU + b * fU + lift * uU)
          flameData[o + n * 2 + 1] = vCy - m * (bW + aa * rW + b * fW + lift * uW + tn * V)
          flameV[n] = V
          if (n === 0) mA = m
          else if (n === 2) mC = m
        }
        if (!inView) continue
        const rad = wide * sc * mA
        const slot = (index * 2 + (e > 0 ? 1 : 0)) % FLAME_MAX
        for (let n = 0; n < 3; n++) {
          const mid = n === 1
          const px = mid ? 0.25 * flameData[o] + 0.5 * flameData[o + 2] + 0.25 * flameData[o + 4] : flameData[o + n * 2]
          const py = mid ? 0.25 * flameData[o + 1] + 0.5 * flameData[o + 3] + 0.25 * flameData[o + 5] : flameData[o + n * 2 + 1]
          const V = mid ? 0.25 * flameV[0] + 0.5 * flameV[1] + 0.25 * flameV[2] : flameV[n]
          let open = 0
          for (let k = 0; k < 5; k++) {
            const xx = Math.round(px + (k === 1 ? -rad : k === 2 ? rad : 0))
            const yy = Math.round(py + (k === 3 ? -rad : k === 4 ? rad : 0))
            if (xx < 0 || yy < 0 || xx >= W || yy >= H || _zb[yy * W + xx] >= V - 1) open++
          }
          // eased, so a flame slips behind a cloud rather than blinking out
          const at = slot * 3 + n
          flameSeen[at] += (open / 5 - flameSeen[at]) * 0.3
          flameData[o + 10 + n] = flameSeen[at]
        }
        flameData[o + 6] = rad
        flameData[o + 7] = mC / mA
        flameData[o + 8] = boost
        flameData[o + 9] = show
        flameData[o + 13] = slot
        flameData[o + 14] = clamp(p.afterburner, 0, 1)
        flameData[o + 15] = L / wide
        flameOut.count++
      }
    }
    for (let n = 0; n < JET_H; n++) {
      const y = sliceOrder[n]
      const cnt = sliceC[y].length
      if (cnt === 0) continue
      const drop = dropOf(y)
      if (drop !== drop) continue
      const hgt = (y - PIV_Y) * spreadNow
      const bU = cU + hgt * uU
      const bV = cV + hgt * uV
      const bW = cW + hgt * uW
      const A = sliceA[y]
      const B = sliceB[y]
      const C = sliceC[y]
      for (let v = 0; v < cnt; v++) {
        const a = A[v]
        const b = B[v]
        const V = bV + a * rV + b * fV
        const den = 1 + q * V
        if (den < 0.2) continue
        const m = S / den
        const col = a < 0 ? palL[C[v]] : palR[C[v]]
        const px = vCx + m * (bU + a * rU + b * fU)
        const py = vCy - m * (bW + a * rW + b * fW + tn * V) + drop
        const k = m / m0
        let x = 0
        let yy = 0
        for (let o = 0; o < nOff; o++) {
          x = Math.round(px + offX[o] * k)
          yy = Math.round(py + offY[o] * k)
          if (x < 0 || yy < 0 || x >= W || yy >= H) continue
          const at = yy * W + x
          if (_zb[at] < V - 1) continue // a hill or a cloud is in front
          if (fading && _mk[at] === 0) _bg[at] = _fb[at]
          _fb[at] = col
          _mk[at] = 1
        }
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (yy < y0) y0 = yy
        if (yy > y1) y1 = yy
      }
      if (flameOn && !smooth && !behind) flames(y, bU, bV, bW, drop)
    }
    if (flameOn && smooth) smoothFlames()
    if (flameOn && !smooth && behind) {
      for (let y = 0; y < JET_H; y++) {
        const drop = dropOf(y)
        if (drop !== drop) continue
        const hgt = (y - PIV_Y) * spreadNow
        flames(y, cU + hgt * uU, cV + hgt * uV, cW + hgt * uW, drop)
      }
    }
    // a dark 1 px outline around the whole stack, so it reads over any ground
    x0 = Math.max(1, x0 - 4)
    y0 = Math.max(1, y0 - 4)
    x1 = Math.min(W - 2, x1 + 4)
    y1 = Math.min(H - 2, y1 + 4)
    for (let yy = y0; yy <= y1; yy++) {
      let o = yy * W + x0
      for (let x = x0; x <= x1; x++, o++) {
        if (fading) {
          // let what was behind show through
          if (_mk[o] !== 0) {
            const bg = _bg[o]
            const fg = _fb[o]
            const k = (fade * 256) | 0
            const r = ((bg & 255) * (256 - k) + (fg & 255) * k) >> 8
            const g = (((bg >> 8) & 255) * (256 - k) + ((fg >> 8) & 255) * k) >> 8
            const b = (((bg >> 16) & 255) * (256 - k) + ((fg >> 16) & 255) * k) >> 8
            _fb[o] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
          }
        } else if (_mk[o] === 0 && ((_mk[o - 1] | _mk[o + 1] | _mk[o - W] | _mk[o + W]) & 1) === 1 && _zb[o] >= cV - 2) {
          _fb[o] = outlineCol
        }
      }
    }
    for (let yy = y0 - 1; yy <= y1 + 1; yy++) _mk.fill(0, yy * W + x0 - 1, yy * W + x1 + 2)
  }

  // ── the cockpit view
  //
  // The world is drawn on a larger square sheet and then turned, so the horizon tilts as the
  // jet banks. On top of that come the head-up display, the canopy frame and the instruments.

  /** turn the square sheet by the camera's roll into the frame */
  function turnSheet() {
    const c = Math.cos(vRoll)
    const s = Math.sin(vRoll)
    const half = sheetSide >> 1
    const cx = W >> 1
    const _fb = fb
    const _sh = sheet
    const side = sheetSide
    for (let y = 0; y < H; y++) {
      const dy = y - pivotY
      let sx = half - c * cx - s * dy + 0.5
      let sy = half - s * cx + c * dy + 0.5
      let o = y * W
      for (let x = 0; x < W; x++, o++, sx += c, sy += s) _fb[o] = _sh[(sy | 0) * side + (sx | 0)]
    }
  }

  // the cockpit's fixed metalwork is painted once per size and colour scheme
  function cockpitArt() {
    if (!cockpit || cockpit.W !== W || cockpit.H !== H) {
      const body: number[] = []
      const hot: number[] = []
      for (let t = 0; t < 9; t++) body.push(jetPal[1 + t])
      for (let t = 0; t < 6; t++) hot.push(jetPal[17 + t])
      cockpit = buildCockpit(W, H, { body, hot })
    }
    return cockpit
  }
  const radarLand = (right: number, ahead: number) => {
    const lead = jets[0]
    const sn = Math.sin(lead.yaw)
    const cs = Math.cos(lead.yaw)
    const m = matMap[((((lead.y + right * sn - ahead * cs) | 0) & NM) << NSHIFT) | (((lead.x + right * cs + ahead * sn) | 0) & NM)]
    return m >= 12 ? 3 : m >= 4 ? 2 : m >= 2 ? 1 : 0
  }
  const blips: number[] = []
  function drawCockpitView() {
    const lead = jets[0]
    // the panel and the hoop slide into place over the later part of the move
    const inPlace = cockpitIn()
    if (inPlace <= 0) return
    const h = clamp((vK - 0.72) / 0.28, 0, 1)
    const sn = Math.sin(lead.yaw)
    const cs = Math.cos(lead.yaw)
    blips.length = 0
    for (let i = 1; i < jets.length; i++) {
      const ex = jets[i].x - lead.x
      const ey = jets[i].y - lead.y
      blips.push(ex * cs + ey * sn, ex * sn - ey * cs)
    }
    // where the sun is from the seat: to one side or the other, ahead or behind
    const tod = p.timeOfDay
    const sl = Math.sqrt(sunX * sunX + sunY * sunY) || 1
    const sunFront = (-sunX * sn + sunY * cs) / sl
    const sunSide = (-sunX * cs - sunY * sn) / sl
    drawCockpit(fb, cockpitArt(), {
      time,
      inPlace,
      hud: h * h * (3 - 2 * h),
      roll: vRoll,
      pitch: lead.pitch,
      heading: lead.yaw,
      speed: speedNow,
      speedMax: p.speed * clamp(p.boost, 1, 4) * 1.08,
      alt: lead.z,
      altMax: Math.max(p.altitude, clamp(p.ceiling, 20, 900)),
      climb: clamp(climbTilt / 0.5, -1, 1),
      turn: clamp(lead.yawRate / Math.max(0.1, p.agility), -1, 1),
      boost,
      pivotY,
      horizonY: vCy,
      focal: vS / vQ,
      // the head sways with the flying, and shudders while the thrusters are open
      headX,
      headY: headY + (boost > 0.2 ? ((((time * 30) | 0) & 1) - 0.5) * 1.5 * boost : 0),
      // light pours over the pilot's shoulder with the sun behind; the hood shades the panel with it ahead
      sunSide,
      sunReach: 0.72 - 0.28 * sunFront,
      sunColor: tod === 'sunset' ? SUN_SUNSET : tod === 'night' ? SUN_NIGHT : SUN_DAY,
      sunPower: tod === 'sunset' ? 1.1 : tod === 'night' ? 0.45 : 1,
      land: radarLand,
      blips,
      jet: jetTop,
    })
  }

  function render() {
    if (W === 0) return bytes
    updateView()
    frameH = H
    flameOut.count = 0
    // in the cockpit the view rolls with the jet, so the world goes onto the square sheet first
    const rolled = vK > 0 || vRoll !== 0
    const w0 = W
    const h0 = H
    const f0 = fb
    const c0 = colY
    const m0 = jetMask
    const z0 = zbuf
    const b0 = backdrop
    const y0 = vCy
    if (rolled) {
      W = sheetSide
      H = sheetSide
      fb = sheet
      colY = sheetColY
      jetMask = sheetMask
      zbuf = sheetZ
      backdrop = sheetBackdrop
      const half = sheetSide >> 1
      vCx = half
      vCy = half + (y0 - pivotY)
      // only the part of the sheet the turned frame can see is drawn
      const c = Math.abs(Math.cos(vRoll))
      const s = Math.abs(Math.sin(vRoll))
      colLo = Math.max(0, half - Math.ceil(c * (w0 / 2) + s * Math.max(pivotY, h0 - pivotY)) - 2)
      colHi = Math.min(sheetSide, half + Math.ceil(c * (w0 / 2) + s * Math.max(pivotY, h0 - pivotY)) + 2)
      rowLo = Math.max(0, half - Math.ceil(c * pivotY + s * (w0 / 2)) - 2)
      rowHi = Math.min(sheetSide, half + Math.ceil(c * (h0 - pivotY) + s * (w0 / 2)) + 2)
    } else {
      colLo = 0
      colHi = W
      rowLo = 0
      rowHi = H
    }
    drawWorld()
    drawSky()
    drawTrails()
    drawSmoke()
    // far jets first
    const order = jets.map((j, i) => ({ i, d: (j.x - cam.x) * vSin + (j.y - cam.y) * vCos }))
    order.sort((a, b) => a.d - b.d)
    for (const e of order) drawJet(jets[e.i], e.i)
    if (rolled) {
      W = w0
      H = h0
      fb = f0
      colY = c0
      jetMask = m0
      zbuf = z0
      backdrop = b0
      vCx = W >> 1
      vCy = y0
      turnSheet()
      // the smooth flames were placed on the sheet: turn them with it
      const half = sheetSide >> 1
      const rc = Math.cos(vRoll)
      const rs = Math.sin(vRoll)
      for (let i = 0; i < flameOut.count; i++) {
        for (let n = 0; n < 3; n++) {
          const o = i * FLAME_F + n * 2
          const dx = flameData[o] - half
          const dy = flameData[o + 1] - half
          flameData[o] = (W >> 1) + rc * dx + rs * dy
          flameData[o + 1] = pivotY - rs * dx + rc * dy
        }
      }
      drawCockpitView()
    }
    return bytes
  }

  return {
    setParams,
    resize,
    pointerMove,
    pointerLeave,
    press,
    release,
    replayIntro,
    toggleView,
    /** a roll, as a click gives (for a game controller's button) */
    roll() { if (introT > 1.9) startRoll() },
    setKeys,
    step,
    render,
    get width() { return W },
    get height() { return H },
    /** the smooth flames to lay over this frame (none while the flames are drawn in pixels) */
    get flames() { return flameOut },
    /** the view the camera is in, or heading for */
    get view(): ViewMode { return viewTarget === 2 ? 'cockpit' : viewTarget === 1 ? 'chase' : 'top' },
  }
}

export type Scene = ReturnType<typeof createScene>
