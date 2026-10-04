#!/usr/bin/env node
/**
 * Download a narrow corridor tile pack along the 西成客专 polyline.
 * Source: OSM.fr (Carto dark_all is often watermarked / key-gated).
 * Keep zoom low enough that the repo stays buildable.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const GEO = path.join(ROOT, 'public', 'd1975.geojson')
const OUT = path.join(ROOT, 'public', 'tiles')

const MIN_Z = 6
const MAX_Z = 10
const OSM_FR = ['https://a.tile.openstreetmap.fr/osmfr', 'https://b.tile.openstreetmap.fr/osmfr', 'https://c.tile.openstreetmap.fr/osmfr']

function lon2x(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}
function lat2y(lat, z) {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
}

function sampleSpine(coords, step = 8) {
  const pts = []
  for (let i = 0; i < coords.length; i += step) pts.push(coords[i])
  if (pts[pts.length - 1] !== coords[coords.length - 1]) pts.push(coords[coords.length - 1])
  return pts
}

function tilesForPoint(lon, lat, z, pad) {
  const x = lon2x(lon, z)
  const y = lat2y(lat, z)
  const out = []
  for (let dx = -pad; dx <= pad; dx++) {
    for (let dy = -pad; dy <= pad; dy++) {
      const xx = x + dx
      const yy = y + dy
      const max = 2 ** z
      if (xx < 0 || yy < 0 || xx >= max || yy >= max) continue
      out.push(`${z}/${xx}/${yy}`)
    }
  }
  return out
}

async function download(url, dest) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'd1975view/1.0 (educational corridor pack; OSM.fr)' },
  })
  if (!resp.ok) throw new Error(`${resp.status} ${url}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length < 80) throw new Error(`tiny ${url}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, buf)
}

async function main() {
  const geo = JSON.parse(fs.readFileSync(GEO, 'utf8'))
  const spine = geo.features.find((f) => f.geometry.type === 'LineString')
  if (!spine) throw new Error('missing spine')
  const coords = spine.geometry.coordinates
  const samples = sampleSpine(coords, 12)

  const keys = new Set()
  for (let z = MIN_Z; z <= MAX_Z; z++) {
    const pad = z <= 8 ? 1 : 1
    for (const [lon, lat] of samples) {
      for (const k of tilesForPoint(lon, lat, z, pad)) keys.add(k)
    }
  }

  const list = [...keys].sort()
  console.log(`Downloading ${list.length} OSM.fr tiles z${MIN_Z}-${MAX_Z} along corridor`)
  let ok = 0
  let fail = 0
  for (let i = 0; i < list.length; i++) {
    const key = list[i]
    const dest = path.join(OUT, `${key}.png`)
    if (fs.existsSync(dest) && fs.statSync(dest).size > 80) {
      ok++
      continue
    }
    const host = OSM_FR[i % OSM_FR.length]
    try {
      await download(`${host}/${key}.png`, dest)
      ok++
    } catch (e) {
      fail++
      console.warn('fail', key, e.message)
    }
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 120))
    else await new Promise((r) => setTimeout(r, 40))
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${list.length}`)
  }

  const written = list.filter((k) => fs.existsSync(path.join(OUT, `${k}.png`)))
  const manifest = {
    source: 'OpenStreetMap France (osmfr)',
    generated: new Date().toISOString(),
    minZoom: MIN_Z,
    maxZoom: MAX_Z,
    tileCount: written.length,
    tiles: written,
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest))
  console.log(`Wrote ${written.length} tiles, ${fail} failed`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
