// Node 用のコンテンツ読み込み（ブラウザは src/content/index.js）
import { readFileSync } from 'node:fs'

const read = (name) => JSON.parse(readFileSync(new URL(`../src/content/${name}.json`, import.meta.url), 'utf8'))

export const content = { config: read('config'), tracks: read('tracks').tracks, song: read('song'), texts: read('texts') }
