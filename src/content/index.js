// ブラウザ用のコンテンツ読み込み（Node のツールは tools/load-content.mjs）
import config from './config.json'
import tracks from './tracks.json'
import song from './song.json'
import texts from './texts.json'

export const content = { config, tracks: tracks.tracks, song, texts }

// texts.json の文言を取り出す。t('hud.turn', { n: 1, total: 8 })
export function t(path, vars = {}) {
  const s = path.split('.').reduce((o, k) => o?.[k], texts)
  if (typeof s !== 'string') return path
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`)
}
