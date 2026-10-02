// ルールとコンテンツの整合性テスト: node tools/test-rules.mjs
import assert from 'node:assert/strict'
import { content } from './load-content.mjs'
import { parsePhrase, resolve, placeCarried, mulberry32, minTurretsForTrack, solveTrack, rankFor } from '../src/game/rules.js'
import { Session } from '../src/game/session.js'

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`ok - ${name}`)
}
const { config, tracks, song } = content
const dmg = config.damage
const trackIds = tracks.map((t) => t.id)
const hpOf = Object.fromEntries(tracks.map((t) => [t.id, t.hp]))

// ターンが「準備完了」待ちになるまで小節を進める
function advanceTo(s, phase) {
  for (let k = 0; k < 200; k++) {
    if (s.phase === phase) return
    s.nextBar()
  }
  throw new Error(`phase ${phase} に到達しない`)
}

// 1ターン分: think まで進めて置き方を決め、結果小節まで進める
function playTurn(s, place) {
  advanceTo(s, 'think')
  for (const t of place(s)) s.toggleTurret(t.track, t.step)
  s.pressReady()
  advanceTo(s, 'result')
}

test('コンテンツ: フレーズは16文字・解放済みトラックのみ・敵の上限内', () => {
  for (const sec of song.sections) {
    for (const id of [...sec.tracks, ...(sec.newTracks ?? [])]) assert.ok(trackIds.includes(id), `track ${id}`)
    for (const turn of sec.turns) {
      for (const [id, str] of Object.entries(turn.phrase)) {
        assert.equal(str.length, config.steps, `${sec.id} ${id} の長さ`)
        assert.ok(sec.tracks.includes(id), `${sec.id} で ${id} は未解放`)
        assert.match(str, /^[x.]+$/)
      }
      // 持ち越し敵の置き場所が必ず残るよう、各トラックの半分以下に抑える
      for (const str of Object.values(turn.phrase)) assert.ok([...str].filter((c) => c === 'x').length <= config.steps / 2)
    }
  }
})

test('コンテンツ: 各ターンの砲台上限で全滅させられる', () => {
  for (const sec of song.sections) {
    for (const turn of sec.turns) {
      const enemies = parsePhrase(turn.phrase, sec.tracks, config.steps).map((e) => ({ ...e, hp: hpOf[e.track] }))
      const need = sec.tracks.reduce((sum, id) => sum + minTurretsForTrack(enemies.filter((e) => e.track === id), config.steps, dmg), 0)
      assert.ok(need <= turn.turrets, `${sec.id}: 必要 ${need} > 上限 ${turn.turrets}`)
    }
  }
})

test('判定: 同じマスはパーフェクト、隣はグッド、2つ先は外れ', () => {
  const e = [{ track: 'kick', step: 4, hp: 2 }]
  assert.equal(resolve(e, [{ track: 'kick', step: 4 }], dmg)[0].hits[0].kind, 'perfect')
  assert.equal(resolve(e, [{ track: 'kick', step: 5 }], dmg)[0].hits[0].kind, 'good')
  assert.equal(resolve(e, [{ track: 'kick', step: 3 }], dmg)[0].total, dmg.good)
  assert.equal(resolve(e, [{ track: 'kick', step: 6 }], dmg)[0].hits.length, 0)
})

test('判定: 上下（別トラック）には届かない', () => {
  const r = resolve([{ track: 'kick', step: 4, hp: 2 }], [{ track: 'snare', step: 4 }], dmg)
  assert.equal(r[0].total, 0)
})

test('判定: 重なった範囲はダメージ加算（グッド2発で中型を倒せる）', () => {
  const r = resolve([{ track: 'snare', step: 4, hp: 2 }], [{ track: 'snare', step: 3 }, { track: 'snare', step: 5 }], dmg)
  assert.equal(r[0].total, dmg.good * 2)
  assert.equal(r[0].killed, true)
})

test('判定: 1つの砲台が隣り合う2体に当たる', () => {
  const r = resolve([{ track: 'hat', step: 2, hp: 1 }, { track: 'hat', step: 4, hp: 1 }], [{ track: 'hat', step: 3 }], dmg)
  assert.ok(r.every((x) => x.killed))
})

test('持ち越し: 新しい敵と重ならず、同じトラックに置かれ、シードで再現する', () => {
  const fresh = parsePhrase({ kick: 'xxxxxxx.xxxxxxxx' }, ['kick'], 16)
  const carried = [{ id: 1, track: 'kick', step: 3, hp: 1 }]
  const a = placeCarried(carried, fresh, 16, mulberry32(5))
  assert.equal(a[0].step, 7)
  assert.equal(a[0].track, 'kick')
  const f2 = parsePhrase({ kick: 'x.......x.......' }, ['kick'], 16)
  const c2 = [{ id: 1, track: 'kick', step: 0, hp: 1 }, { id: 2, track: 'kick', step: 8, hp: 2 }]
  const p1 = placeCarried(c2, f2, 16, mulberry32(9))
  const p2 = placeCarried(c2, f2, 16, mulberry32(9))
  assert.deepEqual(p1, p2)
  const steps = p1.map((p) => p.step)
  assert.equal(new Set(steps).size, 2)
  for (const s of steps) assert.ok(s !== 0 && s !== 8)
})

