import { Capacitor } from '@capacitor/core'
import { Geolocation, type Position } from '@capacitor/geolocation'

export interface LocateDebugEntry {
  t: number
  kind: string
  detail: string
}

const history: LocateDebugEntry[] = []
const listeners = new Set<(entry: LocateDebugEntry) => void>()

export function recordLocateDebug(kind: string, detail: string) {
  const entry: LocateDebugEntry = { t: Date.now(), kind, detail }
  history.push(entry)
  if (history.length > 80) history.shift()
  listeners.forEach((fn) => fn(entry))
}

export function createLocateDebugView(root: HTMLElement) {
  root.innerHTML = `
    <div class="debug-scroll">
      <p class="debug-lead">定位超时就看这一页。先点「检查权限」，再点「高精度定位」。把日志截图发过来。</p>
      <section class="debug-card">
        <h2>环境</h2>
        <p id="debug-env" class="debug-mono"></p>
      </section>
      <section class="debug-card">
        <h2>权限</h2>
        <p id="debug-perm" class="debug-mono">还没查</p>
        <div class="debug-actions">
          <button type="button" id="debug-check">检查权限</button>
          <button type="button" id="debug-ask">请求权限</button>
        </div>
      </section>
      <section class="debug-card">
        <h2>单次定位</h2>
        <div class="debug-actions">
          <button type="button" id="debug-low">低精度</button>
          <button type="button" id="debug-high">高精度</button>
          <button type="button" id="debug-browser">系统定位</button>
        </div>
      </section>
      <section class="debug-card">
        <h2>持续监听</h2>
        <div class="debug-actions">
          <button type="button" id="debug-watch">监听 20 秒</button>
          <button type="button" id="debug-stop">停止</button>
        </div>
      </section>
      <section class="debug-card">
        <h2>最近一次成功</h2>
        <p id="debug-last" class="debug-mono">还没有</p>
      </section>
      <section class="debug-card">
        <h2>日志</h2>
        <div class="debug-actions">
          <button type="button" id="debug-clear">清空</button>
        </div>
        <ol id="debug-log" class="debug-log"></ol>
      </section>
    </div>
  `

  const envEl = root.querySelector<HTMLElement>('#debug-env')!
  const permEl = root.querySelector<HTMLElement>('#debug-perm')!
  const lastEl = root.querySelector<HTMLElement>('#debug-last')!
  const logEl = root.querySelector<HTMLOListElement>('#debug-log')!
  let watchId: string | null = null
  let browserWatch: number | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null

  envEl.textContent = [
    `平台 ${Capacitor.getPlatform()}`,
    `原生 ${Capacitor.isNativePlatform() ? '是' : '否'}`,
    `浏览器定位 ${'geolocation' in navigator ? '有' : '没有'}`,
    navigator.userAgent,
  ].join('\n')

  function paint() {
    logEl.replaceChildren()
    for (const entry of [...history].reverse()) {
      const li = document.createElement('li')
      const time = new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false })
      li.textContent = `${time}  ${entry.kind}  ${entry.detail}`
      logEl.appendChild(li)
    }
  }

  function remember(pos: Position | GeolocationPosition) {
    const c = pos.coords
    const age = pos.timestamp ? Math.round((Date.now() - pos.timestamp) / 1000) : null
    lastEl.textContent = [
      `纬度 ${c.latitude.toFixed(6)}`,
      `经度 ${c.longitude.toFixed(6)}`,
      `精度 ${Math.round(c.accuracy)} 米`,
      `海拔 ${c.altitude == null ? '无' : Math.round(c.altitude) + ' 米'}`,
      `速度 ${c.speed == null ? '无' : (c.speed * 3.6).toFixed(1) + ' km/h'}`,
      `方向 ${c.heading == null ? '无' : Math.round(c.heading) + '°'}`,
      `时间 ${pos.timestamp ? new Date(pos.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '无'}`,
      `距今 ${age == null ? '无' : age + ' 秒'}`,
    ].join('\n')
  }

  listeners.add(() => paint())
  paint()
  recordLocateDebug('调试页', '已打开')

  async function run(kind: string, budgetMs: number, task: () => Promise<Position | GeolocationPosition | string>) {
    const started = Date.now()
    recordLocateDebug(kind, '开始')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        task(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`等了 ${budgetMs / 1000} 秒，插件没有回调`)), budgetMs)
        }),
      ])
      const ms = Date.now() - started
      if (typeof result === 'string') {
        recordLocateDebug(kind, `成功 ${ms} 毫秒  ${result}`)
        return
      }
      remember(result)
      const c = result.coords
      recordLocateDebug(
        kind,
        `成功 ${ms} 毫秒  ${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}  精度 ${Math.round(c.accuracy)} 米`
      )
    } catch (err) {
      recordLocateDebug(kind, `失败 ${Date.now() - started} 毫秒  ${formatErr(err)}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  root.querySelector('#debug-check')!.addEventListener('click', () => {
    run('检查权限', 8000, async () => {
      const status = await Geolocation.checkPermissions()
      const text = `精确 ${status.location}，粗略 ${status.coarseLocation}`
      permEl.textContent = text
      return text
    })
  })

  root.querySelector('#debug-ask')!.addEventListener('click', () => {
    run('请求权限', 20000, async () => {
      const status = await Geolocation.requestPermissions()
      const text = `精确 ${status.location}，粗略 ${status.coarseLocation}`
      permEl.textContent = text
      return text
    })
  })

  root.querySelector('#debug-low')!.addEventListener('click', () => {
    run('低精度', 10000, () =>
      Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 })
    )
  })

  root.querySelector('#debug-high')!.addEventListener('click', () => {
    run('高精度', 15000, () =>
      Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 0 })
    )
  })

  root.querySelector('#debug-browser')!.addEventListener('click', () => {
    run('系统定位', 10000, () => new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('这个页面没有系统定位'))
        return
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 8000,
        maximumAge: 60000,
      })
    }))
  })

  function clearWatch() {
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
    if (watchId) {
      Geolocation.clearWatch({ id: watchId }).catch((err) => {
        recordLocateDebug('监听', `停止失败  ${formatErr(err)}`)
      })
      watchId = null
    }
    if (browserWatch != null) {
      navigator.geolocation.clearWatch(browserWatch)
      browserWatch = null
    }
  }

  root.querySelector('#debug-watch')!.addEventListener('click', () => {
    clearWatch()
    recordLocateDebug('监听', '开始，最多 20 秒')
    if (Capacitor.isNativePlatform()) {
      Geolocation.watchPosition(
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000, minimumUpdateInterval: 1000 },
        (pos, err) => {
          if (err || !pos) {
            recordLocateDebug('监听', `回调失败  ${formatErr(err)}`)
            return
          }
          remember(pos)
          recordLocateDebug(
            '监听',
            `更新  ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}  精度 ${Math.round(pos.coords.accuracy)} 米`
          )
        }
      ).then((id) => {
        watchId = id
        recordLocateDebug('监听', `已注册 ${id}`)
      }).catch((err) => {
        recordLocateDebug('监听', `注册失败  ${formatErr(err)}`)
      })
    } else if ('geolocation' in navigator) {
      browserWatch = navigator.geolocation.watchPosition(
        (pos) => {
          remember(pos)
          recordLocateDebug(
            '监听',
            `更新  ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}  精度 ${Math.round(pos.coords.accuracy)} 米`
          )
        },
        (err) => recordLocateDebug('监听', `回调失败  ${formatErr(err)}`),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
      )
    } else {
      recordLocateDebug('监听', '没有可用的定位接口')
    }
    stopTimer = setTimeout(() => {
      clearWatch()
      recordLocateDebug('监听', '20 秒到了，已停止')
    }, 20000)
  })

  root.querySelector('#debug-stop')!.addEventListener('click', () => {
    clearWatch()
    recordLocateDebug('监听', '手动停止')
  })

  root.querySelector('#debug-clear')!.addEventListener('click', () => {
    history.splice(0, history.length)
    paint()
  })

  return {
    setVisible(on: boolean) {
      root.classList.toggle('hidden', !on)
    },
  }
}

function formatErr(err: unknown): string {
  if (err == null) return '空错误'
  if (typeof err !== 'object') return String(err)
  const o = err as { code?: unknown; message?: unknown; name?: unknown }
  const bits: string[] = []
  if (o.code != null) bits.push(`代码 ${String(o.code)}`)
  if (o.name) bits.push(String(o.name))
  if (o.message) bits.push(String(o.message))
  return bits.join(' ') || '未知错误'
}
