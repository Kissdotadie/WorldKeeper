/** 3D 时间线（P4 遗留补全）：线索长河 —— 纯 three.js 实现。
 *
 * 为什么不用 3d-force-graph：长河的坐标**全部是预先算死的**，
 * 力导向引擎在这里毫无用武之地，反而引入黑盒时序问题
 * （graphData 场景异步更新、zoomToFit 失灵）。静态场景手写
 * renderer + OrbitControls 反而最可控。
 *
 * 布局：
 * - X 轴 = 章节顺序（从左往右翻书）
 * - Y 轴 = 实体的道（同类聚成一条带；带内一行一条线索）
 * - 同一实体的出场点用线串起来 → **线断了就是线索断点**，一眼可见。
 */

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { TimelineData } from '../api/types'
import { cssColor, makeLabel, typeColor } from './three-utils'

interface Props {
  data: TimelineData
  themeKey?: string
  onSelectEntity?: (id: string) => void
  /** 双击节点 → 就地编辑浮层（P11-B5）。与三维关系网同一套交互 */
  onNodeEdit?: (id: string, name: string, screen: { x: number; y: number }, nearType?: string) => void
  /** 就地编辑开关（useGraphEdit 的两态开关）。默认开 */
  editable?: boolean
  /** 辉光后处理 —— 与三维关系网共用同一个开关（scene.json 的 styles.glow） */
  glow?: boolean
}

const CHAPTER_GAP = 110 // 章间距
const ROW_H = 40 // 同一带里每条线索的行高
const BAND_GAP = 90 // 类型带之间的空隙

/** 一条线索上的一个出场点 */
interface RiverNode {
  entityId: string
  name: string
  type: string
  kind: 'first' | 'appearance'
  chapter: string
  pos: THREE.Vector3
}

