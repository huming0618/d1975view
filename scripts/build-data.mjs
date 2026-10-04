#!/usr/bin/env node
/**
 * Build D1975 static data from OSM 西成客专线 + Open-Meteo + Overpass rivers.
 *
 * Stops (西安北 = 0 km): 西安北, 西安西, 洋县西, 汉中, 广元, 绵阳, 德阳, 成都东
 * September 2026 timetable (hao86 / 车主手册): 洋县西, not 佛坪.
 * Keep 西安西 (hao86 still lists it). Do not draw 佛坪 as a stop.
 * Chainage is kilometres along the railway polyline.
 * Elevation is sampled on that same polyline (not station-to-station chords).
 * Rivers: only waterways the line actually crosses.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const RAW_PATH = process.env.D1975_OSM_RAW || '/tmp/d1975-osm-raw.json'
const PUBLIC = path.join(ROOT, 'public')

const STATIONS = [
  { name: '西安北', lat: 34.3776675, lon: 108.9340253, osmId: 4185074601, order: 1 },
  { name: '西安西', lat: 34.2712527, lon: 108.7516022, osmId: 5762027860, order: 2, formerName: '阿房宫' },
  { name: '洋县西', lat: 33.2287078, lon: 107.5185584, osmId: 3826011104, order: 3 },
  { name: '汉中', lat: 33.0929325, lon: 107.0255229, osmId: 9295305367, order: 4 },
  { name: '广元', lat: 32.4526584, lon: 105.8179671, osmId: 1532826989, order: 5 },
  { name: '绵阳', lat: 31.4621298, lon: 104.714631, osmId: 1742504939, order: 6 },
  { name: '德阳', lat: 31.1683508, lon: 104.3864117, osmId: 2099675139, order: 7 },
  { name: '成都东', lat: 30.6312977, lon: 104.1389215, osmId: 7212021583, order: 8 },
]

const EARTH_R = 6371000
const MAX_GRADE_PERMILLE = 30
const SAMPLE_INTERVAL_KM = 1
const OPEN_METEO = 'https://api.open-meteo.com/v1/elevation'
const OVERPASS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

function toRad(d) {
  return (d * Math.PI) / 180
}
function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)))
}
function toXY(p, lat0) {
  const cos = Math.cos(toRad(lat0))
  return { x: toRad(p.lon) * EARTH_R * cos, y: toRad(p.lat) * EARTH_R }
}
function fromXY(xy, lat0) {
  const cos = Math.cos(toRad(lat0))
  return { lat: (xy.y / EARTH_R) * (180 / Math.PI), lon: (xy.x / (EARTH_R * cos)) * (180 / Math.PI) }
}
function nearestOnSegment(p, a, b) {
  const lat0 = (a.lat + b.lat + p.lat) / 3
  const P = toXY(p, lat0)
  const A = toXY(a, lat0)
  const B = toXY(b, lat0)
  const dx = B.x - A.x
  const dy = B.y - A.y
  const len2 = dx * dx + dy * dy
  let t = 0
  if (len2 > 1e-6) t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2))
  const Q = { x: A.x + t * dx, y: A.y + t * dy }
  const q = fromXY(Q, lat0)
  return { ...q, t, distM: Math.hypot(P.x - Q.x, P.y - Q.y) }
}

function nearestOnPolyline(p, coords) {
  let best = null
  let bestI = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const hit = nearestOnSegment(p, coords[i], coords[i + 1])
    if (!best || hit.distM < best.distM) {
      best = hit
      bestI = i
    }
  }
  return { ...best, segIndex: bestI }
}

function cumulativeKm(coords) {
  const out = [{ ...coords[0], km: 0 }]
  let km = 0
  for (let i = 1; i < coords.length; i++) {
    km += haversineM(coords[i - 1], coords[i]) / 1000
    out.push({ ...coords[i], km })
  }
  return out
}

function kmAtPoint(chain, p) {
  const hit = nearestOnPolyline(p, chain)
  const a = chain[hit.segIndex]
  const b = chain[hit.segIndex + 1]
  return a.km + hit.t * (b.km - a.km)
}

function slicePolyline(coords, startHit, endHit) {
  const startFirst = startHit.segIndex < endHit.segIndex ||
    (startHit.segIndex === endHit.segIndex && startHit.t <= endHit.t)
  const a = startFirst ? startHit : endHit
  const b = startFirst ? endHit : startHit
  const out = [{ lat: a.lat, lon: a.lon }]
  for (let i = a.segIndex + 1; i <= b.segIndex; i++) out.push(coords[i])
  out.push({ lat: b.lat, lon: b.lon })
  const dedup = [out[0]]
  for (let i = 1; i < out.length; i++) {
    if (haversineM(dedup[dedup.length - 1], out[i]) > 1) dedup.push(out[i])
  }
  return startFirst ? dedup : dedup.reverse()
}

function pointAtKm(chain, km) {
  if (km <= 0) return { lat: chain[0].lat, lon: chain[0].lon }
  const last = chain[chain.length - 1]
  if (km >= last.km) return { lat: last.lat, lon: last.lon }
  for (let i = 0; i < chain.length - 1; i++) {
    if (km >= chain[i].km && km <= chain[i + 1].km) {
      const span = chain[i + 1].km - chain[i].km
      const t = span < 1e-9 ? 0 : (km - chain[i].km) / span
      return {
        lat: chain[i].lat + t * (chain[i + 1].lat - chain[i].lat),
        lon: chain[i].lon + t * (chain[i + 1].lon - chain[i].lon),
      }
    }
  }
  return { lat: last.lat, lon: last.lon }
}

function isXichengName(name) {
  if (!name) return false
  return (
    name === '西成客专线' ||
    name === '西成客运专线' ||
    name === '西成高速铁路' ||
    name === '西成高速线' ||
    name === "Xi'an-Chengdu Passenger Railway"
  )
}

function stitchXicheng(ways) {
  const xian = STATIONS[0]
  const chengdu = STATIONS[STATIONS.length - 1]

  let candidates = ways.filter((w) => isXichengName(w.tags?.name) || isXichengName(w.tags?.['name:zh']) || isXichengName(w.tags?.['name:en']))
  if (candidates.length === 0) throw new Error('No 西成客专线 ways')

  const SNAP_M = 30
  const nodes = []
  function snapNode(p) {
    for (const n of nodes) {
      if (haversineM(n, p) <= SNAP_M) return n.id
    }
    const id = nodes.length
    nodes.push({ id, lat: p.lat, lon: p.lon })
    return id
  }

  const edges = []
  for (const w of candidates) {
    const g = (w.geometry || []).map((p) => ({ lat: p.lat, lon: p.lon }))
    if (g.length < 2) continue
    const a = snapNode(g[0])
    const b = snapNode(g[g.length - 1])
    let len = 0
    for (let i = 0; i < g.length - 1; i++) len += haversineM(g[i], g[i + 1])
    edges.push({ id: w.id, a, b, coords: g, len })
  }

  const adj = new Map()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    adj.get(e.a).push({ to: e.b, edge: e, rev: false })
    adj.get(e.b).push({ to: e.a, edge: e, rev: true })
  }

  function nearestNode(p) {
    let best = nodes[0]
    let d = haversineM(p, best)
    for (const n of nodes) {
      const dd = haversineM(p, n)
      if (dd < d) {
        d = dd
        best = n
      }
    }
    return { node: best, distM: d }
  }

  const start = nearestNode(xian)
  const end = nearestNode(chengdu)
  console.log(`  Graph: ${nodes.length} nodes, ${edges.length} edges`)
  console.log(`  Start node ~西安北 ${start.distM.toFixed(0)} m, end ~成都东 ${end.distM.toFixed(0)} m`)

  const dist = new Map([[start.node.id, 0]])
  const prev = new Map()
  const q = [{ id: start.node.id, d: 0 }]
  while (q.length) {
    q.sort((a, b) => a.d - b.d)
    const cur = q.shift()
    if (cur.d !== dist.get(cur.id)) continue
    if (cur.id === end.node.id) break
    for (const nb of adj.get(cur.id) || []) {
      const nd = cur.d + nb.edge.len
      if (nd < (dist.get(nb.to) ?? Infinity)) {
        dist.set(nb.to, nd)
        prev.set(nb.to, { from: cur.id, edge: nb.edge, rev: nb.rev })
        q.push({ id: nb.to, d: nd })
      }
    }
  }
  if (!prev.has(end.node.id) && start.node.id !== end.node.id) {
    throw new Error('No path from 西安北 to 成都东 on 西成客专线')
  }

  const edgePath = []
  let walk = end.node.id
  while (prev.has(walk)) {
    const step = prev.get(walk)
    edgePath.push(step)
    walk = step.from
  }
  edgePath.reverse()

  const coords = []
  for (const step of edgePath) {
    const g = step.rev ? [...step.edge.coords].reverse() : step.edge.coords
    if (coords.length === 0) coords.push(...g)
    else {
      for (let i = 1; i < g.length; i++) coords.push(g[i])
    }
  }
  if (coords.length < 2) throw new Error('Stitched path too short')

  const startHit = nearestOnPolyline(xian, coords)
  const endHit = nearestOnPolyline(chengdu, coords)
  const spine = slicePolyline(coords, startHit, endHit)
  const chain = cumulativeKm(spine)
  console.log(`  Spine points: ${chain.length}, length ${chain[chain.length - 1].km.toFixed(2)} km`)
  console.log(`  Trim start dist to 西安北: ${startHit.distM.toFixed(0)} m, end to 成都东: ${endHit.distM.toFixed(0)} m`)

  const displayParts = []
  for (const w of candidates) {
    const g = (w.geometry || []).map((p) => ({ lat: p.lat, lon: p.lon }))
    if (g.length < 2) continue
    const mid = g[Math.floor(g.length / 2)]
    const near = nearestOnPolyline(mid, spine)
    if (near.distM < 400) displayParts.push(g.map((p) => [p.lon, p.lat]))
  }
  if (displayParts.length === 0) displayParts.push(spine.map((p) => [p.lon, p.lat]))

  return { chain, displayParts }
}

function smoothElevationProfile(profile, maxGradePermille) {
  const smoothed = profile.map((p) => ({ ...p, originalElev: p.elevation, smoothed: false }))
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i].elevation === null) {
      let prev = null
      let next = null
      for (let j = i - 1; j >= 0; j--) if (smoothed[j].elevation !== null) { prev = smoothed[j]; break }
      for (let j = i + 1; j < smoothed.length; j++) if (smoothed[j].elevation !== null) { next = smoothed[j]; break }
      if (prev && next) {
        const t = (smoothed[i].km - prev.km) / (next.km - prev.km)
        smoothed[i].elevation = Math.round(prev.elevation + t * (next.elevation - prev.elevation))
      } else {
        smoothed[i].elevation = (prev || next).elevation
      }
      smoothed[i].smoothed = true
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < smoothed.length; i++) {
      const prev = smoothed[i - 1]
      const curr = smoothed[i]
      const distKm = curr.km - prev.km
      if (distKm < 0.01) continue
      const elevDiff = curr.elevation - prev.elevation
      const maxChange = maxGradePermille * distKm
      if (Math.abs(elevDiff) > maxChange) {
        const direction = elevDiff > 0 ? 1 : -1
        const positionFactor = 0.88 + 0.12 * Math.sin(i * 1.3)
        smoothed[i].elevation = Math.round(prev.elevation + direction * maxChange * positionFactor)
        smoothed[i].smoothed = true
      }
    }
  }
  return smoothed
}

async function fetchElevations(coords) {
  const lats = coords.map((c) => c.lat).join(',')
  const lons = coords.map((c) => c.lon).join(',')
  const url = `${OPEN_METEO}?latitude=${lats}&longitude=${lons}`
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(url)
    if (resp.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      continue
    }
    if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}`)
    const data = await resp.json()
    return data.elevation
  }
  throw new Error('Open-Meteo retries exceeded')
}

async function overpass(query) {
  let last
  for (const url of OVERPASS) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'd1975view/1.0 (educational; Xi\'an-Chengdu PDL)',
        },
        body: 'data=' + encodeURIComponent(query),
      })
      const text = await resp.text()
      if (!resp.ok || text.startsWith('<')) {
        last = new Error(`${url} ${resp.status}`)
        continue
      }
      return JSON.parse(text)
    } catch (e) {
      last = e
    }
  }
  throw last
}

function lineIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const denom = (dy - cy) * (bx - ax) - (dx - cx) * (by - ay)
  if (Math.abs(denom) < 1e-10) return null
  const ua = ((dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)) / denom
  const ub = ((bx - ax) * (ay - cy) - (by - ay) * (ax - cx)) / denom
  if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) return { t: ua }
  return null
}

function parseRivers(osm) {
  const nodes = new Map()
  for (const el of osm.elements) {
    if (el.type === 'node') nodes.set(el.id, { lat: el.lat, lon: el.lon })
  }
  const rivers = []
  for (const el of osm.elements) {
    if (el.type !== 'way' || el.tags?.waterway !== 'river') continue
    const name = el.tags['name:zh'] || el.tags.name
    if (!name || (/[A-Za-z]/.test(name) && !/[\u4e00-\u9fff]/.test(name))) continue
    if (!/[\u4e00-\u9fff]/.test(name)) continue
    const coords = []
    for (const id of el.nodes || []) {
      const n = nodes.get(id)
      if (n) coords.push(n)
    }
    if (coords.length >= 2) rivers.push({ name, coords })
  }
  return rivers
}

function findCrossings(rivers, chain) {
  const found = []
  for (const river of rivers) {
    for (let i = 0; i < river.coords.length - 1; i++) {
      const r1 = river.coords[i]
      const r2 = river.coords[i + 1]
      for (let j = 0; j < chain.length - 1; j++) {
        const t1 = chain[j]
        const t2 = chain[j + 1]
        const lat0 = (r1.lat + r2.lat + t1.lat + t2.lat) / 4
        const R1 = toXY(r1, lat0)
        const R2 = toXY(r2, lat0)
        const T1 = toXY(t1, lat0)
        const T2 = toXY(t2, lat0)
        const inter = lineIntersect(R1.x, R1.y, R2.x, R2.y, T1.x, T1.y, T2.x, T2.y)
        if (!inter) continue
        const km = t1.km + inter.t * (t2.km - t1.km)
        found.push({ name: river.name, km })
      }
    }
  }
  return found
}

async function main() {
  fs.mkdirSync(PUBLIC, { recursive: true })
  console.log('Loading OSM dump...')
  const raw = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'))
  const ways = raw.ways.elements.filter((e) => e.type === 'way')
  const { chain, displayParts } = stitchXicheng(ways)
  const totalKm = chain[chain.length - 1].km

  const stations = STATIONS.map((s) => {
    const km = kmAtPoint(chain, s)
    const on = nearestOnPolyline(s, chain)
    console.log(`  ${s.name}  km ${km.toFixed(2)}  (${on.distM.toFixed(0)} m from track)`)
    return { ...s, km, trackDistM: on.distM }
  })

  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: '西成客专',
          name_en: "Xi'an–Chengdu Passenger Dedicated Line",
          from: '西安北',
          to: '成都东',
          ref: '西成客专线 D1975',
        },
        geometry: {
          type: 'MultiLineString',
          coordinates: displayParts,
        },
      },
      {
        type: 'Feature',
        properties: { role: 'spine', name: '西成客专正线里程' },
        geometry: {
          type: 'LineString',
          coordinates: chain.map((p) => [p.lon, p.lat]),
        },
      },
      ...stations.map((s) => ({
        type: 'Feature',
        properties: {
          name: s.name,
          order: s.order,
          type: 'station',
          osmId: s.osmId,
          km: Math.round(s.km * 10) / 10,
          ...(s.formerName ? { formerName: s.formerName } : {}),
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })),
    ],
  }
  fs.writeFileSync(path.join(PUBLIC, 'd1975.geojson'), JSON.stringify(geojson))
  console.log('Wrote public/d1975.geojson')

  const sampleKms = []
  for (let km = 0; km <= totalKm; km += SAMPLE_INTERVAL_KM) sampleKms.push(Math.round(km * 10) / 10)
  if (sampleKms[sampleKms.length - 1] < totalKm - 0.2) {
    sampleKms.push(Math.round(totalKm * 10) / 10)
  }
  const samples = sampleKms.map((km) => ({ km, ...pointAtKm(chain, km) }))
  console.log(`Sampling ${samples.length} elevation points along polyline...`)
  const elevations = []
  const BATCH = 80
  for (let i = 0; i < samples.length; i += BATCH) {
    const batch = samples.slice(i, i + BATCH)
    console.log(`  elevation batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(samples.length / BATCH)}`)
    elevations.push(...(await fetchElevations(batch)))
    if (i + BATCH < samples.length) await new Promise((r) => setTimeout(r, 250))
  }
  const rawProfile = samples.map((s, i) => ({ km: s.km, lat: s.lat, lon: s.lon, elevation: elevations[i] }))
  const filtered = smoothElevationProfile(rawProfile, MAX_GRADE_PERMILLE)
  const stationsWithElev = stations.map((s) => {
    let prev = null
    let next = null
    for (const p of filtered) {
      if (p.km <= s.km) prev = p
      if (p.km >= s.km && !next) next = p
    }
    let elevation
    if (prev && next && prev !== next) {
      const t = (s.km - prev.km) / (next.km - prev.km)
      elevation = Math.round(prev.elevation + t * (next.elevation - prev.elevation))
    } else {
      elevation = (prev || next).elevation
    }
    return {
      name: s.name,
      order: s.order,
      km: Math.round(s.km * 10) / 10,
      lat: s.lat,
      lon: s.lon,
      elevation,
      ...(s.formerName ? { formerName: s.formerName } : {}),
    }
  })
  const valid = filtered.map((p) => p.elevation).filter((e) => e !== null)
  const elevOut = {
    source: 'Open-Meteo Elevation API (SRTM 90m)',
    generated: new Date().toISOString(),
    notes: {
      samplingMethod: 'Points sampled every 1 km along the OSM 西成客专线 polyline (西安北→成都东), not station chords',
      kmSystem: 'Polyline chainage; 西安北 = 0',
      gradeSmoothing: `Adjacent grades capped at ${MAX_GRADE_PERMILLE}‰`,
    },
    summary: {
      totalKm: Math.round(totalKm * 10) / 10,
      minElevation: Math.min(...valid),
      maxElevation: Math.max(...valid),
      stationCount: stations.length,
      profilePoints: filtered.length,
    },
    stations: stationsWithElev,
    profile: filtered.map((p) => ({
      km: p.km,
      elevation: p.elevation,
      ...(p.smoothed ? { smoothed: true } : {}),
    })),
  }
  fs.writeFileSync(path.join(PUBLIC, 'elevation-profile.json'), JSON.stringify(elevOut, null, 2))
  console.log(`Wrote elevation ${elevOut.summary.minElevation}-${elevOut.summary.maxElevation} m`)

  const lats = chain.map((p) => p.lat)
  const lons = chain.map((p) => p.lon)
  const buf = 0.06
  const bbox = `${Math.min(...lats) - buf},${Math.min(...lons) - buf},${Math.max(...lats) + buf},${Math.max(...lons) + buf}`
  console.log('Fetching rivers...', bbox)
  const riverOsm = await overpass(`
[out:json][timeout:90];
(
  way["waterway"="river"](${bbox});
);
out body;
>;
out skel qt;
`)
  const rivers = parseRivers(riverOsm)
  console.log(`  named rivers: ${rivers.length}`)
  const crossings = findCrossings(rivers, chain)
  const grouped = new Map()
  for (const c of crossings) {
    const list = grouped.get(c.name) || []
    if (list.every((e) => Math.abs(e.km - c.km) > 8)) list.push({ ...c, type: 'crossing' })
    grouped.set(c.name, list)
  }
  const finalRivers = []
  for (const [name, list] of grouped) {
    list.sort((a, b) => a.km - b.km)
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      let km = c.km
      let alignedTo = null
      let nearestSt = null
      let nearestD = Infinity
      for (const s of stations) {
        const d = Math.abs(s.km - c.km)
        if (d < nearestD) {
          nearestD = d
          nearestSt = s
        }
      }
      if (nearestSt && nearestD <= 2) {
        km = nearestSt.km
        alignedTo = nearestSt.name
      }
      finalRivers.push({
        name: list.length > 1 ? `${name} (${i + 1})` : name,
        baseName: name,
        km: Math.round(km * 10) / 10,
        type: c.type,
        ...(alignedTo ? { alignedTo, desc: `${alignedTo}站` } : {}),
      })
    }
  }
  finalRivers.sort((a, b) => a.km - b.km)
  const riverOut = {
    source: 'OpenStreetMap waterway=river crossings of the 西成客专 polyline',
    generated: new Date().toISOString(),
    notes: {
      kmSystem: 'Same polyline chainage as the station scale; 西安北 = 0',
      onlyCrossings: 'Only rivers the railway actually crosses; pass-by / parallel rivers omitted',
      stationSnap: 'A river named against a station sits on that station km (within 2 km)',
    },
    summary: {
      totalKm: Math.round(totalKm * 10) / 10,
      riverCount: finalRivers.length,
      uniqueRivers: new Set(finalRivers.map((r) => r.baseName)).size,
    },
    rivers: finalRivers.map((r) => ({
      name: r.name,
      km: r.km,
      ...(r.desc ? { desc: r.desc } : {}),
      ...(r.alignedTo ? { alignedTo: r.alignedTo } : {}),
    })),
  }
  fs.writeFileSync(path.join(PUBLIC, 'rivers.json'), JSON.stringify(riverOut, null, 2))
  console.log('Rivers:')
  for (const r of riverOut.rivers) {
    console.log(`  km ${String(r.km).padStart(6)}  ${r.name}${r.desc ? '  ' + r.desc : ''}`)
  }

  const summary = {
    stations: stations.map((s) => ({
      name: s.name,
      order: s.order,
      km: Math.round(s.km * 100) / 100,
      lat: s.lat,
      lon: s.lon,
      osmId: s.osmId,
      trackDistM: Math.round(s.trackDistM),
      ...(s.formerName ? { formerName: s.formerName } : {}),
    })),
    totalKm: Math.round(totalKm * 100) / 100,
  }
  fs.writeFileSync(path.join(PUBLIC, 'stations.json'), JSON.stringify(summary, null, 2))
  console.log(`Done. Total chainage ${summary.totalKm} km`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
