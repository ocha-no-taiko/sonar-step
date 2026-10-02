// 1プレイ分の進行。小節ごとに nextBar() を呼ぶと、その小節で何をするかを返す
import { parsePhrase, placeCarried, resolve, mulberry32, rankFor } from './rules.js'

export class Session {
  constructor(content, { difficulty, loop = 0 }) {
    this.content = content
    this.config = content.config
    this.trackById = Object.fromEntries(content.tracks.map((t) => [t.id, t]))
    this.difficulty = this.config.difficulties.find((d) => d.id === difficulty) ?? this.config.difficulties[0]
    this.loop = loop
    this.maxBaseHp = loop > 0 ? this.config.baseHp.loop : this.config.baseHp.first
    this.baseHp = this.maxBaseHp
    this.turns = content.song.sections.flatMap((sec, si) => sec.turns.map((turn, ti) => ({ ...turn, sectionIndex: si, firstOfSection: ti === 0 })))
    this.carried = []
    this.stats = { score: 0, freshTotal: 0, freshKilled: 0, carriedKilled: 0, perfects: 0, goods: 0, baseDamage: 0, readyBonus: 0 }
    this.nextId = 1
    this.ended = null
    this.cur = null
    this.startTurn(0)
  }

  get turn() {
    return this.turns[this.turnIndex]
  }
  get section() {
    return this.content.song.sections[this.turn.sectionIndex]
  }
  get unlocked() {
    return this.section.tracks
  }
  get isFinalTurn() {
    return this.turnIndex === this.turns.length - 1
  }
  get turretLimit() {
    const carriedCount = this.enemies.filter((e) => e.carried).length
    return this.turn.turrets + carriedCount * this.config.carry.carriedBonusTurrets
  }
  get phase() {
    return this.ended ?? this.cur?.phase ?? 'idle'
  }

  startTurn(i) {
    const { steps } = this.config
    this.turnIndex = i
    const fresh = parsePhrase(this.turn.phrase, this.unlocked, steps).map((e) => this.makeEnemy(e))
    const rng = mulberry32(this.content.song.seed + this.loop * 1000 + i * 17)
    const carried = placeCarried(this.carried, fresh, steps, rng)
    this.enemies = [...fresh, ...carried]
    this.carried = []
    this.turrets = []
    this.ready = false
    this.locked = false
    this.resolution = null
    this.thinkBarsUsed = 0
    const b = this.config.bars
    const newTracks = this.turn.firstOfSection ? this.section.newTracks ?? [] : []
    this.plan = [
      ...(newTracks.length ? [{ phase: 'intro', n: b.intro * newTracks.length, newTracks }] : []),
      { phase: 'count', n: b.count },
      { phase: 'phrase', n: this.difficulty.plays },
      { phase: 'think', n: b.think },
      { phase: 'entry', n: b.entry },
      { phase: 'result', n: b.result },
    ]
    this.stats.freshTotal += fresh.length
  }

  makeEnemy({ track, step }) {
    const hp = this.trackById[track].hp
    return { id: this.nextId++, track, step, hp, maxHp: hp, carried: false }
  }

  // 次の小節の内容を決める
  nextBar() {
    if (this.ended) return { phase: this.ended }
    const cur = this.cur
    const thinkCut = cur?.phase === 'think' && this.ready
    if (cur && cur.i + 1 < cur.n && !thinkCut) {
      cur.i++
    } else {
      if (!this.plan.length) {
        // ターン終わり
        if (this.baseHp <= 0) return this.end('gameover')
        if (this.isFinalTurn) return this.end('clear')
        this.startTurn(this.turnIndex + 1)
      }
      const next = this.plan.shift()
      this.cur = { ...next, i: 0 }
      if (next.phase === 'entry') this.resolveEntry()
      if (next.phase === 'result') this.applyResult()
    }
    if (this.cur.phase === 'think') this.thinkBarsUsed = this.cur.i + 1
    return this.describe()
  }

  describe() {
    const { phase, i, n, newTracks } = this.cur
    return { phase, i, n, newTracks, turnIndex: this.turnIndex, enemies: this.enemies, turrets: [...this.turrets], resolution: this.resolution }
  }

  end(kind) {
    this.ended = kind
    this.cur = null
    if (kind === 'clear') this.stats.score += this.baseHp * this.config.score.baseHpBonus
    return { phase: kind }
  }

  canPlace() {
    if (this.locked) return false
    const p = this.cur?.phase
    return p === 'think' || (this.config.placement.allowDuringPhrase && p === 'phrase')
  }

  toggleTurret(track, step) {
    if (!this.canPlace()) return { ok: false, reason: 'notNow' }
    if (!this.unlocked.includes(track)) return { ok: false, reason: 'locked' }
    const idx = this.turrets.findIndex((t) => t.track === track && t.step === step)
    if (idx >= 0) {
      this.turrets.splice(idx, 1)
      return { ok: true, action: 'remove' }
    }
    if (this.turrets.length >= this.turretLimit) return { ok: false, reason: 'full' }
    this.turrets.push({ track, step })
    return { ok: true, action: 'add' }
  }

  pressReady() {
    if (this.cur?.phase !== 'think' || this.ready) return false
    this.ready = true
    return true
  }

  resolveEntry() {
    const { score, bars } = this.config
    this.locked = true
    const results = resolve(this.enemies, this.turrets, this.config.damage)
    const baseHits = []
    const carryNext = []
    let gained = 0
    for (const r of results) {
      for (const h of r.hits) {
        if (h.kind === 'perfect') {
          this.stats.perfects++
          gained += score.perfectHit
        } else this.stats.goods++
      }
      const e = r.enemy
      if (r.killed) {
        if (e.carried) this.stats.carriedKilled++
        else this.stats.freshKilled++
        gained += e.carried ? score.carriedKill : score.kill
      } else if (e.carried || (this.isFinalTurn && this.config.carry.finalTurnSurvivorsHitBase)) {
        baseHits.push({ enemy: e, dmg: r.remaining })
      } else {
        carryNext.push({ ...e, hp: r.remaining, carried: true })
      }
    }
    const readyBonus = this.ready ? Math.max(0, bars.think - this.thinkBarsUsed) * score.readyBonusPerBar : 0
    this.stats.readyBonus += readyBonus
    gained += readyBonus
    this.stats.score += gained
    const killed = results.filter((r) => r.killed).length
    this.resolution = { results, baseHits, carryNext, readyBonus, gained, killed, total: results.length }
  }

  applyResult() {
    const dmg = this.resolution.baseHits.reduce((s, h) => s + h.dmg, 0)
    this.baseHp = Math.max(0, this.baseHp - dmg)
    this.stats.baseDamage += dmg
    this.carried = this.resolution.carryNext
  }

  get firstKillRatio() {
    return this.stats.freshTotal ? this.stats.freshKilled / this.stats.freshTotal : 0
  }
  get rank() {
    return rankFor(this.firstKillRatio, this.config.score.ranks)
  }
}
