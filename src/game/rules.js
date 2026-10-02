// 判定・持ち越し配置などの純粋なルール（DOM / 音 / 描画に依存しない）

// 再現性のある乱数（同じシードなら同じ持ち越し配置になる）
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// "x...x..." → [{ track, step }]
export function parsePhrase(phrase, trackIds, steps) {
  const out = []
  for (const id of trackIds) {
    const s = phrase[id]
    if (!s) continue
    for (let i = 0; i < steps; i++) if (s[i] === 'x') out.push({ track: id, step: i })
  }
  return out
}

// 1体の敵に対する砲台ごとの当たり。範囲は同じトラックの左右 range ステップのみ
export function hitsOn(enemy, turrets, damage) {
  const hits = []
  turrets.forEach((tu, i) => {
    if (tu.track !== enemy.track) return
    const d = Math.abs(tu.step - enemy.step)
    if (d === 0) hits.push({ turret: i, kind: 'perfect', dmg: damage.perfect })
    else if (d <= damage.range) hits.push({ turret: i, kind: 'good', dmg: damage.good })
  })
  return hits
}

// 全敵の判定。重なった砲台のダメージは加算
export function resolve(enemies, turrets, damage) {
  return enemies.map((e) => {
    const hits = hitsOn(e, turrets, damage)
    const total = hits.reduce((s, h) => s + h.dmg, 0)
    const remaining = Math.max(0, e.hp - total)
    return { enemy: e, hits, total, remaining, killed: remaining === 0 }
  })
}

// 持ち越し敵を、新しい敵と重ならない同じトラックのマスへ再配置する
export function placeCarried(carried, fresh, steps, rng) {
  const taken = new Set(fresh.map((e) => `${e.track}:${e.step}`))
  const placed = []
  for (const c of carried) {
    const free = []
    for (let s = 0; s < steps; s++) if (!taken.has(`${c.track}:${s}`)) free.push(s)
    if (!free.length) continue // フレーズの敵数上限で起きない想定。起きたら配置しない
    const step = free[Math.floor(rng() * free.length)]
    taken.add(`${c.track}:${step}`)
    placed.push({ ...c, step })
  }
  return placed
}

// 1トラック分の敵（step と hp）を全滅させる最少の砲台の置き方（コンテンツ検証・テスト用）。無理なら null
export function solveTrack(enemies, steps, damage) {
  if (!enemies.length) return []
  const lo = Math.max(0, Math.min(...enemies.map((e) => e.step)) - damage.range)
  const hi = Math.min(steps - 1, Math.max(...enemies.map((e) => e.step)) + damage.range)
  const cells = []
  for (let s = lo; s <= hi; s++) cells.push(s)
  let best = null
  for (let mask = 1; mask < 1 << cells.length; mask++) {
    let n = 0
    for (let m = mask; m; m &= m - 1) n++
    if (best && n >= best.length) continue
    const turrets = cells.filter((_, i) => mask & (1 << i)).map((step) => ({ track: 'x', step }))
    const ok = enemies.every((e) => hitsOn({ ...e, track: 'x' }, turrets, damage).reduce((s, h) => s + h.dmg, 0) >= e.hp)
    if (ok) best = turrets.map((t) => t.step)
  }
  return best
}

export const minTurretsForTrack = (enemies, steps, damage) => solveTrack(enemies, steps, damage)?.length ?? Infinity

export function rankFor(ratio, ranks) {
  return (ranks.find((r) => ratio >= r.min) ?? ranks[ranks.length - 1]).rank
}
