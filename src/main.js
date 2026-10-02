import './styles.css'
import { content, t } from './content/index.js'
import { Session } from './game/session.js'
import { AudioEngine, noteFreq } from './audio/engine.js'
import { Stage } from './three/stage.js'
import { Hud } from './ui/hud.js'

const { config, song } = content
const trackById = Object.fromEntries(content.tracks.map((tr) => [tr.id, tr]))
const STEPS = config.steps
const SPB = config.stepsPerBeat

const stage = new Stage(document.querySelector('#scene'), content)
const audio = new AudioEngine(config)

let session = null
let hint = false
let events = [] // { time, fn } 音の時刻に合わせて描画側で実行する
let curBar = null // スケジュール済みの最新小節
let shownBar = null // いま鳴っている小節
let shownBarStart = 0
let songStart = 0
let barCount = 0
let lastTurn = -1
let shownBaseHp = 0
let playing = false

const at = (time, fn) => events.push({ time, fn })

const hud = new Hud(content, {
  start: (opts) => startGame(opts),
  quit: () => toTitle(),
  ready: () => pressReady(),
  uiSound: (k) => audio.ui(k),
})

// ---- 進行
async function startGame({ difficulty, hint: h, loop }) {
  await audio.init()
  audio.stop()
  session = new Session(content, { difficulty, loop })
  hint = h
  events = []
  curBar = shownBar = null
  barCount = 0
  lastTurn = -1
  shownBaseHp = session.baseHp
  stage.clearEnemies()
  stage.clearTurrets()
  stage.setUnlocked([])
  stage.setCoreHp(1)
  stage.setPlayhead(null)
  hud.showHud()
  hud.setBase(shownBaseHp, session.maxBaseHp)
  hud.setScore(0)
  hud.setReady('hidden')
  hud.setPhase('', '')
  hud.setTurrets(0, session.turretLimit, false)
  playing = true
  songStart = audio.now + 0.15
  audio.start(onStep)
  audio.chime(audio.now + 0.02, ['A4', 'C5', 'E5'], 0.07, 0.08)
}

function toTitle() {
  audio.stop()
  playing = false
  session = null
  events = []
  stage.setPlayhead(null)
  stage.setHover(null)
  stage.clearEnemies()
  stage.clearTurrets()
  stage.setUnlocked([])
  hud.showTitle()
}

function pressReady() {
  if (!session || !session.pressReady()) return
  audio.ui('select')
  hud.setReady('pressed')
}

// スケジューラから 1ステップごとに呼ばれる（音の時刻 time は少し未来）
function onStep(globalStep, time) {
  const s = globalStep % STEPS
  if (s === 0) {
    curBar = session.nextBar()
    scheduleBar(curBar, time)
    barCount++
  }
  if (curBar && playing) scheduleStep(curBar, s, time)
}

function chordFor(bar = barCount) {
  const chords = sectionOf().backing.chords
  return chords[bar % chords.length]
}
const sectionOf = () => song.sections[session.turn.sectionIndex]

