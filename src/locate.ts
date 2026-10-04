import L from 'leaflet'
import { Capacitor } from '@capacitor/core'
import { Geolocation, type PermissionStatus } from '@capacitor/geolocation'
import { haversineM } from './geo.ts'
import { recordLocateDebug } from './locateDebug.ts'

export type LocateState = 'idle' | 'locating' | 'following' | 'located'

export interface LocatePosition {
  lat: number
  lng: number
  accuracy: number
  /** km/h from successive GPS samples; null until the first 3-minute pair. */
  speedKmh: number | null
}

export interface LocateController {
  getState: () => LocateState
  getLastPosition: () => LocatePosition | null
  toggle: () => Promise<void>
  stop: () => void
  destroy: () => void
}

const LOCATE_TIMEOUT_MS = 12000
const SPEED_INTERVAL_MS = 3 * 60 * 1000

function isPermissionGranted(status: PermissionStatus): boolean {
  return status.location === 'granted' || status.coarseLocation === 'granted'
}

async function ensurePermission(): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      let status = await Geolocation.checkPermissions()
      if (!isPermissionGranted(status)) {
        status = await Geolocation.requestPermissions()
      }
      return isPermissionGranted(status)
    }
    if (!('geolocation' in navigator)) return false
    return true
  } catch (e) {
    console.error('[Locate] Permission check/request failed:', e)
    throw e
  }
}

function permissionDeniedMessage(err?: GeolocationPositionError | Error | null): string {
  if (err && 'code' in err && err.code === 1) return '请允许位置权限后重试'
  if (err && err.message && /denied|permission/i.test(err.message)) return '请允许位置权限后重试'
  if (err && 'code' in err && err.code === 2) return '定位服务不可用'
  if (err && 'code' in err && err.code === 3) return '定位超时'
  return '无法获取位置'
}

