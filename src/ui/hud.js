// DOM の UI: タイトル・HUD・ラベル・結果
import { t } from '../content/index.js'

const $ = (sel, root = document) => root.querySelector(sel)
const el = (tag, cls, html) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html != null) e.innerHTML = html
  return e
}

export class Hud {
  constructor(content, handlers) {
    this.content = content
    this.h = handlers
    this.root = $('#ui')
    this.difficulty = content.config.defaultDifficulty
    this.hint = content.config.hint.defaultOn
    this.buildTitle()
    this.buildHud()
    this.buildEnd()
    this.labels = el('div', 'labels')
    this.root.append(this.labels)
    this.laneLabels = new Map()
    for (const tr of content.tracks) {
      const l = el('div', 'lane-label', `<b>${tr.name}</b><span class="hp">${'◆'.repeat(tr.hp)}</span><small>${tr.enemy}</small>`)
      l.style.setProperty('--c', tr.color)
      this.labels.append(l)
      this.laneLabels.set(tr.id, l)
    }
    this.hpLabels = new Map()
    this.toastEl = el('div', 'toast')
    this.root.append(this.toastEl)
  }

  // ---- タイトル
  buildTitle() {
    const { config } = this.content
    const s = el('section', 'screen title-screen')
    s.innerHTML = `
      <div class="title-card">
        <div class="logo">${t('title')}</div>
        <div class="subtitle">${t('subtitle')}</div>
        <ol class="rules">${this.content.texts.rules.map((r) => `<li>${r}</li>`).join('')}</ol>
        <div class="field-label">${t('difficulty.label')}</div>
        <div class="diffs"></div>
        <label class="hint-toggle"><input type="checkbox" ${this.hint ? 'checked' : ''}/> <span>${t('hintToggle')}</span></label>
        <button class="btn primary start">${t('start')}</button>
        <div class="note">${t('startNote')}</div>
        <div class="note portrait-only">${t('landscape')}</div>
      </div>`
    const diffs = $('.diffs', s)
    for (const d of config.difficulties) {
      const b = el('button', 'diff', `<b>${t(`difficulty.${d.id}`)}</b><small>${t('difficulty.plays', { n: d.plays })}</small>`)
      b.dataset.id = d.id
      b.classList.toggle('on', d.id === this.difficulty)
      b.onclick = () => {
        this.difficulty = d.id
        for (const x of diffs.children) x.classList.toggle('on', x.dataset.id === d.id)
        this.h.uiSound?.('select')
      }
      diffs.append(b)
    }
    $('.hint-toggle input', s).onchange = (e) => (this.hint = e.target.checked)
    $('.start', s).onclick = () => this.h.start({ difficulty: this.difficulty, hint: this.hint, loop: 0 })
    this.root.append(s)
    this.titleEl = s
  }

  // ---- プレイ中
  buildHud() {
    const hud = el('div', 'hud hidden')
    hud.innerHTML = `
      <div class="top">
        <div class="tl"><div class="turn"></div><div class="section"></div></div>
        <div class="phase"><div class="phase-main"></div><div class="phase-sub"></div></div>
        <div class="tr">
          <div class="base"><span class="k">${t('hud.base')}</span><span class="pips"></span></div>
          <div class="score"><span class="k">${t('hud.score')}</span><span class="v">0</span></div>
        </div>
      </div>
      <div class="bottom">
        <button class="btn ghost quit">${t('hud.quit')}</button>
        <div class="turrets"></div>
        <button class="btn primary ready">${t('hud.ready')} <kbd>${t('hud.readyKey')}</kbd></button>
      </div>
      <div class="turn-result"></div>`
    $('.quit', hud).onclick = () => this.h.quit()
    $('.ready', hud).onclick = () => this.h.ready()
    this.root.append(hud)
    this.hudEl = hud
  }

  buildEnd() {
    const s = el('section', 'screen end-screen hidden')
    this.root.append(s)
    this.endEl = s
  }

  showTitle() {
    this.titleEl.classList.remove('hidden')
    this.hudEl.classList.add('hidden')
    this.endEl.classList.add('hidden')
    this.labels.classList.add('hidden')
  }
  showHud() {
    this.titleEl.classList.add('hidden')
    this.endEl.classList.add('hidden')
    this.hudEl.classList.remove('hidden')
    this.labels.classList.remove('hidden')
    $('.turn-result', this.hudEl).classList.remove('show')
  }

  setTurn(session) {
    const total = session.turns.length
    $('.turn', this.hudEl).textContent = t('hud.turn', { n: session.turnIndex + 1, total }) + (session.loop ? `  ·  ${t('hud.loop', { n: session.loop + 1 })}` : '')
    $('.section', this.hudEl).textContent = `${this.content.song.title} — ${session.section.name}`
  }

  setBase(hp, max) {
    const pips = $('.pips', this.hudEl)
    pips.innerHTML = Array.from({ length: max }, (_, i) => `<i class="${i < hp ? 'on' : ''}"></i>`).join('')
  }
  bumpBase() {
    const b = $('.base', this.hudEl)
    b.classList.remove('hit')
    void b.offsetWidth
    b.classList.add('hit')
  }