function scheduleBar(bar, time) {
  if (bar.phase === 'clear' || bar.phase === 'gameover') {
    audio.stop()
    playing = false
    const kind = bar.phase
    if (kind === 'clear') audio.chime(time, ['A4', 'C5', 'E5', 'A5', 'E6'], 0.11, 0.16)
    else audio.chime(time, ['E4', 'C4', 'A3', 'E3'], 0.16, 0.14)
    at(time, () => {
      stage.setPlayhead(null)
      stage.setHover(null)
      hud.setScore(session.stats.score)
      hud.showEnd({
        kind,
        session,
        onRetry: () => startGame({ difficulty: session.difficulty.id, hint, loop: session.loop }),
        onLoop: () => startGame({ difficulty: session.difficulty.id, hint, loop: session.loop + 1 }),
        onTitle: () => toTitle(),
      })
    })
    return
  }

  // ターンの最初の小節: 持ち越し敵を（フレーズより前に）見せる、砲台を片付ける
  const newTurn = bar.turnIndex !== lastTurn
  lastTurn = bar.turnIndex
  const unlocked = [...session.unlocked]
  const turretLimit = session.turretLimit
  const enemies = bar.enemies
  if (newTurn) {
    at(time, () => {
      stage.clearTurrets()
      stage.setUnlocked(unlocked)
      stage.syncCarried(enemies)
      hud.setTurn(session)
      hud.setTurrets(0, turretLimit, false)
      if (enemies.some((e) => e.carried)) hud.toast(t('phase.carriedSub'))
    })
  }

  at(time, () => {
    shownBar = bar
    shownBarStart = time
    const { phase, i, n } = bar
    hud.setReady(phase === 'think' ? (session.ready ? 'pressed' : 'available') : 'hidden')
    hud.setTurrets(session.turrets.length, session.turretLimit, phase === 'think')
    if (phase === 'intro') {
      if (i === 0) {
        stage.setUnlocked(unlocked)
        for (const id of bar.newTracks) stage.unlockFx(id)
      }
      const tr = trackById[bar.newTracks[Math.floor(i / config.bars.intro)] ?? bar.newTracks[0]]
      hud.setPhase(t('phase.intro'), t('phase.introSub', { name: `${tr.name}（${tr.enemy}）`, role: tr.role }), 'intro')
    } else if (phase === 'count') hud.setPhase(t('phase.count'), '', 'count')
    else if (phase === 'phrase') hud.setPhase(t('phase.phrase'), t('phase.phraseSub', { i: i + 1, n }), 'listen')
    else if (phase === 'think') {
      if (i === 0) hud.setPhase(t('phase.think'), t('phase.thinkSub', { bars: n - i }), 'think')
      else hud.setPhaseSub(t('phase.thinkSub', { bars: n - i }))
    } else if (phase === 'entry') {
      stage.setHover(null)
      hud.setPhase(t('phase.entry'), '', 'entry')
    } else if (phase === 'result') showResult(bar.resolution)
  })

  if (bar.phase === 'intro' && bar.i === 0) audio.riser(time, audio.barDur * 0.5)
}

function showResult(res) {
  hud.setPhase('', '')
  for (const c of res.carryNext) stage.markCarried(c.id, c.hp, c.maxHp)
  res.baseHits.forEach((h, k) => {
    stage.enemyToBase(h.enemy.id, k * 0.18, () => {
      audio.baseHit(audio.now + 0.01)
      shownBaseHp = Math.max(0, shownBaseHp - h.dmg)
      hud.setBase(shownBaseHp, session.maxBaseHp)
      hud.bumpBase()
      stage.setCoreHp(shownBaseHp / session.maxBaseHp)
      const p = stage.coreScreen()
      hud.float(p.x, p.y, t('hit.baseHit', { n: h.dmg }), 'base')
    })
  })
  const lines = [t('result.turn', { killed: res.killed, total: res.total })]
  if (res.carryNext.length) lines.push(t('result.carried', { n: res.carryNext.length }))
  const dmg = res.baseHits.reduce((s, h) => s + h.dmg, 0)
  if (dmg) lines.push(t('result.baseHit', { n: dmg }))
  hud.turnResult(lines, res.killed === res.total)
  hud.setScore(session.stats.score)
}