test('最少砲台数の計算', () => {
  assert.equal(minTurretsForTrack([{ step: 2, hp: 1 }, { step: 4, hp: 1 }], 16, dmg), 1)
  assert.equal(minTurretsForTrack([{ step: 7, hp: 3 }], 16, dmg), 2)
  assert.equal(minTurretsForTrack([{ step: 0, hp: 2 }, { step: 8, hp: 2 }], 16, dmg), 2)
})

test('進行: 最適に置けばノーダメージでクリア、ランクS', () => {
  const s = new Session(content, { difficulty: 'expert' })
  const solve = (s) => s.unlocked.flatMap((id) => solveTrack(s.enemies.filter((e) => e.track === id), config.steps, dmg).map((step) => ({ track: id, step })))
  for (let i = 0; i < s.turns.length; i++) playTurn(s, solve)
  s.nextBar()
  assert.equal(s.phase, 'clear')
  assert.equal(s.baseHp, config.baseHp.first)
  assert.equal(s.rank, 'S')
  assert.ok(s.stats.score > 0)
})

test('進行: 何も置かないと持ち越し → 2回目で基地に直撃 → ゲームオーバー', () => {
  const s = new Session(content, { difficulty: 'normal' })
  playTurn(s, () => [])
  assert.equal(s.baseHp, config.baseHp.first, '1ターン目は持ち越しだけ')
  assert.equal(s.carried.length, 2)
  assert.ok(s.carried.every((c) => c.carried && c.hp === hpOf.kick))
  s.nextBar() // 2ターン目へ
  assert.equal(s.enemies.filter((e) => e.carried).length, 2, '持ち越し敵がフレーズに混ざる')
  playTurn(s, () => [])
  assert.equal(s.baseHp, Math.max(0, config.baseHp.first - 2 * hpOf.kick), '残りHP分が直撃')
  for (let k = 0; k < 400 && s.phase !== 'gameover'; k++) {
    if (s.phase === 'think') s.pressReady()
    s.nextBar()
  }
  assert.equal(s.phase, 'gameover')
})

test('進行: 持ち越し敵は残りHPのまま、倒せば得点', () => {
  const s = new Session(content, { difficulty: 'normal' })
  // 1体目にグッドだけ → HP1 で持ち越し
  playTurn(s, (s) => [{ track: 'kick', step: 1 }, { track: 'kick', step: 8 }])
  assert.equal(s.carried.length, 1)
  assert.equal(s.carried[0].hp, 1)
  s.nextBar()
  const c = s.enemies.find((e) => e.carried)
  advanceTo(s, 'think')
  const before = s.stats.carriedKilled
  s.toggleTurret(c.track, c.step)
  s.pressReady()
  advanceTo(s, 'result')
  assert.equal(s.stats.carriedKilled, before + 1)
})

test('砲台: 上限・未解放トラック・シンキングタイム外は置けない、同じマスで外せる', () => {
  const s = new Session(content, { difficulty: 'normal' })
  assert.equal(s.toggleTurret('kick', 0).reason, 'notNow')
  advanceTo(s, 'think')
  assert.equal(s.toggleTurret('snare', 0).reason, 'locked')
  for (let i = 0; i < s.turretLimit; i++) assert.ok(s.toggleTurret('kick', i).ok)
  assert.equal(s.toggleTurret('kick', 15).reason, 'full')
  assert.equal(s.toggleTurret('kick', 0).action, 'remove')
})

test('準備完了: 早押しでボーナス、シンキングタイムが打ち切られる', () => {
  const s = new Session(content, { difficulty: 'normal' })
  advanceTo(s, 'think')
  s.pressReady()
  s.nextBar()
  assert.equal(s.phase, 'entry')
  assert.equal(s.resolution.readyBonus, (config.bars.think - 1) * config.score.readyBonusPerBar)
})

test('2周目は基地HPが少ない', () => {
  assert.equal(new Session(content, { difficulty: 'normal', loop: 1 }).baseHp, config.baseHp.loop)
})

test('ランク判定', () => {
  assert.equal(rankFor(1, config.score.ranks), 'S')
  assert.equal(rankFor(0.1, config.score.ranks), 'C')
})

console.log(`\n${passed} passed`)