export function createLocateControl(
  map: L.Map,
  opts: {
    button: HTMLButtonElement
    label: HTMLElement
    toast: (msg: string) => void
    onPosition?: (pos: LocatePosition | null) => void
  }
): LocateController {
  let state: LocateState = 'idle'
  let watchId: string | number | null = null
  let marker: L.Marker | null = null
  let accuracyCircle: L.Circle | null = null
  let follow = false
  let programmaticMove = false
  let lastLatLng: L.LatLng | null = null
  let lastAccuracy = 0
  let locateTimeoutId: ReturnType<typeof setTimeout> | null = null
  let abortLocating = false
  let pollIntervalId: ReturnType<typeof setInterval> | null = null
  const POLL_INTERVAL_MS = 1000
  let pollInFlight = false
  let speedSample: { lat: number; lng: number; t: number } | null = null
  let lastSpeedKmh: number | null = null
  let speedTimerId: ReturnType<typeof setInterval> | null = null

  const userIcon = L.divIcon({
    className: 'user-location-marker',
    html: '<div class="user-location-dot"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })

  function emitPosition() {
    if (!opts.onPosition) return
    if (!lastLatLng) {
      opts.onPosition(null)
      return
    }
    opts.onPosition({
      lat: lastLatLng.lat,
      lng: lastLatLng.lng,
      accuracy: lastAccuracy,
      speedKmh: lastSpeedKmh,
    })
  }

  function noteSpeedSample(lat: number, lng: number) {
    const now = Date.now()
    if (!speedSample) {
      speedSample = { lat, lng, t: now }
      return
    }
    if (now - speedSample.t < SPEED_INTERVAL_MS) return
    const distM = haversineM(
      { lat: speedSample.lat, lon: speedSample.lng },
      { lat, lon: lng }
    )
    const hours = (now - speedSample.t) / 3_600_000
    if (hours > 0) lastSpeedKmh = distM / 1000 / hours
    speedSample = { lat, lng, t: now }
  }

  function startSpeedTimer() {
    if (speedTimerId !== null) return
    speedTimerId = setInterval(() => {
      if (!lastLatLng) return
      noteSpeedSample(lastLatLng.lat, lastLatLng.lng)
      emitPosition()
    }, SPEED_INTERVAL_MS)
  }

  function stopSpeedTimer() {
    if (speedTimerId !== null) {
      clearInterval(speedTimerId)
      speedTimerId = null
    }
    speedSample = null
    lastSpeedKmh = null
  }

  function setState(next: LocateState) {
    recordLocateDebug('状态', next)
    state = next
    opts.button.classList.toggle('active', next === 'following')
    opts.button.classList.toggle('located', next === 'located' || next === 'following')
    opts.button.setAttribute('aria-pressed', next === 'following' ? 'true' : 'false')
    if (next === 'idle') {
      opts.label.textContent = '定位'
      opts.button.title = '定位 / 跟随我'
    } else if (next === 'locating') {
      opts.label.textContent = '定位中'
      opts.button.title = '点击取消定位'
    } else if (next === 'following') {
      opts.label.textContent = '跟随中'
      opts.button.title = '点击停止跟随'
    } else {
      opts.label.textContent = '跟随我'
      opts.button.title = '点击跟随我的位置'
    }
  }

  function clearLocateTimeout() {
    if (locateTimeoutId !== null) {
      clearTimeout(locateTimeoutId)
      locateTimeoutId = null
    }
  }

  function updateMarker(lat: number, lng: number, accuracy: number) {
    const latlng = L.latLng(lat, lng)
    lastLatLng = latlng
    lastAccuracy = accuracy
    noteSpeedSample(lat, lng)
    if (!marker) {
      marker = L.marker(latlng, { icon: userIcon, zIndexOffset: 1000, interactive: false }).addTo(map)
    } else {
      marker.setLatLng(latlng)
    }
    if (!accuracyCircle) {
      accuracyCircle = L.circle(latlng, {
        radius: Math.max(accuracy || 0, 8),
        color: '#2A93EE',
        weight: 1,
        opacity: 0.6,
        fillColor: '#2A93EE',
        fillOpacity: 0.15,
        interactive: false,
      }).addTo(map)
    } else {
      accuracyCircle.setLatLng(latlng)
      accuracyCircle.setRadius(Math.max(accuracy || 0, 8))
    }
    emitPosition()
  }

  function centerOnUser(zoom?: number) {
    if (!lastLatLng) return
    programmaticMove = true
    const z = zoom ?? Math.max(map.getZoom(), Math.min(14, map.getMaxZoom()))
    map.setView(lastLatLng, z, { animate: true })
    map.once('moveend', () => {
      programmaticMove = false
    })
  }

  function onInitialPosition(lat: number, lng: number, accuracy: number) {
    clearLocateTimeout()
    if (abortLocating || state !== 'locating') {
      console.log('[Locate] Position received but locate was cancelled')
      return
    }
    updateMarker(lat, lng, accuracy)
    follow = true
    setState('following')
    centerOnUser()
    startWatchForFollow()
    startPolling()
    startSpeedTimer()
  }

  function onWatchPosition(lat: number, lng: number, accuracy: number) {
    const prev = lastLatLng
    updateMarker(lat, lng, accuracy)
    if (!follow || state !== 'following' || !lastLatLng) return
    if (prev && prev.distanceTo(lastLatLng) < 8) return
    programmaticMove = true
    map.panTo(lastLatLng, { animate: false })
    programmaticMove = false
  }

  function onError(err: GeolocationPositionError | Error | null, isTimeout = false) {
    clearLocateTimeout()
    const msg = isTimeout ? '定位超时，请检查系统定位是否开启' : permissionDeniedMessage(err)
    opts.toast(msg)
    if (state === 'locating') {
      stopWatch()
      setState('idle')
    }
  }

  async function getInitialPosition(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('没有系统定位'))
        return
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? 0,
        }),
        (err) => reject(err),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
      )
    })
  }

  function startWatchForFollow() {
    if (watchId !== null) return
    console.log('[Locate] Starting watch for continuous updates')
    try {
      if (!('geolocation' in navigator)) return
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          recordLocateDebug('跟随', `系统更新 ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)} 精度 ${Math.round(position.coords.accuracy)} 米`)
          onWatchPosition(position.coords.latitude, position.coords.longitude, position.coords.accuracy ?? 0)
        },
        (err) => recordLocateDebug('跟随', `系统监听失败 ${err.message}`),
        { enableHighAccuracy: false, maximumAge: 10000, timeout: 8000 }
      )
    } catch (e) {
      console.warn('[Locate] startWatchForFollow failed:', e)
    }
  }

  function stopPolling() {
    if (pollIntervalId !== null) {
      clearInterval(pollIntervalId)
      pollIntervalId = null
      console.log('[Locate] Polling stopped')
    }
  }

  function doPollTick() {
    console.log('[Locate] Poll tick, state:', state)
    
    if (lastLatLng) {
      emitPosition()
    }
    
    if (state !== 'following' && state !== 'located') {
      console.log('[Locate] Poll: not in active state, skipping GPS fetch')
      return
    }
    
    if (pollInFlight) return
    pollInFlight = true
    const done = () => {
      pollInFlight = false
    }
    if (!('geolocation' in navigator)) {
      done()
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        recordLocateDebug('跟随', `轮询 ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)} 精度 ${Math.round(pos.coords.accuracy)} 米`)
        onWatchPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? 0)
        done()
      },
      (err) => {
        recordLocateDebug('跟随', `轮询失败 ${err.message}`)
        if (lastLatLng) emitPosition()
        done()
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 10000 }
    )
  }

  function startPolling() {
    if (pollIntervalId !== null) {
      console.log('[Locate] Polling already running')
      return
    }
    console.log('[Locate] Starting position polling every', POLL_INTERVAL_MS, 'ms')
    doPollTick()
    pollIntervalId = setInterval(doPollTick, POLL_INTERVAL_MS)
  }

  async function startLocate() {
    abortLocating = false
    setState('locating')
    
    let ok = false
    try {
      ok = await ensurePermission()
    } catch (e) {
      console.error('[Locate] ensurePermission failed:', e)
      opts.toast('定位权限检查失败')
      setState('idle')
      return
    }
    
    if (!ok) {
      recordLocateDebug('权限', '没有位置权限')
      opts.toast('请允许位置权限后重试')
      setState('idle')
      return
    }
    recordLocateDebug('权限', '已允许')

    if (abortLocating) {
      console.log('[Locate] Locate aborted after permission check')
      setState('idle')
      return
    }

    locateTimeoutId = setTimeout(() => {
      if (state === 'locating') {
        console.warn('[Locate] Client-side timeout reached')
        recordLocateDebug('首次定位', '12 秒到了还没有位置')
        onError(null, true)
      }
    }, LOCATE_TIMEOUT_MS)

    try {
      const pos = await getInitialPosition()
      if (pos && !abortLocating) {
        recordLocateDebug('首次定位', `成功 ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} 精度 ${Math.round(pos.accuracy)} 米`)
        onInitialPosition(pos.lat, pos.lng, pos.accuracy)
      }
    } catch (e) {
      if (!abortLocating) {
        console.error('[Locate] getInitialPosition failed:', e)
        recordLocateDebug('首次定位', `失败 ${e instanceof Error ? e.message : String(e)}`)
        onError(e instanceof Error ? e : null)
      }
    }
  }

  function stopWatch() {
    clearLocateTimeout()
    stopPolling()
    stopSpeedTimer()
    if (watchId != null) {
      if (Capacitor.isNativePlatform() && typeof watchId === 'string') {
        Geolocation.clearWatch({ id: watchId }).catch(() => {})
      } else if (typeof watchId === 'number') {
        navigator.geolocation.clearWatch(watchId)
      }
      watchId = null
    }
    follow = false
  }

  function clearMarkers() {
    if (marker) {
      map.removeLayer(marker)
      marker = null
    }
    if (accuracyCircle) {
      map.removeLayer(accuracyCircle)
      accuracyCircle = null
    }
    lastLatLng = null
    lastAccuracy = 0
    emitPosition()
  }

  function cancelLocate() {
    console.log('[Locate] User cancelled locating')
    abortLocating = true
    clearLocateTimeout()
    stopWatch()
    setState('idle')
    opts.toast('已取消定位')
  }

  function stop() {
    abortLocating = true
    stopWatch()
    clearMarkers()
    setState('idle')
  }

  async function toggle() {
    try {
      if (state === 'idle') {
        await startLocate()
        return
      }
      if (state === 'locating') {
        cancelLocate()
        return
      }
      if (state === 'following') {
        follow = false
        setState('located')
        return
      }
      follow = true
      setState('following')
      centerOnUser()
      if (watchId === null) {
        startWatchForFollow()
      }
    } catch (e) {
      console.error('[Locate] toggle error:', e)
      opts.toast('定位功能出错')
      setState('idle')
    }
  }

  const onUserMove = () => {
    if (programmaticMove) return
    if (follow && state === 'following') {
      follow = false
      setState('located')
    }
  }
  map.on('dragstart', onUserMove)

  setState('idle')

  return {
    getState: () => state,
    getLastPosition: () =>
      lastLatLng
        ? { lat: lastLatLng.lat, lng: lastLatLng.lng, accuracy: lastAccuracy, speedKmh: lastSpeedKmh }
        : null,
    toggle,
    stop,
    destroy: () => {
      map.off('dragstart', onUserMove)
      stop()
    },
  }
}
