// Makes the scene's sound effects (assets/sounds/*.mp3) with ElevenLabs' text-to-sound model.
// Not part of the running scene — run it by hand when a sound should change:
//
//   ELEVENLABS_API_KEY=… node tools/gen-sounds.mjs /tmp/sounds [name …]     (several takes of each)
//   … listen, then copy the takes you like to assets/sounds/<name>.mp3
//
// The key is read from the environment and never written anywhere. Loops are asked for as
// loops, and the scene cross-fades them as well, so no take needs trimming.
// A bed must hold one loudness all the way through (a take that swells or fades makes the loop
// seem to breathe): check each take's loudness over time before using it.
//
// The radio calls are spoken by ElevenLabs voices and then put through a radio with ffmpeg (a
// narrow band, squashed and a little broken up, over a bed of static): radio_<name>_<take>.mp3.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) { console.error('set ELEVENLABS_API_KEY'); process.exit(1); }
const outDir = process.argv[2];
if (!outDir) { console.error('usage: node tools/gen-sounds.mjs <out dir> [name …]'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const TAKES = +(process.env.TAKES || 2);

// name: [what to ask for, seconds, how closely to follow the words (0..1), loop]
const SOUNDS = {
  engine: ['Steady continuous roar of a fighter jet engine heard from just behind the aircraft in flight, smooth deep turbine rumble with an airy hiss, constant pitch and loudness, no doppler, no changes', 6, 0.6, true],
  afterburner: ['Constant roar of a jet afterburner already at full power from the very first instant, heard from close behind: a dense, even, unbroken wall of roaring thrust at one steady loudness all the way through, no build-up, no swell, no fade, no pulsing, no crackle', 6, 0.75, true],
  wind: ['Constant rush of air past the ears in free fall at high altitude: an even, unbroken airy roar at one steady loudness from the first instant to the last, no gusts, no swells, no fades, no whistling', 6, 0.75, true],
  alarm: ['Aircraft cockpit master caution warning alarm, urgent repeating two-tone electronic beeps, dry and close, steady rhythm', 2, 0.7, true],
  roll: ['A fighter jet snapping through a fast barrel roll, a quick tearing whoosh of air swishing past, short', 1.6, 0.55, false],
  eject: ['Fighter jet ejection seat firing: a sharp explosive bang, then a short rocket whoosh shooting upward and fading, powerful and dry', 2.5, 0.6, false],
  explosion: ['A jet aircraft crashing into the ground and exploding, a deep heavy boom with a fiery roar and scattering debris, long rumbling tail', 4.5, 0.6, false],
  splash: ['A jet aircraft crashing into the sea, a heavy explosion muffled by an enormous water splash, then spray raining down on the water', 4.5, 0.6, false],
  chute: ['A parachute opening in mid air: fabric unfurling fast, a loud snap and a deep whump as it fills, then soft flapping', 2.5, 0.6, false],
  flyby: ['A fighter jet approaching fast from far behind and arriving close, a rising roar swelling into a heavy whoosh', 3.5, 0.55, false],
  seat: ['A pilot dropping into a padded cockpit seat: a soft heavy thud, then harness buckles clicking shut', 1.2, 0.6, false],
  canopy: ['A fighter jet canopy closing: a short electric motor whir, a heavy mechanical clunk as it locks, then a pressurised seal hiss', 2, 0.6, false],
  kick: ['A jet afterburner igniting with a deep boom and a roaring surge of thrust as the aircraft accelerates away', 3, 0.6, false],
  swish: ['A very short soft airy whoosh, a subtle quick camera move, clean and light', 0.7, 0.5, false],
  gun: ["Continuous burst of a fighter jet's rotary cannon firing without a break: a fast, even, heavy brrrrrt of rapid gunfire at one steady loudness from the first instant to the last, close and dry, no pauses, no echo, no tail", 3, 0.75, true],
  gunheavy: ["Heavy 30 millimetre aircraft autocannon firing a continuous burst, heard from the cockpit: deep, thumping, chest-shaking rapid fire with a hard metallic crack on every round and a lot of low end, one steady loudness from the first instant to the last, no pauses, no fade", 3, 0.75, true],
  guntail: ['The last two rounds of a heavy aircraft cannon burst, then its deep echo rolling away across open sky and the barrels spinning down', 1.6, 0.65, false],
  missile: ['An air-to-air missile launching from a fighter jet: a sharp ignition crack, then a fierce rocket whoosh streaking away into the distance and fading', 2.5, 0.65, false],
  blast: ['A missile warhead exploding in the middle distance: a sharp heavy blast with a short deep rumble rolling away, no debris, no voices', 3, 0.65, false],
  hit: ['Cannon rounds striking the metal skin of an aircraft from inside the cockpit: two or three sharp heavy metallic impacts in quick succession, a rattle, close and dry, no voices', 1, 0.7, false],
  empty: ['An aircraft cannon running out of ammunition: two dry metallic clicks of an empty breech and the electric feed motor spinning down, close and dry, no gunshots', 1, 0.7, false],
  reload: ['A heavy aircraft cannon being reloaded: an ammunition belt ratcheting in fast, then one solid heavy metallic clunk as the breech locks shut, close and dry, no gunshots, no voices', 1.5, 0.7, false],
  cloud: ['Flying fast through a cloud: a short soft muffled whoosh of thick damp air rushing past, a brief airy swell that fades, no engine, no voices', 1.5, 0.6, false],
  slowmo: ['Cinematic bullet-time slow motion effect: a deep bass drop and a low stretched whoosh as time slows right down, held for a moment, then a rising reverse swell as time snaps back to speed', 1.8, 0.7, false],
  wake: ['Water spray hissing and rushing as something skims fast just above the sea, a continuous sheet of spray and foam, steady, close, no engine, no voices', 5, 0.6, true],
};

// the radio: name: [voice id, what is said]
const RESCUE = 'nPczCjzI2devNBz1zQrb'; // the pilot of the jet coming in: deep and calm
const TOWER = 'pNInz6obpgDQGcFmaJgB'; // control: firm
const RADIO = {
  in1: [RESCUE, 'Got eyes on your chute. Coming in under you.'],
  in2: [RESCUE, "Hang tight, I've got you. Coming in low."],
  in3: [RESCUE, 'Rescue inbound. Hold on, almost there.'],
  out1: [TOWER, 'Good catch. Welcome back.'],
  out2: [RESCUE, "Pilot's aboard. Canopy coming down."],
  out3: [TOWER, "He's in. Nice flying."],
};

async function make(name, k) {
  const [text, seconds, influence, loop] = SOUNDS[name];
  const file = path.join(outDir, `${name}_${k}.mp3`);
  if (fs.existsSync(file)) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text, duration_seconds: seconds, prompt_influence: influence, loop, model_id: 'eleven_text_to_sound_v2' }),
    });
    if (res.ok) {
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      console.log('made', name, k);
      return;
    }
    const msg = (await res.text()).slice(0, 200);
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 8000 + attempt * 5000)); continue; }
    console.log('failed', name, k, res.status, msg);
    return;
  }
  console.log('gave up', name, k);
}

