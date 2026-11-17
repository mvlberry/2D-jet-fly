// evens out the loudness of a recording over time (a slow gain that undoes its swells), for a bed that must not breathe
//   node flatten.mjs in.mp3 out.mp3
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
const [src, dst] = process.argv.slice(2)
const sr = 44100
const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', src, '-ac', '2', '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 2e8 })
const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)
const n = x.length / 2
// loudness in a window of 0.6 s round each sample (circular: it is a loop), by a running sum
const win = Math.round(sr * 0.6), half = win >> 1
const p = new Float64Array(n)
for (let i = 0; i < n; i++) p[i] = (x[i * 2] ** 2 + x[i * 2 + 1] ** 2) / 2
let sum = 0
for (let k = -half; k < half; k++) sum += p[(k + n) % n]
const env = new Float64Array(n)
for (let i = 0; i < n; i++) { env[i] = Math.sqrt(sum / win); sum += p[(i + half) % n] - p[(i - half + n) % n] }
const mean = Math.exp(env.reduce((a, v) => a + Math.log(v + 1e-9), 0) / n)
const out = new Float32Array(x.length)
for (let i = 0; i < n; i++) { const g = Math.min(4, Math.max(0.25, mean / (env[i] + 1e-9))); out[i * 2] = x[i * 2] * g; out[i * 2 + 1] = x[i * 2 + 1] * g }
fs.writeFileSync(dst + '.f32', Buffer.from(out.buffer))
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', dst + '.f32', '-af', 'loudnorm=I=-18:TP=-2:LRA=5', '-ar', String(sr), '-b:a', '112k', dst])
fs.unlinkSync(dst + '.f32')
