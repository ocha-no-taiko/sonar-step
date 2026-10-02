// 盤面（シーケンサー）・基地コア・砲台・敵・演出の描画
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

const PITCH_X = 1.12
const BEAT_GAP = 0.24
const PITCH_Z = 1.32
const CELL_TOP = 0.09
const ENEMY_Y = 1.15
const TURRET_SCALE = 1.3
const RED = new THREE.Color('#ff2a3a')
const CORE_OK = new THREE.Color('#38e8ff')
const LOCKED = new THREE.Color('#2a3150')

const easeOutBack = (x) => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2)
const easeInQuad = (x) => x * x
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3)

export class Stage {
  constructor(canvas, content) {
    this.content = content
    this.tracks = content.tracks
    this.steps = content.config.steps
    this.trackIndex = Object.fromEntries(this.tracks.map((t, i) => [t.id, i]))
    this.unlocked = new Set()
    this.tweens = []
    this.beatPhase = 0
    this.time = 0
    this.shake = 0
    this.playhead = null
    this.hover = null

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    this.renderer = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#04050d')
    scene.fog = new THREE.FogExp2('#04050d', 0.021)
    this.scene = scene

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400)
    this.camTarget = new THREE.Vector3(-0.9, 0, 0.35)
    this.camDir = new THREE.Vector3(0, 0.74, 0.67).normalize()

    this.composer = new EffectComposer(renderer)
    this.composer.addPass(new RenderPass(scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.18)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    scene.add(new THREE.AmbientLight('#5a66ff', 0.5))
    const key = new THREE.DirectionalLight('#ffffff', 1.3)
    key.position.set(4, 12, 9)
    scene.add(key)
    const rim = new THREE.DirectionalLight('#ff3fa4', 0.7)
    rim.position.set(-8, 4, -10)
    scene.add(rim)

    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()

    this.buildEnvironment()
    this.buildBoard()
    this.buildCore()
    this.buildPlayhead()
    this.buildParticles()
    this.turrets = new Map()
    this.enemies = new Map()
    this.ghost = this.makeTurret('#ffffff', true)
    this.ghost.visible = false
    scene.add(this.ghost)

    this.resize()
  }

  // ---- 座標
  cellX(step) {
    return (step - (this.steps - 1) / 2) * PITCH_X + (Math.floor(step / 4) - (this.steps / 4 - 1) / 2) * BEAT_GAP
  }
  laneZ(track) {
    const i = typeof track === 'number' ? track : this.trackIndex[track]
    return ((this.tracks.length - 1) / 2 - i) * PITCH_Z
  }
  stepXf(f) {
    // 連続値のステップ位置（プレイヘッド用）
    const s = Math.max(0, Math.min(this.steps - 1, Math.floor(f)))
    return this.cellX(s) + (f - s - 0.5) * PITCH_X
  }
  get coreX() {
    return this.cellX(0) - 3.1
  }

