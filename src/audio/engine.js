// Web Audio のシンセとステップ単位のスケジューラ（音声ファイルは使わない）

const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }
export function noteFreq(name) {
  const m = /^([A-G]#?)(-?\d)$/.exec(name)
  if (!m) return 220
  const midi = (Number(m[2]) + 1) * 12 + NOTE[m[1]]
  return 440 * Math.pow(2, (midi - 69) / 12)
}

export class AudioEngine {
  constructor(config) {
    this.config = config
    this.ctx = null
    this.timer = null
  }

  get stepDur() {
    return 60 / this.config.bpm / this.config.stepsPerBeat
  }
  get barDur() {
    return this.stepDur * this.config.steps
  }
  get now() {
    return this.ctx ? this.ctx.currentTime : 0
  }

  async init() {
    // resume() が返ってこない環境でも止まらないよう待ち時間に上限をつける
    const resume = () => Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 400))])
    if (this.ctx) {
      if (this.ctx.state !== 'running') await resume()
      return
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    this.ctx = ctx
    const a = this.config.audio
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.ratio.value = 4
    comp.attack.value = 0.003
    comp.release.value = 0.15
    this.master = ctx.createGain()
    this.master.gain.value = a.masterGain
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.smoothingTimeConstant = 0.78
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount)
    this.master.connect(comp)
    comp.connect(this.analyser)
    this.analyser.connect(ctx.destination)

    // 持ち越し敵用のディストーションバス（元の音色がわかる程度に）
    this.dist = ctx.createWaveShaper()
    this.dist.curve = distortionCurve(a.distortion)
    this.dist.oversample = '4x'
    const distTone = ctx.createBiquadFilter()
    distTone.type = 'lowpass'
    distTone.frequency.value = 5200
    const distGain = ctx.createGain()
    distGain.gain.value = a.carriedGain
    this.dist.connect(distTone)
    distTone.connect(distGain)
    distGain.connect(this.master)

    this.backing = ctx.createGain()
    this.backing.gain.value = a.backingGain
    this.backing.connect(this.master)

    // ホワイトノイズ 1秒
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    this.noise = buf
    if (ctx.state !== 'running') await resume()
  }

  // ---- スケジューラ: onStep(globalStep, time) をステップごとに先読みで呼ぶ
  start(onStep) {
    this.stop()
    this.onStep = onStep
    this.step = 0
    this.nextTime = this.ctx.currentTime + 0.15
    const lookahead = 0.12
    this.timer = setInterval(() => {
      // タブが裏に回るなどで遅れたら、詰めずに今から再開する
      if (this.nextTime < this.ctx.currentTime - 0.05) this.nextTime = this.ctx.currentTime + 0.05
      while (this.nextTime < this.ctx.currentTime + lookahead) {
        this.onStep(this.step, this.nextTime)
        this.nextTime += this.stepDur
        this.step++
      }
    }, 20)
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  levels() {
    if (!this.analyser) return null
    this.analyser.getByteFrequencyData(this.freqData)
    return this.freqData
  }

  // ---- 共通
  env(t, peak, decay, dest, attack = 0.001) {
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    g.connect(dest)
    return g
  }
  noiseSrc(t, dur) {
    const s = this.ctx.createBufferSource()
    s.buffer = this.noise
    s.start(t, Math.random() * 0.5)
    s.stop(t + dur)
    return s
  }
  osc(type, freq, t, dur) {
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    o.start(t)
    o.stop(t + dur)
    return o
  }

  // トラックの音色を鳴らす。distort = 持ち越し敵
  playTrack(track, t, { gain = 1, distort = false } = {}) {
    const p = track.sound
    const dest = distort ? this.dist : this.master
    const g = p.gain * gain
    const fn = this[p.synth]
    if (fn) fn.call(this, t, p, g, dest)
  }

  kick(t, p, g, dest) {
    const out = this.env(t, g, p.decay, dest)
    const o = this.osc('sine', p.pitchStart, t, p.decay + 0.05)
    o.frequency.exponentialRampToValueAtTime(p.pitchEnd, t + 0.11)
    o.connect(out)
    const click = this.env(t, g * 0.35, 0.012, dest)
    const hp = this.ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 2500
    this.noiseSrc(t, 0.02).connect(hp)
    hp.connect(click)
  }

  snare(t, p, g, dest) {
    const n = this.env(t, g, p.decay, dest)
    const bp = this.ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1900
    bp.Q.value = 0.7
    this.noiseSrc(t, p.decay + 0.05).connect(bp)
    bp.connect(n)
    const body = this.env(t, g * 0.6, 0.09, dest)
    const o = this.osc('triangle', p.tone, t, 0.12)
    o.frequency.exponentialRampToValueAtTime(p.tone * 0.65, t + 0.08)
    o.connect(body)
  }

  hat(t, p, g, dest) {
    const n = this.env(t, g, p.decay, dest)
    const hp = this.ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 7200
    this.noiseSrc(t, p.decay + 0.03).connect(hp)
    hp.connect(n)
  }

  cowbell(t, p, g, dest) {
    const out = this.env(t, g, p.decay, dest, 0.002)
    const bp = this.ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1400
    bp.Q.value = 1.2
    bp.connect(out)
    for (const f of [p.freqA, p.freqB]) this.osc('square', f, t, p.decay + 0.05).connect(bp)
  }

  tick(t, accent = false) {
    const g = this.config.audio.metronomeGain * (accent ? 1.4 : 1)
    const out = this.env(t, g, 0.035, this.master)
    this.osc('sine', accent ? 2093 : 1568, t, 0.05).connect(out)
  }

  // カウント用の声っぽいビープ
  countBeep(t, n) {
    const out = this.env(t, 0.22, 0.14, this.master, 0.004)
    const o = this.osc('square', n === 0 ? 880 : 660, t, 0.18)
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 2400
    o.connect(lp)
    lp.connect(out)
  }

  bass(t, freq, dur) {
    const out = this.env(t, 0.5, dur, this.backing, 0.005)
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 6
    lp.frequency.setValueAtTime(900, t)
    lp.frequency.exponentialRampToValueAtTime(140, t + dur)
    lp.connect(out)
    this.osc('sawtooth', freq, t, dur + 0.05).connect(lp)
    this.osc('square', freq / 2, t, dur + 0.05).connect(lp)
  }

  pad(t, notes, dur, level = 0.1) {
    const out = this.ctx.createGain()
    out.gain.setValueAtTime(0.0001, t)
    out.gain.exponentialRampToValueAtTime(level, t + dur * 0.3)
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1100
    lp.connect(out)
    out.connect(this.backing)
    for (const n of notes) {
      const f = noteFreq(n)
      for (const det of [-7, 7]) {
        const o = this.osc('sawtooth', f, t, dur + 0.05)
        o.detune.value = det
        o.connect(lp)
      }
    }
  }

  // 砲台のビーム音。perfect は明るく、good は鈍く
  zap(t, kind) {
    const perfect = kind === 'perfect'
    const out = this.env(t, perfect ? 0.16 : 0.09, perfect ? 0.12 : 0.08, this.master)
    const o = this.osc(perfect ? 'square' : 'triangle', perfect ? 2400 : 1100, t, 0.15)
    o.frequency.exponentialRampToValueAtTime(perfect ? 700 : 420, t + 0.1)
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = perfect ? 5000 : 2200
    o.connect(lp)
    lp.connect(out)
  }

  boom(t) {
    const out = this.env(t, 0.28, 0.32, this.master)
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(3500, t)
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.3)
    this.noiseSrc(t, 0.35).connect(lp)
    lp.connect(out)
    const sub = this.env(t, 0.3, 0.25, this.master)
    const o = this.osc('sine', 120, t, 0.3)
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25)
    o.connect(sub)
  }

  baseHit(t) {
    const out = this.env(t, 0.55, 0.7, this.dist)
    const o = this.osc('sawtooth', 70, t, 0.75)
    o.frequency.exponentialRampToValueAtTime(30, t + 0.6)
    o.connect(out)
    const n = this.env(t, 0.4, 0.5, this.master)
    this.noiseSrc(t, 0.55).connect(n)
    // 警告音
    for (let i = 0; i < 2; i++) {
      const a = this.env(t + 0.1 + i * 0.16, 0.12, 0.12, this.master, 0.005)
      this.osc('square', 440, t + 0.1 + i * 0.16, 0.14).connect(a)
    }
  }

  // 新トラック解放・クリアなどの上昇音
  riser(t, dur = 0.6) {
    const out = this.env(t, 0.12, dur, this.master, dur * 0.6)
    const o = this.osc('sawtooth', 300, t, dur + 0.1)
    o.frequency.exponentialRampToValueAtTime(1800, t + dur)
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 3000
    o.connect(lp)
    lp.connect(out)
  }

  chime(t, notes, gap = 0.09, level = 0.14) {
    notes.forEach((n, i) => {
      const out = this.env(t + i * gap, level, 0.5, this.master, 0.004)
      this.osc('triangle', noteFreq(n), t + i * gap, 0.6).connect(out)
    })
  }

  // UI のクリック音（今すぐ鳴らす）
  ui(kind) {
    if (!this.ctx) return
    const t = this.ctx.currentTime + 0.005
    const out = this.env(t, 0.08, 0.05, this.master)
    this.osc('sine', kind === 'error' ? 220 : kind === 'remove' ? 520 : 980, t, 0.07).connect(out)
  }
}

function distortionCurve(k) {
  const n = 2048
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x))
  }
  return curve
}