export function Timeline3D({ data, themeKey = '', onSelectEntity, onNodeEdit, editable = true, glow = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  // 回调走 ref：编辑浮层的开关/目标每次渲染都会变，
  // 不然就得把它塞进下面的巨型 effect 依赖里把整个场景推倒重建
  const cbRef = useRef({ onSelectEntity, onNodeEdit, editable })
  cbRef.current = { onSelectEntity, onNodeEdit, editable }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    const labelColor = cssColor('--text-secondary', '#d6deeb')
    const lineColor = new THREE.Color(cssColor('--border-default', 'rgba(128,128,128,0.4)'))
    const bgColor = new THREE.Color(cssColor('--bg-app', '#0b0e14'))
    const axisColor = new THREE.Color(cssColor('--text-faint', '#6b7280'))

    // ---- 排道：类型一条带；带内实体按首次出场顺序排行 ----
    const typeOrder: string[] = []
    const laneCounters = new Map<string, number>()
    const laneOf = new Map<string, { row: number; type: string }>()
    for (const ch of data.chapters) {
      for (const e of ch.entries) {
        if (laneOf.has(e.entity_id)) continue
        if (!laneCounters.has(e.type)) {
          laneCounters.set(e.type, 0)
          typeOrder.push(e.type)
        }
        const row = laneCounters.get(e.type)!
        laneCounters.set(e.type, row + 1)
        laneOf.set(e.entity_id, { row, type: e.type })
      }
    }
    const bandOffset = new Map<string, number>()
    {
      let acc = 0
      for (const t of typeOrder) {
        bandOffset.set(t, acc)
        acc += (laneCounters.get(t) ?? 0) * ROW_H + BAND_GAP
      }
    }

    // ---- 造点与线 ----
    const nodes: RiverNode[] = []
    const byEntity = new Map<string, RiverNode[]>()
    data.chapters.forEach((ch, ci) => {
      for (const e of ch.entries) {
        const lane = laneOf.get(e.entity_id)
        if (!lane) continue
        const node: RiverNode = {
          entityId: e.entity_id,
          name: e.name,
          type: e.type,
          kind: e.kind,
          chapter: ch.chapter,
          pos: new THREE.Vector3(
            ci * CHAPTER_GAP,
            -(bandOffset.get(e.type) ?? 0) + lane.row * ROW_H,
            0,
          ),
        }
        nodes.push(node)
        const list = byEntity.get(e.entity_id) ?? []
        list.push(node)
        byEntity.set(e.entity_id, list)
      }
    })

    // ---- 场景 ----
    const scene = new THREE.Scene()
    scene.background = bgColor
    scene.fog = new THREE.Fog(bgColor, 900, 4000)

    const camera = new THREE.PerspectiveCamera(40, 1, 1, 8000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    // 像素密度封顶 1.5 —— 与三维关系网同一个理由：2K/4K 屏按 devicePixelRatio
    // 全量渲染是白烧 GPU，球体和细线在 1.5 倍与 2 倍之间肉眼分不出来。
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    const disposables: { dispose(): void }[] = []

    // ---- 辉光后处理 ----
    // 参数与三维关系网**刻意保持一致**，两处的观感才是同一套东西。
    // 这条长河是手写 renderer（不走 3d-force-graph），所以得自己搭 composer。
    // 后处理不可用就退回直出 —— 能看最重要，别为了一圈光把整张图搞崩。
    let composer: EffectComposer | null = null
    try {
      composer = new EffectComposer(renderer)
      composer.addPass(new RenderPass(scene, camera))
      if (glow) composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.6, 0.82))
      disposables.push(composer)
    } catch {
      composer = null
    }
    const draw = () => {
      if (composer) composer.render()
      else renderer.render(scene, camera)
    }

    // 共享几何体与材质 —— 几百上千个点不能每个都建一套
    const sphereGeo = new THREE.SphereGeometry(1, 20, 14)
    disposables.push(sphereGeo)
    const matCache = new Map<string, THREE.MeshPhongMaterial>()
    const matOf = (color: string, opacity: number) => {
      const key = `${color}@${opacity}`
      let m = matCache.get(key)
      if (!m) {
        m = new THREE.MeshPhongMaterial({
          color: new THREE.Color(color),
          shininess: 55,
          specular: 0x44506a,
          transparent: true,
          opacity,
        })
        matCache.set(key, m)
        disposables.push(m)
      }
      return m
    }

    const pickables: THREE.Mesh[] = []
    for (const n of nodes) {
      const r = n.kind === 'first' ? 6.4 : 4.4
      const mesh = new THREE.Mesh(sphereGeo, matOf(typeColor(n.type), n.kind === 'first' ? 0.98 : 0.66))
      mesh.position.copy(n.pos)
      mesh.scale.setScalar(r)
      mesh.userData.entityId = n.entityId
      mesh.userData.entityName = n.name
      mesh.userData.entityType = n.type
      scene.add(mesh)
      pickables.push(mesh)
      // 只有首次出场挂名字 —— 每个点都挂会糊成一片
      if (n.kind === 'first') {
        const label = makeLabel(n.name.length > 12 ? n.name.slice(0, 12) + '…' : n.name, labelColor, 12)
        label.position.set(n.pos.x, n.pos.y + r + 10, 0)
        scene.add(label)
        disposables.push(label.material.map!, label.material)
      }
    }

    // 同一实体相邻出场连线 —— 断了就是断点
    const linePts: THREE.Vector3[] = []
    for (const list of byEntity.values()) {
      for (let i = 1; i < list.length; i++) {
        linePts.push(list[i - 1].pos, list[i].pos)
      }
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts)
    const lineMat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.55 })
    scene.add(new THREE.LineSegments(lineGeo, lineMat))
    disposables.push(lineGeo, lineMat)

    // 章节刻度：数字 + 一条基准线
    data.chapters.forEach((ch, ci) => {
      const label = makeLabel(ch.chapter, cssColor('--text-faint', '#6b7280'), 15)
      label.position.set(ci * CHAPTER_GAP, BAND_GAP * 0.9, 0)
      scene.add(label)
      disposables.push(label.material.map!, label.material)
    })
    if (data.chapters.length > 0) {
      const axisGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-CHAPTER_GAP * 0.6, BAND_GAP * 0.9, 0),
        new THREE.Vector3((data.chapters.length - 1) * CHAPTER_GAP + CHAPTER_GAP * 0.6, BAND_GAP * 0.9, 0),
      ])
      const axisMat = new THREE.LineBasicMaterial({ color: axisColor, transparent: true, opacity: 0.5 })
      scene.add(new THREE.Line(axisGeo, axisMat))
      disposables.push(axisGeo, axisMat)
    }

    // ---- 光照 ----
    scene.add(new THREE.AmbientLight(0xffffff, 1.9))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(0.4, 1, 0.8)
    scene.add(key)

    // ---- 取景：按包围盒同步算机位（长河横平竖直，直接算最稳） ----
    const fitView = () => {
      const w = host.clientWidth
      const h = host.clientHeight
      camera.aspect = w / Math.max(1, h)
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
      composer?.setSize(w, h)
      if (nodes.length === 0) return
      const box = new THREE.Box3().setFromPoints(nodes.map((n) => n.pos))
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const radius = Math.max(size.x, size.y, 220) / 2
      const dist = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 0.9 + radius * 0.25
      camera.position.set(center.x, center.y, dist)
      controls.target.set(center.x, center.y, 0)
      // 雾跟着机位走：机位多远雾就从多远开始，否则远端线索被雾吞掉
      const fog = scene.fog as THREE.Fog
      fog.near = dist * 1.1
      fog.far = dist * 3.2
      controls.update()
    }
    fitView()
    const ro = new ResizeObserver(fitView)
    ro.observe(host)
    // 调试口：定位取景问题、验收脚本把节点投成屏幕坐标时用
    ;(window as unknown as Record<string, unknown>).__t3d = {
      nodes, camera, scene, fitView,
      projectToScreen: (pos: THREE.Vector3) => {
        const v = pos.clone().project(camera)
        const rect = renderer.domElement.getBoundingClientRect()
        return {
          x: rect.left + ((v.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - v.y) / 2) * rect.height,
          behind: v.z > 1,
        }
      },
    }

    // ---- 点击拾取：点节点打开实体；双击节点 → 就地编辑浮层（P11-B5） ----
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let downAt: { x: number; y: number } | null = null
    const toLocal = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }
    const pickAt = (e: { clientX: number; clientY: number }): THREE.Mesh | null => {
      toLocal(e as PointerEvent)
      raycaster.setFromCamera(pointer, camera)
      return (raycaster.intersectObjects(pickables, false)[0]?.object as THREE.Mesh) ?? null
    }
    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent) => {
      // 拖拽视角的松手不算点击
      if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return
      const hit = pickAt(e)
      if (hit) cbRef.current.onSelectEntity?.(hit.userData.entityId as string)
    }
    const onDbl = (e: MouseEvent) => {
      if (!cbRef.current.editable) return
      const hit = pickAt(e)
      if (!hit) return
      cbRef.current.onNodeEdit?.(
        hit.userData.entityId as string,
        hit.userData.entityName as string,
        { x: e.clientX, y: e.clientY },
        hit.userData.entityType as string,
      )
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('dblclick', onDbl)

    // ---- 渲染循环 ----
    // 不可见就停：dockview 摘掉面板 DOM 时这个循环原本还在跑，
    // 白白占着一个 WebGL 上下文和一份 GPU 时间。
    //
    // 此外这张图**没有力模拟** —— 摆好之后就是一帧静态图，常驻 60fps 纯属白烧
    // （P4.5.5）。所以「可见」之外再加一道「有事可做」：
    //   · 刚有过鼠标/滚轮交互（拖视角、缩放都得有帧才动得起来）
    //   · 相机还在滑行 —— 开了 enableDamping，松手之后它自己还会飘一段，
    //     这个没法从事件里知道，只能每拍看一眼相机动没动，动了就续命。
    // 两样都没有就睡。唤醒由下面的 wake() 负责，手感不受影响。
    let raf = 0
    let running = false
    let wakeUntil = 0
    let lastCam = ''
    /** 最近一次真实输入的时刻：阻尼滑行的续命不能越过它 + 1.6s */
    let lastInputAt = 0
    const tick = () => {
      if (disposed) return
      controls.update()
      draw()
      const cam =
        camera.position.toArray().map((v) => v.toFixed(2)).join(',') +
        '|' +
        controls.target.toArray().map((v) => v.toFixed(2)).join(',')
      if (cam !== lastCam) {
        lastCam = cam
        // 相机还在动（阻尼滑行）就续命。但阻尼是指数衰减，**理论上永远差那么
        // 一点点到不了 0** —— 光看「还在动」就无限续命，一次稍快的拖拽能让它
        // 白跑五六秒。所以给它一个硬顶：最近一次真实输入的 1.6 秒之后，
        // 哪怕还差半个像素也不再陪它跑，那点残余肉眼根本看不出来。
        wakeUntil = Math.min(Date.now() + 200, lastInputAt + 1600)
      }
      if (Date.now() >= wakeUntil) {
        running = false
        raf = 0
        return
      }
      raf = requestAnimationFrame(tick)
    }
    const start = () => {
      if (running || disposed) return
      running = true
      wakeUntil = Math.max(wakeUntil, Date.now() + 420)
      tick()
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
      raf = 0
    }
    const wake = () => {
      lastInputAt = Date.now()
      wakeUntil = Date.now() + 420
      if (!running && !disposed) {
        running = true
        tick()
      }
    }
    start()
    const io = new IntersectionObserver(
      ([e]) => (e?.isIntersecting ? start() : stop()),
      { threshold: 0 },
    )
    io.observe(host)
    // 捕获阶段挂：拖视角、缩放、哪怕只是划过，都得立刻有帧，否则就是「卡住了」
    renderer.domElement.addEventListener('pointerdown', wake, true)
    renderer.domElement.addEventListener('pointermove', wake, true)
    renderer.domElement.addEventListener('wheel', wake, { passive: true, capture: true })

    return () => {
      disposed = true
      io.disconnect()
      stop()
      renderer.domElement.removeEventListener('pointerdown', wake, true)
      renderer.domElement.removeEventListener('pointermove', wake, true)
      renderer.domElement.removeEventListener('wheel', wake, true)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('dblclick', onDbl)
      controls.dispose()
      for (const d of disposables) {
        try {
          d.dispose()
        } catch {
          /* 已释放就算了 */
        }
      }
      renderer.dispose()
      host.removeChild(renderer.domElement)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, themeKey, glow])

  return <div ref={hostRef} className="graph3d graph3d--timeline" />
}
