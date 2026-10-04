import L from 'leaflet'

const CACHE_NAME = 'd1975-tiles'
const CARTO = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const OSM_FR = 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png'
const OSM = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

type Manifest = { tiles: string[]; minZoom: number; maxZoom: number }

let manifestPromise: Promise<Set<string>> | null = null

export function resolveAssetUrl(relPath: string): string {
  const cleaned = String(relPath || '').replace(/^\.\//, '').replace(/^\//, '')
  const base = import.meta.env.BASE_URL || './'
  try {
    if (base.startsWith('http://') || base.startsWith('https://') || base.startsWith('/')) {
      return new URL(cleaned, base.endsWith('/') ? base : `${base}/`).href
    }
    return new URL(`${base}${cleaned}`, window.location.href).href
  } catch {
    return `./${cleaned}`
  }
}

function cacheKey(z: number, x: number, y: number): string {
  return `https://d1975.local/tiles/${z}/${x}/${y}.png`
}

function remoteUrl(template: string, z: number, x: number, y: number, sub: string): string {
  return template
    .replace('{s}', sub)
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{r}', '')
}

async function loadManifest(): Promise<Set<string>> {
  if (!manifestPromise) {
    manifestPromise = fetch(resolveAssetUrl('tiles/manifest.json'))
      .then((r) => (r.ok ? r.json() : { tiles: [] }))
      .then((data: Manifest) => new Set(data.tiles || []))
      .catch(() => new Set<string>())
  }
  return manifestPromise
}

function probeImage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(url)
    img.onerror = () => reject(new Error(url))
    img.referrerPolicy = 'no-referrer'
    img.src = url
  })
}

async function fetchAndCache(url: string, z: number, x: number, y: number): Promise<string> {
  const resp = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer' })
  if (!resp.ok) throw new Error(`tile ${resp.status}`)
  const blob = await resp.blob()
  if (blob.size < 80) throw new Error('empty tile')
  try {
    const cache = await caches.open(CACHE_NAME)
    await cache.put(cacheKey(z, x, y), new Response(blob, { headers: { 'Content-Type': 'image/png' } }))
  } catch {
    /* Cache API may be unavailable on file:// */
  }
  return URL.createObjectURL(blob)
}

async function fromCache(z: number, x: number, y: number): Promise<string | null> {
  try {
    const cache = await caches.open(CACHE_NAME)
    const hit = await cache.match(cacheKey(z, x, y))
    if (!hit) return null
    const blob = await hit.blob()
    if (blob.size < 80) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

async function resolveTileSrc(z: number, x: number, y: number): Promise<string> {
  const key = `${z}/${x}/${y}`
  const bundled = resolveAssetUrl(`tiles/${z}/${x}/${y}.png`)
  const manifest = await loadManifest()
  if (manifest.has(key)) {
    try {
      return await probeImage(bundled)
    } catch {
      /* fall through */
    }
  }

  const cached = await fromCache(z, x, y)
  if (cached) return cached

  const cartoS = ['a', 'b', 'c', 'd'][Math.abs(x + y) % 4]
  const osmS = ['a', 'b', 'c'][Math.abs(x + y) % 3]
  const remotes = [
    remoteUrl(CARTO, z, x, y, cartoS),
    remoteUrl(OSM_FR, z, x, y, osmS),
    remoteUrl(OSM, z, x, y, osmS),
  ]
  for (const url of remotes) {
    try {
      return await fetchAndCache(url, z, x, y)
    } catch {
      try {
        return await probeImage(url)
      } catch {
        /* next source */
      }
    }
  }
  throw new Error(`no tile ${key}`)
}

class CorridorTileLayer extends L.GridLayer {
  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile = document.createElement('img')
    tile.alt = ''
    tile.setAttribute('role', 'presentation')
    resolveTileSrc(coords.z, coords.x, coords.y)
      .then((src) => {
        tile.onload = () => done(null, tile)
        tile.onerror = () => done(new Error('tile'), tile)
        tile.src = src
      })
      .catch((err) => done(err instanceof Error ? err : new Error('tile'), tile))
    return tile
  }
}

export function createBaseTiles(): L.GridLayer {
  return new CorridorTileLayer({
    minZoom: 6,
    maxZoom: 18,
    tileSize: 256,
    attribution: '',
  })
}