function scheduleStep(bar, s, time) {
  const beat = s % SPB === 0
  const beatIdx = Math.floor(s / SPB)
  const sec = sectionOf()
  const playBacking = (padLevel, bass) => {
    if (s === 0 && padLevel > 0) audio.pad(time, chordFor(), audio.barDur, padLevel)
    if (bass && sec.backing.bassRhythm[s] === 'x') audio.bass(time, noteFreq(chordFor()[0]) / 2, audio.stepDur * 1.7)
  }

  switch (bar.phase) {
    case 'intro': {
      playBacking(0.06, false)
      const id = bar.newTracks[Math.floor(bar.i / config.bars.intro)] ?? bar.newTracks[0]
      if (beat) {
        audio.playTrack(trackById[id], time)
        at(time, () => stage.flashLane(id, 0.9))
      }
      break
    }
    case 'count':
      playBacking(0.05, false)
      if (beat) {
        audio.countBeep(time, beatIdx)
        at(time, () => hud.setPhase(String(beatIdx + 1), t('phase.count'), 'count'))
      }
      break
    case 'phrase':
      playBacking(0.04, false)
      if (beat) audio.tick(time, s === 0)
      for (const e of bar.enemies) {
        if (e.step !== s) continue
        audio.playTrack(trackById[e.track], time, { distort: e.carried })
        if (e.carried) at(time, () => stage.flashCell(e.track, e.step, 0.6))
        else if (hint) at(time, () => stage.flashColumn(s, config.hint.columnFlash))
      }
      break
    case 'think':
      playBacking(0.08, true)
      if (beat) audio.tick(time, s === 0)
      if (config.thinking.playPlacedTurrets) {
        for (const tu of session.turrets) {
          if (tu.step !== s) continue
          audio.playTrack(trackById[tu.track], time, { gain: config.thinking.placedTurretGain })
          at(time, () => stage.flashCell(tu.track, tu.step, 0.5))
        }
      }
      break
    case 'entry': {
      playBacking(0.09, true)
      const res = bar.resolution
      for (const r of res.results) {
        const e = r.enemy
        if (e.step !== s) continue
        audio.playTrack(trackById[e.track], time, { distort: e.carried })
        at(time, () => stage.spawnEnemy(e))
        r.hits.forEach((h, k) => {
          const ht = time + 0.05 + k * 0.035
          audio.zap(ht, h.kind)
          at(ht, () => {
            stage.fire(bar.turrets[h.turret], e.id, h.kind)
            const p = stage.cellScreen(e.track, e.step, 2.1)
            hud.float(p.x, p.y - k * 18, t(`hit.${h.kind}`), h.kind)
          })
        })
        if (r.killed) {
          const kt = time + 0.1 + r.hits.length * 0.035
          audio.boom(kt)
          at(kt, () => stage.killEnemy(e.id))
        }
      }
      break
    }
    case 'result':
      playBacking(0.07, false)
      if (beat) audio.tick(time, s === 0)
      break
  }
}

// ---- 入力
const canvas = stage.renderer.domElement
function hoverMode(cell) {
  if (!session || !cell || !session.canPlace()) return null
  if (!session.unlocked.includes(cell.track)) return 'invalid'
  if (session.turrets.some((tu) => tu.track === cell.track && tu.step === cell.step)) return 'remove'
  return session.turrets.length >= session.turretLimit ? 'invalid' : 'place'
}
canvas.addEventListener('pointermove', (ev) => {
  if (!session) return
  const cell = stage.pick(ev.clientX, ev.clientY)
  const mode = hoverMode(cell)
  stage.setHover(mode ? cell : null, mode)
  canvas.style.cursor = mode === 'place' || mode === 'remove' ? 'pointer' : 'default'
})
canvas.addEventListener('pointerleave', () => stage.setHover(null))
canvas.addEventListener('pointerdown', (ev) => {
  if (!session || !playing) return
  const cell = stage.pick(ev.clientX, ev.clientY)
  if (!cell) return
  const r = session.toggleTurret(cell.track, cell.step)
  if (!r.ok) {
    audio.ui('error')
    hud.toast(t(`toast.${r.reason}`))
    return
  }
  audio.ui(r.action)
  if (r.action === 'add') audio.playTrack(trackById[cell.track], audio.now + 0.01, { gain: 0.5 })
  stage.setTurrets(session.turrets)
  stage.setHover(cell, hoverMode(cell))
  hud.setTurrets(session.turrets.length, session.turretLimit, true)
})
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && session && playing) {
    ev.preventDefault()
    pressReady()
  }
})
window.addEventListener('resize', () => stage.resize())

// ---- 描画ループ
let last = performance.now()
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  const at_ = audio.now
  if (events.length) {
    events.sort((a, b) => a.time - b.time)
    while (events.length && events[0].time <= at_) events.shift().fn()
  }
  const beatDur = audio.stepDur * SPB
  const beatPhase = playing ? (((at_ - songStart) / beatDur) % 1 + 1) % 1 : (now / 1000 / 0.5) % 1
  if (playing && shownBar && ['phrase', 'think', 'entry'].includes(shownBar.phase)) {
    stage.setPlayhead(Math.min(STEPS - 0.001, Math.max(0, (at_ - shownBarStart) / audio.stepDur)))
  } else stage.setPlayhead(null)
  stage.update(dt, beatPhase, audio.levels())
  hud.layout(stage, stage.unlocked)
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
hud.showTitle()

// 開発時の確認用
if (import.meta.env.DEV) window.__sonar = { stage, audio, get session() { return session } }