  setScore(v) {
    $('.score .v', this.hudEl).textContent = v.toLocaleString()
  }

  setTurrets(used, max, canPlace) {
    const box = $('.turrets', this.hudEl)
    box.innerHTML = `<span class="k">${t('hud.turrets', { used, max })}</span><span class="slots">${Array.from({ length: max }, (_, i) => `<i class="${i < used ? 'on' : ''}"></i>`).join('')}</span>`
    box.classList.toggle('active', canPlace)
  }

  setReady(state) {
    // state: 'hidden' | 'available' | 'pressed'
    const b = $('.ready', this.hudEl)
    b.classList.toggle('hidden', state === 'hidden')
    b.disabled = state === 'pressed'
    b.innerHTML = state === 'pressed' ? t('hud.readyDone') : `${t('hud.ready')} <kbd>${t('hud.readyKey')}</kbd>`
  }

  setPhase(main, sub = '', cls = '') {
    const p = $('.phase', this.hudEl)
    p.className = `phase ${cls}`
    $('.phase-main', p).textContent = main
    $('.phase-sub', p).textContent = sub
    p.classList.remove('pop')
    void p.offsetWidth
    p.classList.add('pop')
  }
  setPhaseSub(sub) {
    $('.phase-sub', this.hudEl).textContent = sub
  }

  turnResult(lines, good) {
    const r = $('.turn-result', this.hudEl)
    r.innerHTML = lines.map((l) => `<div>${l}</div>`).join('')
    r.classList.toggle('good', !!good)
    r.classList.remove('show')
    void r.offsetWidth
    r.classList.add('show')
  }

  toast(msg) {
    this.toastEl.textContent = msg
    this.toastEl.classList.remove('show')
    void this.toastEl.offsetWidth
    this.toastEl.classList.add('show')
  }

  // 画面上に浮かぶ文字（PERFECT など）
  float(x, y, text, cls) {
    const f = el('div', `float ${cls}`, text)
    f.style.left = `${x}px`
    f.style.top = `${y}px`
    this.labels.append(f)
    setTimeout(() => f.remove(), 900)
  }

  // 毎フレーム: レーン名と持ち越し敵のHP表示を3Dの位置に合わせる
  layout(stage, unlocked) {
    for (const [id, l] of this.laneLabels) {
      const p = stage.laneLabelScreen(id)
      l.style.transform = `translate(${p.x}px, ${p.y}px) translate(0, -50%)`
      l.classList.toggle('locked', !unlocked.has(id))
    }
    const seen = new Set()
    for (const e of stage.enemyLabels()) {
      seen.add(e.id)
      let l = this.hpLabels.get(e.id)
      if (!l) {
        l = el('div', 'hp-label')
        this.labels.append(l)
        this.hpLabels.set(e.id, l)
      }
      const key = `${e.hp}/${e.maxHp}`
      if (l.dataset.key !== key) {
        l.dataset.key = key
        l.innerHTML = `<span>HP</span>${Array.from({ length: e.maxHp }, (_, i) => `<i class="${i < e.hp ? 'on' : ''}"></i>`).join('')}`
      }
      l.style.transform = `translate(${e.x}px, ${e.y}px) translate(-50%, -100%)`
    }
    for (const [id, l] of this.hpLabels) {
      if (!seen.has(id)) {
        l.remove()
        this.hpLabels.delete(id)
      }
    }
  }

  showEnd({ kind, session, onRetry, onLoop, onTitle }) {
    const { stats } = session
    const clear = kind === 'clear'
    const s = this.endEl
    s.innerHTML = `
      <div class="end-card ${clear ? 'clear' : 'over'}">
        <div class="end-title">${clear ? t('end.clear') : t('end.gameover')}</div>
        ${clear ? `<div class="rank">${t('end.rank')}<b>${session.rank}</b></div>` : ''}
        <dl>
          <dt>${t('end.score')}</dt><dd>${stats.score.toLocaleString()}</dd>
          <dt>${t('end.firstKill')}</dt><dd>${stats.freshKilled} / ${stats.freshTotal}</dd>
          <dt>${t('end.perfect')}</dt><dd>${stats.perfects}</dd>
          <dt>${t('end.baseLeft')}</dt><dd>${session.baseHp} / ${session.maxBaseHp}</dd>
        </dl>
        <div class="end-btns">
          <button class="btn primary retry">${t('end.retry')}</button>
          ${clear ? `<button class="btn primary loop">${t('end.loop', { n: session.loop + 2, hp: this.content.config.baseHp.loop })}</button>` : ''}
          <button class="btn ghost to-title">${t('end.title')}</button>
        </div>
      </div>`
    $('.retry', s).onclick = onRetry
    $('.to-title', s).onclick = onTitle
    if (clear) $('.loop', s).onclick = onLoop
    s.classList.remove('hidden')
    this.hudEl.classList.add('hidden')
    this.labels.classList.add('hidden')
  }
}