async function say(name, k) {
  const [voice, text] = RADIO[name];
  const dry = path.join(outDir, `radio_${name}_${k}_dry.mp3`);
  const file = path.join(outDir, `radio_${name}_${k}.mp3`);
  if (fs.existsSync(file)) return;
  if (!fs.existsSync(dry)) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, speed: 1.08 } }),
    });
    if (!res.ok) { console.log('failed', name, k, res.status, (await res.text()).slice(0, 200)); return; }
    fs.writeFileSync(dry, Buffer.from(await res.arrayBuffer()));
  }
  // through the radio: a narrow band, squashed hard, clipped a little, static under it, the key let go at the end
  const long = +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dry]).toString() + 0.34;
  const filter = [
    '[0:a]highpass=f=480,lowpass=f=2700,acompressor=threshold=-24dB:ratio=8:attack=3:release=80:makeup=8,asoftclip=type=hard:threshold=0.45,volume=1.6,adelay=140|140,apad=pad_dur=0.2[v]',
    `anoisesrc=d=${long.toFixed(2)}:c=pink:a=0.5,highpass=f=900,lowpass=f=3600,volume=0.085[n]`,
    `[v][n]amix=inputs=2:duration=shortest:normalize=0,afade=t=in:d=0.02,afade=t=out:st=${(long - 0.05).toFixed(2)}:d=0.05[o]`,
  ].join(';');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', dry, '-filter_complex', filter, '-map', '[o]', '-ar', '44100', '-ac', '1', '-b:a', '80k', file]);
  console.log('said', name, k);
}

const asked = process.argv.slice(3);
const names = asked.length ? asked.filter((n) => SOUNDS[n]) : Object.keys(SOUNDS);
const jobs = names.flatMap((n) => Array.from({ length: TAKES }, (_, k) => [n, k]));
// three at a time
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => { while (next < jobs.length) { const [n, k] = jobs[next++]; await make(n, k); } }));
const calls = asked.length ? asked.filter((n) => RADIO[n]) : Object.keys(RADIO);
for (const n of calls) for (let k = 0; k < Math.min(TAKES, 2); k++) await say(n, k);
console.log('done', jobs.length, 'sounds,', calls.length, 'radio calls');