  // ---- 環境
  buildEnvironment() {
    // 床のグリッド（距離でフェード、拍で脈動）
    const floorMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uPulse: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color('#6b3cff') } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `
        uniform float uPulse; uniform float uTime; uniform vec3 uColor; varying vec3 vW;
        float line(float v, float w){ float d = abs(fract(v)-0.5); return smoothstep(0.5-w, 0.5, d); }
        void main(){
          vec2 g = vW.xz / 1.12;
          float l = max(line(g.x, 0.035), line(g.y + uTime*0.3, 0.035));
          float dist = length(vW.xz);
          float fade = smoothstep(70.0, 6.0, dist);
          float a = l * fade * (0.11 + uPulse*0.16);
          gl_FragColor = vec4(uColor * (1.2 + uPulse), a);
        }`,
    })
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.62
    this.scene.add(floor)
    this.floorMat = floorMat

    // 星
    const n = 1400
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = 80 + Math.random() * 90
      const th = Math.random() * Math.PI * 2
      const ph = Math.random() * Math.PI * 0.48
      pos[i * 3] = r * Math.cos(th) * Math.cos(ph)
      pos[i * 3 + 1] = r * Math.sin(ph) + 2
      pos[i * 3 + 2] = r * Math.sin(th) * Math.cos(ph)
    }
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#aab8ff', size: 0.45, transparent: true, opacity: 0.75, fog: false }))
    this.scene.add(this.stars)

    // 周囲のイコライザーリング（音に反応）
    const count = 96
    const eq = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 1, 0.9), new THREE.MeshBasicMaterial({ toneMapped: false }), count)
    const c1 = new THREE.Color('#ff3fa4')
    const c2 = new THREE.Color('#33e6ff')
    for (let i = 0; i < count; i++) eq.setColorAt(i, c1.clone().lerp(c2, Math.abs(Math.cos((i / (count - 1)) * Math.PI))).multiplyScalar(0.8))
    eq.position.set(-1, -0.6, -4)
    this.scene.add(eq)
    this.eq = eq
    this.eqCount = count
    this.eqLevels = new Float32Array(count)
    this.dummy = new THREE.Object3D()
  }

  buildBoard() {
    const width = this.cellX(this.steps - 1) - this.cellX(0) + PITCH_X + 0.8
    const depth = this.tracks.length * PITCH_Z + 0.6
    const slab = new THREE.Mesh(
      new RoundedBoxGeometry(width, 0.34, depth, 3, 0.12),
      new THREE.MeshStandardMaterial({ color: '#0b0f22', metalness: 0.7, roughness: 0.32 }),
    )
    slab.position.set((this.cellX(0) + this.cellX(this.steps - 1)) / 2, -0.24, 0)
    this.scene.add(slab)
    // 盤の縁の発光ライン
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.02, 0.03, 0.03),
      new THREE.MeshBasicMaterial({ color: '#6b3cff', toneMapped: false }),
    )
    for (const z of [depth / 2, -depth / 2]) {
      const e = edge.clone()
      e.position.set(slab.position.x, -0.08, z)
      this.scene.add(e)
    }

    const bodyGeo = new RoundedBoxGeometry(1.0, 0.18, 1.12, 2, 0.06)
    const glowGeo = new THREE.PlaneGeometry(0.84, 0.96)
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#151b36', metalness: 0.55, roughness: 0.38 })
    this.cells = []
    this.cellMeshes = []
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const row = []
      for (let s = 0; s < this.steps; s++) {
        const body = new THREE.Mesh(bodyGeo, bodyMat)
        body.position.set(this.cellX(s), 0, this.laneZ(ti))
        body.userData = { track: this.tracks[ti].id, step: s }
        const glow = new THREE.Mesh(
          glowGeo,
          new THREE.MeshBasicMaterial({ color: LOCKED, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
        )
        glow.rotation.x = -Math.PI / 2
        glow.position.set(this.cellX(s), CELL_TOP + 0.002, this.laneZ(ti))
        this.scene.add(body, glow)
        this.cellMeshes.push(body)
        row.push({ body, glow, flash: 0, color: new THREE.Color(this.tracks[ti].color) })
      }
      this.cells.push(row)
    }
    this.colFlash = new Float32Array(this.steps)
    this.laneFlash = new Float32Array(this.tracks.length)
  }

  buildCore() {
    const g = new THREE.Group()
    g.position.set(this.coreX, 0, 0)
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.6, 0.5, 32), new THREE.MeshStandardMaterial({ color: '#0d1230', metalness: 0.8, roughness: 0.3 }))
    ped.position.y = -0.15
    g.add(ped)
    this.coreInnerMat = new THREE.MeshStandardMaterial({ color: '#0a0a0a', emissive: CORE_OK.clone(), emissiveIntensity: 2.2, roughness: 0.2, flatShading: true })
    this.coreInner = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), this.coreInnerMat)
    this.coreInner.position.y = 1.35
    g.add(this.coreInner)
    this.coreShellMat = new THREE.MeshBasicMaterial({ color: CORE_OK.clone(), wireframe: true, transparent: true, opacity: 0.55, toneMapped: false })
    this.coreShell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.05, 1), this.coreShellMat)
    this.coreShell.position.y = 1.35
    g.add(this.coreShell)
    this.coreRings = []
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(
        new THREE.TorusGeometry(1.45 + i * 0.22, 0.022, 8, 96),
        new THREE.MeshBasicMaterial({ color: CORE_OK.clone(), transparent: true, opacity: 0.7, toneMapped: false }),
      )
      r.position.y = 1.35
      r.rotation.x = Math.PI / 2 + i * 0.5
      r.rotation.y = i * 0.8
      g.add(r)
      this.coreRings.push(r)
    }
    this.coreLight = new THREE.PointLight(CORE_OK.clone(), 18, 14, 1.6)
    this.coreLight.position.y = 1.6
    g.add(this.coreLight)
    this.scene.add(g)
    this.core = g
    this.coreHpRatio = 1
    this.coreFlash = 0
  }

  buildPlayhead() {
    const depth = this.tracks.length * PITCH_Z + 0.4
    const g = new THREE.Group()
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.05, depth),
      new THREE.MeshBasicMaterial({ color: '#e8f6ff', toneMapped: false, transparent: true, opacity: 0.95 }),
    )
    bar.position.y = CELL_TOP + 0.05
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, depth),
      new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    )
    sheet.rotation.y = Math.PI / 2
    sheet.rotation.z = 0
    sheet.position.y = 0.5
    sheet.scale.set(1, 1, 1)
    // 縦の光の幕
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(depth, 1.0),
      new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    )
    wall.rotation.y = Math.PI / 2
    wall.position.y = 0.55
    g.add(bar, wall)
    g.visible = false
    this.scene.add(g)
    this.playheadObj = g
  }

  buildParticles() {
    const N = 2400
    this.pN = N
    this.pPos = new Float32Array(N * 3)
    this.pVel = new Float32Array(N * 3)
    this.pCol = new Float32Array(N * 3)
    this.pBase = new Float32Array(N * 3)
    this.pLife = new Float32Array(N)
    this.pMax = new Float32Array(N)
    this.pNext = 0
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3))
    this.particles = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 0.13, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    )
    this.particles.frustumCulled = false
    this.scene.add(this.particles)
  }

  burst(pos, color, n = 40, speed = 5, life = 0.7) {
    const c = new THREE.Color(color)
    for (let k = 0; k < n; k++) {
      const i = this.pNext
      this.pNext = (this.pNext + 1) % this.pN
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 - 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random()))
      this.pPos.set([pos.x, pos.y, pos.z], i * 3)
      this.pVel.set([v.x, v.y, v.z], i * 3)
      this.pBase.set([c.r * 2, c.g * 2, c.b * 2], i * 3)
      this.pLife[i] = this.pMax[i] = life * (0.5 + Math.random() * 0.7)
    }
  }

  shockwave(pos, color, size = 2.2, dur = 0.45) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.5, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    )
    m.rotation.x = -Math.PI / 2
    m.position.copy(pos)
    this.scene.add(m)
    this.tween(dur, (k) => {
      const s = 1 + easeOutCubic(k) * size
      m.scale.set(s, s, s)
      m.material.opacity = 0.9 * (1 - k)
    }, () => this.dispose(m))
  }

  // ---- 砲台
  makeTurret(color, ghost = false) {
    const g = new THREE.Group()
    const metal = ghost
      ? new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.25, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: '#8e98d8', emissive: '#1c2350', metalness: 0.75, roughness: 0.3 })
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.37, 0.16, 20), metal)
    base.position.y = 0.08
    const ringMat = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: ghost, opacity: ghost ? 0.4 : 1 })
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.035, 8, 28), ringMat)
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.17
    const head = new THREE.Group()
    head.position.y = 0.34
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 12), metal)
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.42, 10), metal)
    barrel.rotation.x = Math.PI / 2
    barrel.position.z = 0.22
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), ringMat)
    tip.position.z = 0.44
    head.add(dome, barrel, tip)
    head.rotation.x = -0.9
    g.add(base, ring, head)
    g.userData = { head, ringMat, tip }
    return g
  }

  setTurrets(list) {
    const want = new Set(list.map((t) => `${t.track}:${t.step}`))
    for (const [key, obj] of this.turrets) {
      if (!want.has(key)) {
        this.turrets.delete(key)
        this.tween(0.16, (k) => obj.scale.setScalar(TURRET_SCALE * (1 - k)), () => this.dispose(obj))
      }
    }
    for (const t of list) {
      const key = `${t.track}:${t.step}`
      if (this.turrets.has(key)) continue
      const color = this.tracks[this.trackIndex[t.track]].color
      const obj = this.makeTurret(new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.45))
      obj.position.set(this.cellX(t.step), CELL_TOP, this.laneZ(t.track))
      obj.scale.setScalar(0.01)
      this.scene.add(obj)
      this.turrets.set(key, obj)
      this.tween(0.32, (k) => obj.scale.setScalar(Math.max(0.01, easeOutBack(k) * TURRET_SCALE)))
      this.burst(obj.position.clone().setY(0.3), color, 14, 2.2, 0.4)
    }
  }

  clearTurrets() {
    this.setTurrets([])
  }

  // ---- 敵
  enemyGeometry(shape, size) {
    switch (shape) {
      case 'icosa':
        return new THREE.IcosahedronGeometry(size, 0)
      case 'octa':
        return new THREE.OctahedronGeometry(size, 0)
      case 'tetra':
        return new THREE.TetrahedronGeometry(size, 0)
      case 'knot':
        return new THREE.TorusKnotGeometry(size, size * 0.32, 64, 8, 2, 3)
      default:
        return new THREE.DodecahedronGeometry(size, 0)
    }
  }

  makeEnemy(enemy) {
    const tr = this.tracks[this.trackIndex[enemy.track]]
    const color = new THREE.Color(tr.color)
    const g = new THREE.Group()
    const geo = this.enemyGeometry(tr.shape, tr.size)
    const mat = new THREE.MeshStandardMaterial({ color: '#0a0b12', emissive: color.clone(), emissiveIntensity: 0.75, metalness: 0.3, roughness: 0.45, flatShading: true })
    const body = new THREE.Mesh(geo, mat)
    const edgeMat = new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(1.6), toneMapped: false })
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edgeMat)
    body.add(edges)
    body.position.y = ENEMY_Y
    // 足元の影リング
    const shadow = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.34, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    )
    shadow.rotation.x = -Math.PI / 2
    shadow.position.y = CELL_TOP + 0.01
    // 持ち越し敵の脈動する四角い枠（色だけに頼らず形で伝える）
    const frameMat = new THREE.MeshBasicMaterial({ color: RED.clone(), transparent: true, opacity: 0.95, side: THREE.DoubleSide, toneMapped: false })
    const frame = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.7, 4, 1, Math.PI / 4), frameMat)
    frame.rotation.x = -Math.PI / 2
    frame.position.y = CELL_TOP + 0.02
    frame.scale.set(1, 1.12, 1)
    frame.visible = false
    // 縦の枠（体のまわりのブラケット）
    const cage = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(0.95, 0.95, 0.95)),
      new THREE.LineBasicMaterial({ color: RED.clone(), transparent: true, opacity: 0.7, toneMapped: false }),
    )
    cage.position.y = ENEMY_Y
    cage.visible = false
    g.add(body, shadow, frame, cage)
    g.position.set(this.cellX(enemy.step), 0, this.laneZ(enemy.track))
    const obj = { group: g, body, mat, edgeMat, shadow, frame, cage, color, enemy: { ...enemy }, carried: false, spin: 0.6 + Math.random() * 0.6, hitFlash: 0, jolt: 0 }
    this.scene.add(g)
    this.enemies.set(enemy.id, obj)
    return obj
  }

  setCarriedLook(obj, hp, maxHp) {
    obj.carried = true
    obj.enemy.hp = hp
    obj.enemy.maxHp = maxHp
    obj.mat.emissive.copy(RED)
    obj.mat.emissiveIntensity = 0.9
    obj.edgeMat.color.copy(RED).multiplyScalar(1.8)
    obj.shadow.material.color.copy(RED)
    obj.frame.visible = true
    obj.cage.visible = true
  }

  // 入場: 上から落ちてくる
  spawnEnemy(enemy) {
    let obj = this.enemies.get(enemy.id)
    if (!obj) obj = this.makeEnemy(enemy)
    const { body } = obj
    const pos = obj.group.position.clone()
    // 落下ビーム
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 7, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: obj.carried ? RED : obj.color, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    )
    beam.position.set(pos.x, 3.5, pos.z)
    this.scene.add(beam)
    this.tween(0.35, (k) => {
      beam.material.opacity = 0.28 * (1 - k)
      beam.scale.set(1 - k * 0.8, 1, 1 - k * 0.8)
    }, () => this.dispose(beam))
    if (!obj.carried) {
      body.position.y = ENEMY_Y + 5
      body.scale.setScalar(0.2)
      this.tween(0.12, (k) => {
        body.position.y = ENEMY_Y + 5 * (1 - easeInQuad(k))
        body.scale.setScalar(0.2 + 0.8 * k)
      })
    } else {
      obj.jolt = 1
    }
    this.flashCell(enemy.track, enemy.step, 0.9)
  }

  syncCarried(enemies) {
    // ターン開始時: 持ち越し敵を新しい位置へ移動、それ以外は消す
    const keep = new Set()
    for (const e of enemies) {
      if (!e.carried) continue
      keep.add(e.id)
      let obj = this.enemies.get(e.id)
      if (!obj) {
        obj = this.makeEnemy(e)
        obj.group.scale.setScalar(0.01)
        this.tween(0.3, (k) => obj.group.scale.setScalar(Math.max(0.01, easeOutBack(k))))
      }
      this.setCarriedLook(obj, e.hp, e.maxHp)
      const from = obj.group.position.clone()
      const to = new THREE.Vector3(this.cellX(e.step), 0, this.laneZ(e.track))
      obj.enemy.step = e.step
      if (from.distanceTo(to) > 0.01) {
        this.tween(0.5, (k) => {
          const q = easeOutCubic(k)
          obj.group.position.lerpVectors(from, to, q)
          obj.group.position.y = Math.sin(q * Math.PI) * 1.2
        })
      }
    }
    for (const [id, obj] of this.enemies) if (!keep.has(id)) this.removeEnemy(id, obj)
  }

  removeEnemy(id, obj = this.enemies.get(id)) {
    if (!obj) return
    this.enemies.delete(id)
    this.dispose(obj.group)
  }

  // 砲台から敵へビーム
  fire(turret, enemyId, kind) {
    const tObj = this.turrets.get(`${turret.track}:${turret.step}`)
    const eObj = this.enemies.get(enemyId)
    if (!tObj || !eObj) return
    const from = tObj.position.clone().add(new THREE.Vector3(0, 0.36 * TURRET_SCALE, 0))
    const to = eObj.group.position.clone().add(new THREE.Vector3(0, ENEMY_Y, 0))
    tObj.userData.head.lookAt(to)
    const perfect = kind === 'perfect'
    const color = perfect ? '#ffffff' : eObj.color.clone().lerp(new THREE.Color('#ffffff'), 0.3)
    const dir = to.clone().sub(from)
    const len = dir.length()
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    )
    const w = perfect ? 0.075 : 0.035
    beam.scale.set(w, len, w)
    beam.position.copy(from).addScaledVector(dir, 0.5)
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
    this.scene.add(beam)
    this.tween(perfect ? 0.24 : 0.18, (k) => {
      beam.material.opacity = 1 - k
      beam.scale.x = beam.scale.z = w * (1 - k * 0.7)
    }, () => this.dispose(beam))
    tObj.userData.tip.scale.setScalar(2.4)
    this.tween(0.2, (k) => tObj.userData.tip.scale.setScalar(2.4 - 1.4 * k))
    this.burst(to, perfect ? '#ffffff' : eObj.color, perfect ? 18 : 8, perfect ? 4 : 2.5, 0.35)
    eObj.hitFlash = 1
    eObj.jolt = perfect ? 1 : 0.5
  }

  killEnemy(id) {
    const obj = this.enemies.get(id)
    if (!obj) return
    const p = obj.group.position.clone().setY(ENEMY_Y)
    this.burst(p, obj.carried ? RED : obj.color, 70, 6.5, 0.9)
    this.burst(p, '#ffffff', 20, 3, 0.4)
    this.shockwave(p.clone().setY(CELL_TOP + 0.03), obj.carried ? RED : obj.color, 2.4)
    this.enemies.delete(id)
    const g = obj.group
    this.tween(0.12, (k) => g.scale.setScalar(1 + k * 0.6), () => this.dispose(g))
  }

  // 生き残り → 持ち越しの見た目へ
  markCarried(id, hp, maxHp) {
    const obj = this.enemies.get(id)
    if (!obj) return
    this.setCarriedLook(obj, hp, maxHp)
    this.shockwave(obj.group.position.clone().setY(CELL_TOP + 0.03), RED, 1.2, 0.4)
  }

  // 2回目も倒せなかった敵が基地へ飛ぶ。着弾時に onImpact
  enemyToBase(id, delay, onImpact) {
    const obj = this.enemies.get(id)
    if (!obj) return onImpact?.()
    this.setCarriedLook(obj, obj.enemy.hp, obj.enemy.maxHp)
    obj.frame.visible = false
    const from = obj.group.position.clone()
    const to = new THREE.Vector3(this.coreX, 0.2, 0)
    this.enemies.delete(id)
    this.tween(delay, () => {}, () => {
      this.tween(0.55, (k) => {
        const q = easeInQuad(k)
        obj.group.position.lerpVectors(from, to, q)
        obj.group.position.y = Math.sin(k * Math.PI) * 2.2 + q * 0.2
        obj.body.rotation.x += 0.3
      }, () => {
        this.dispose(obj.group)
        const p = new THREE.Vector3(this.coreX, 1.35, 0)
        this.burst(p, RED, 90, 8, 1)
        this.shockwave(new THREE.Vector3(this.coreX, 0.15, 0), RED, 4.5, 0.6)
        this.shake = 0.5
        this.coreFlash = 1
        onImpact?.()
      })
    })
  }

  clearEnemies() {
    for (const [id, obj] of this.enemies) this.removeEnemy(id, obj)
  }

  setCoreHp(ratio) {
    this.coreHpRatio = ratio
  }

  // ---- 盤面の光
  setUnlocked(ids) {
    this.unlocked = new Set(ids)
  }
  unlockFx(trackId) {
    const ti = this.trackIndex[trackId]
    this.laneFlash[ti] = 1.5
    for (let s = 0; s < this.steps; s++) {
      const c = this.cells[ti][s]
      this.tween(0.05 + s * 0.025, () => {}, () => {
        c.flash = 1.2
        if (s % 4 === 0) this.burst(c.glow.position.clone().setY(0.2), this.tracks[ti].color, 6, 2, 0.5)
      })
    }
  }
  flashColumn(step, amt) {
    this.colFlash[step] = Math.max(this.colFlash[step], amt)
  }
  flashLane(trackId, amt) {
    this.laneFlash[this.trackIndex[trackId]] = Math.max(this.laneFlash[this.trackIndex[trackId]], amt)
  }
  flashCell(trackId, step, amt) {
    const c = this.cells[this.trackIndex[trackId]][step]
    c.flash = Math.max(c.flash, amt)
  }
  setPlayhead(f) {
    this.playhead = f
  }
  setHover(cell, mode) {
    this.hover = cell ? { ...cell, mode } : null
  }

  // ---- 入力
  pick(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObjects(this.cellMeshes, false)[0]
    return hit ? { ...hit.object.userData } : null
  }

  // 3D → 画面座標（ラベル用）
  toScreen(v) {
    const p = v.clone().project(this.camera)
    const r = this.renderer.domElement.getBoundingClientRect()
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, visible: p.z < 1 }
  }
  cellScreen(trackId, step, y = 0) {
    return this.toScreen(new THREE.Vector3(this.cellX(step), y, this.laneZ(trackId)))
  }
  laneLabelScreen(trackId) {
    return this.toScreen(new THREE.Vector3(this.cellX(this.steps - 1) + 1.05, 0, this.laneZ(trackId)))
  }
  enemyLabels() {
    const out = []
    for (const [id, obj] of this.enemies) {
      if (!obj.carried) continue
      const p = this.toScreen(obj.group.position.clone().setY(ENEMY_Y + 0.75))
      out.push({ id, ...p, hp: obj.enemy.hp, maxHp: obj.enemy.maxHp })
    }
    return out
  }
  coreScreen() {
    return this.toScreen(new THREE.Vector3(this.coreX, 2.9, 0))
  }

  // ---- 時間
  tween(dur, fn, done) {
    this.tweens.push({ t: 0, dur, fn, done })
  }
  dispose(obj) {
    obj.removeFromParent()
    obj.traverse((o) => {
      o.geometry?.dispose()
      o.material?.dispose?.()
    })
  }

  resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.bloom.setSize(w, h)
    this.camera.aspect = w / h
    // 盤面全体（基地〜ラベル）が横に収まる距離
    const right = this.cellX(this.steps - 1) + 3.8
    const left = this.coreX - 1.9
    const width = right - left
    const vfov = THREE.MathUtils.degToRad(this.camera.fov)
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect)
    const distW = width / 2 / Math.tan(hfov / 2)
    const distH = 9 / 2 / Math.tan(vfov / 2)
    this.camDist = Math.max(distW, distH) * 1.04
    this.camTarget.x = (left + right) / 2
    this.camera.updateProjectionMatrix()
  }

  // beatPhase: 0..1（拍の頭で 0）
  update(dt, beatPhase, levels) {
    this.time += dt
    this.beatPhase = beatPhase
    const beatEnv = Math.exp(-beatPhase * 5)

    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i]
      tw.t += dt
      const k = Math.min(1, tw.t / tw.dur)
      tw.fn(k)
      if (k >= 1) {
        this.tweens.splice(i, 1)
        tw.done?.()
      }
    }

    // カメラ（ゆっくり揺らぐ＋被弾シェイク）
    this.shake = Math.max(0, this.shake - dt * 1.4)
    const sway = new THREE.Vector3(Math.sin(this.time * 0.21) * 0.35, Math.sin(this.time * 0.17) * 0.2, 0)
    const sh = this.shake * this.shake
    this.camera.position.copy(this.camTarget).addScaledVector(this.camDir, this.camDist).add(sway)
    this.camera.position.x += (Math.random() - 0.5) * sh * 1.2
    this.camera.position.y += (Math.random() - 0.5) * sh * 1.2
    this.camera.lookAt(this.camTarget)

    // 床・星
    this.floorMat.uniforms.uPulse.value = beatEnv * 0.8
    this.floorMat.uniforms.uTime.value = this.time
    this.stars.rotation.y = this.time * 0.004

    // イコライザー
    // 盤の奥に半円で並べる（中央が低音）
    const R = 40
    for (let i = 0; i < this.eqCount; i++) {
      const bin = levels ? levels[Math.floor((Math.abs(i - this.eqCount / 2) / (this.eqCount / 2)) * 70) + 2] / 255 : 0
      this.eqLevels[i] += (bin - this.eqLevels[i]) * Math.min(1, dt * 14)
      const a = Math.PI + (i / (this.eqCount - 1)) * Math.PI
      const hgt = 0.3 + this.eqLevels[i] * 12 + beatEnv * 0.5
      this.dummy.position.set(Math.cos(a) * R, hgt / 2, Math.sin(a) * R * 0.75)
      this.dummy.rotation.y = -a
      this.dummy.scale.set(1, hgt, 1)
      this.dummy.updateMatrix()
      this.eq.setMatrixAt(i, this.dummy.matrix)
    }
    this.eq.instanceMatrix.needsUpdate = true

    // セル
    const phStep = this.playhead == null ? -1 : Math.floor(this.playhead)
    for (let s = 0; s < this.steps; s++) this.colFlash[s] = Math.max(0, this.colFlash[s] - dt * 3)
    for (let ti = 0; ti < this.tracks.length; ti++) {
      this.laneFlash[ti] = Math.max(0, this.laneFlash[ti] - dt * 2.5)
      const tid = this.tracks[ti].id
      const open = this.unlocked.has(tid)
      for (let s = 0; s < this.steps; s++) {
        const c = this.cells[ti][s]
        c.flash = Math.max(0, c.flash - dt * 3.2)
        let o
        if (!open) {
          c.glow.material.color.copy(LOCKED)
          o = 0.12 + this.laneFlash[ti] * 0.5
        } else {
          c.glow.material.color.copy(c.color)
          o = s % 4 === 0 ? 0.14 : 0.065
          o += beatEnv * 0.04
          if (s === phStep) o += 0.32
          o += this.colFlash[s] + this.laneFlash[ti] * 0.35 + c.flash * 0.8
          const h = this.hover
          if (h && h.track === tid) {
            const d = Math.abs(h.step - s)
            if (d === 0) o += h.mode === 'invalid' ? 0.15 : 0.55
            else if (d <= 1 && h.mode === 'place') o += 0.22
          }
        }
        c.glow.material.opacity = Math.min(1.4, o)
      }
    }

    // プレイヘッド
    if (this.playhead == null) this.playheadObj.visible = false
    else {
      this.playheadObj.visible = true
      this.playheadObj.position.x = this.stepXf(this.playhead)
    }

    // ゴースト砲台
    const h = this.hover
    if (h && h.mode === 'place') {
      this.ghost.visible = true
      this.ghost.position.set(this.cellX(h.step), CELL_TOP, this.laneZ(h.track))
      this.ghost.scale.setScalar(TURRET_SCALE)
      this.ghost.userData.ringMat.color.set(this.tracks[this.trackIndex[h.track]].color)
    } else this.ghost.visible = false

    // 砲台のアイドル
    for (const obj of this.turrets.values()) {
      obj.children[1].scale.setScalar(1 + beatEnv * 0.12)
    }

    // 敵
    for (const obj of this.enemies.values()) {
      obj.body.rotation.y += dt * obj.spin * (obj.carried ? 2.2 : 1)
      obj.body.rotation.x += dt * obj.spin * 0.4
      obj.hitFlash = Math.max(0, obj.hitFlash - dt * 6)
      obj.jolt = Math.max(0, obj.jolt - dt * 5)
      const bob = Math.sin(this.time * 3 + obj.enemy.step) * 0.06
      if (obj.body.position.y < ENEMY_Y + 0.5) obj.body.position.y = ENEMY_Y + bob + obj.jolt * 0.25
      obj.mat.emissiveIntensity = (obj.carried ? 0.9 : 0.75) + obj.hitFlash * 3 + beatEnv * 0.25
      obj.body.position.x = (Math.random() - 0.5) * obj.hitFlash * 0.15
      if (obj.carried) {
        // 残りHPが多いほど強く脈動（BPM同期、控えめ）
        const ratio = obj.enemy.maxHp ? obj.enemy.hp / obj.enemy.maxHp : 1
        const amp = 0.06 + 0.16 * ratio
        const s = 1 + amp * beatEnv
        obj.frame.scale.set(s, s * 1.12, s)
        obj.frame.material.opacity = 0.55 + 0.45 * beatEnv
        obj.cage.scale.setScalar(1 + amp * 0.6 * beatEnv)
        obj.cage.rotation.y = -obj.body.rotation.y * 0.25
      }
    }

    // 基地コア
    this.coreFlash = Math.max(0, this.coreFlash - dt * 2)
    const coreCol = RED.clone().lerp(CORE_OK, this.coreHpRatio)
    const flick = this.coreHpRatio < 0.4 ? 0.6 + Math.random() * 0.4 : 1
    this.coreInnerMat.emissive.copy(coreCol).lerp(new THREE.Color('#ffffff'), this.coreFlash * 0.6)
    this.coreInnerMat.emissiveIntensity = (1.8 + beatEnv * 0.9) * flick
    this.coreShellMat.color.copy(coreCol)
    this.coreLight.color.copy(coreCol)
    this.coreLight.intensity = (14 + beatEnv * 10 + this.coreFlash * 30) * flick
    this.coreInner.rotation.y += dt * 0.6
    this.coreInner.scale.setScalar(1 + beatEnv * 0.08)
    this.coreShell.rotation.y -= dt * 0.25
    this.coreShell.rotation.x += dt * 0.12
    this.coreRings.forEach((r, i) => {
      r.rotation.z += dt * (0.3 + i * 0.25) * (i % 2 ? -1 : 1)
      r.material.color.copy(coreCol)
    })

    // パーティクル
    for (let i = 0; i < this.pN; i++) {
      if (this.pLife[i] <= 0) continue
      this.pLife[i] -= dt
      const k = Math.max(0, this.pLife[i] / this.pMax[i])
      const j = i * 3
      this.pVel[j + 1] -= 6 * dt
      this.pVel[j] *= 1 - dt * 1.8
      this.pVel[j + 2] *= 1 - dt * 1.8
      this.pPos[j] += this.pVel[j] * dt
      this.pPos[j + 1] = Math.max(CELL_TOP, this.pPos[j + 1] + this.pVel[j + 1] * dt)
      this.pPos[j + 2] += this.pVel[j + 2] * dt
      this.pCol[j] = this.pBase[j] * k
      this.pCol[j + 1] = this.pBase[j + 1] * k
      this.pCol[j + 2] = this.pBase[j + 2] * k
    }
    this.particles.geometry.attributes.position.needsUpdate = true
    this.particles.geometry.attributes.color.needsUpdate = true

    this.composer.render()
  }
}
