// Flies the whole tutorial without a browser and prints how long each step took, to check that every
// step can still be done and is ticked off:   bun tools/test-tutorial.ts
import { createScene, DEFAULT_PARAMS } from '../src/lib/eject/scene'
import { createTutorial, lessonWords } from '../src/lib/eject/tutorial'
import type { Lesson } from '../src/lib/eject/tutorial'
const params = { ...DEFAULT_PARAMS, altitude: 110, ceiling: 1500, jetScale: 0.6, intro: false, view: 'chase', enemies: 3, foeFire: true, slowMo: 1.3, crash: true, weapons: true, invertY: true } as typeof DEFAULT_PARAMS
const scene = createScene(params)
scene.resize(480, 300)
let lesson: Lesson | null = null
const chimes: number[] = []
const tut = createTutorial(scene, { change: (l) => { lesson = l }, chime: (n) => chimes.push(n) })
let t = 0
const step = (n = 1) => { for (let i = 0; i < n; i++) { scene.step(1 / 60); tut.tick(1 / 60); scene.takeSounds(); t += 1 / 60 } }
step(120) // some ordinary flying first: three enemies about
console.log('before: foes', scene.radar.foes.length)
tut.setFlyer('pointer')
tut.start({ armed: true, crash: true })
console.log('started: foes', scene.radar.foes.length, 'steps', lesson!.count)
const hints = new Set<string>()
let guard = 0
while (tut.on && guard++ < 60 * 400) {
  const l = lesson!
  const d = scene.did
  if (l.hint) hints.add(l.id + ': ' + l.hint)
  if (l.phase !== 'do') { scene.setKeys(0, 0, false); scene.setFire(false); step(); continue }
  const t0 = t
  const id = l.id
  const idx = l.index
  let n = 0
  let fired = false
  let lowest = 1e9
  while (tut.on && lesson!.index === idx && lesson!.phase === 'do' && n++ < 60 * 60) {
    const d = scene.did
    lowest = Math.min(lowest, d.height)
    if (lesson!.hint) hints.add(id + ': ' + lesson!.hint)
    switch (id) {
      case 'turn': scene.setKeys(1, 0, false); break
      case 'climb': scene.setKeys(0, -1, false); break
      case 'dive': scene.setKeys(0, d.height > 60 ? 1 : 0, false); break
      case 'thrust': scene.setKeys(0, 0, true); break
      case 'view': if (n === 30) scene.toggleView(); break
      case 'roll': if (n === 30) scene.roll(); break
      case 'backflip': scene.setKeys(0, -1, true); break
      case 'frontflip': if (d.height < 260 && !fired) scene.setKeys(0, -1, false); else { fired = true; scene.setKeys(0, 1, true) } break
      case 'cannon': scene.setFire(true); break
      case 'lock': break
      case 'missile': if (d.lock >= 1 && n % 30 === 0) scene.missile(); break
      case 'dodge': if (d.threat < 0.4 && d.threat > 0.05) scene.roll(); break
      case 'counter': if (d.threat < 0.4 && d.threat > 0.05) scene.roll(); if (d.counterOpen) scene.missile(); break
      case 'eject': scene.setKeys(0, d.out ? 0 : 1, false); break
    }
    step()
  }
  scene.setKeys(0, 0, false); scene.setFire(false)
  const w = lessonWords(id, 'pointer', true, scene.view)
  console.log(String(idx + 1).padStart(2), id.padEnd(10), (t - t0).toFixed(1).padStart(5) + ' s', '| foes', scene.radar.foes.length, '| lowest', lowest.toFixed(0), '| kills', scene.kills, 'hull', scene.hull, '|', lesson ? lesson.phase : 'closed', '|', w.title, '—', w.how)
}
console.log('finished at', t.toFixed(1), 's; running:', tut.on, '| foes back:', scene.radar.foes.length, '| chimes', chimes.join(''))
console.log([...hints].join('\n'))
