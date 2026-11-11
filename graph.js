// The map data (tiles from tools/build_data.py), the scoring of every segment against what the
// walker asked for, and the search for round trips.

import { sunPosition } from './sun.js';

const RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111400;
const SECTORS = 24;
const SECTOR_DEG = 360 / SECTORS;
const HEX_PER_SEGMENT = SECTORS * 2;

// Bits of a segment's flags, as written by tools/build_data.py.
const FOOT = 1 << 3;
const BIKE = 1 << 4;
const WATER = 1 << 11;
const FOREST = 1 << 12;
const NOISY = 1 << 13;
const PAVED = 1 << 14;
const BIKE_GOOD = 1 << 16;
const highwayClass = (flags) => flags & 7;
const litLevel = (flags) => (flags >> 5) & 3;
const greenLevel = (flags) => ((flags >> 7) & 15) / 10;

const LIT_PROBABILITY = [0, 0.25, 0.7, 1];
const QUIET_BY_CLASS = [1, 1, 1, 0.75, 0.4, 0.2, 0.05];
const POI_REACH_M = 60;
const POI_FULL_WEIGHT = 3;
const POI_WANT = { art: 'art', culture: 'history', history: 'history', building: 'history', view: 'view',
  sight: 'sight', park: 'trees', cafe: 'food', restaurant: 'food', bakery: 'food', ice: 'food', pub: 'food',
  fastfood: 'food', play: 'play' };
const FOOD_WEIGHT_MOST = 3;     // however many cafés a trip passes, they count this much at most
const POI_SHOWN_FROM_WEIGHT = 0.5;
const SUN_UP_DEG = 0.5;
const LEAF_MONTHS = [4, 5, 6, 7, 8]; // May to September: forest paths are in shade

const WEIGHT = { light: 0.35, green: 0.25, water: 0.15, poi: 0.2, quiet: 0.15 };
const COST_WORST = 2.4;
const COST_SPAN = 1.9;
const BIKE_FOOTPATH_FACTOR = 1.3;
const BIKE_UNPAVED_FACTOR = 1.4;
const HEURISTIC_FACTOR = 0.4;   // below the cheapest possible cost per metre
const REUSE_FACTOR = 4;         // walking the same stretch twice costs this much more
const DETOUR = 1.35;            // paths are about this much longer than the straight line
const LENGTH_TOLERANCE = 0.12;
const NOISE_CELL_M = 250;
const GRID_M = 100;
const SAME_ROUTE_OVERLAP = 0.7;
const TILES_AT_ONCE = 4;
const TILE_ATTEMPTS = 3;
const LAND_WITHIN_M = 300;      // a corner of a round trip needs a path this close
const DOUBLED_WITHIN_M = 35;    // a stretch this close to another part of the trip counts as walked twice
const DOUBLED_APART_M = 250;    // ... when the two parts are this far apart along the trip

let meta = null;
const tileCache = new Map();

export async function loadMeta() {
  if (!meta) {
    meta = await (await fetch('data/meta.json')).json();
    meta.tileSet = new Set(meta.tiles);
  }
  return meta;
}

async function fetchTile(key) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`data/t_${key}.json`);
      if (!response.ok) throw new Error(`Kartrute ${key} svarte ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === TILE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
}

function loadTile(key) {
  if (!tileCache.has(key)) {
    const loading = fetchTile(key);
    loading.catch(() => tileCache.delete(key));   // a failed tile may be asked for again
    tileCache.set(key, loading);
  }
  return tileCache.get(key);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cellKey = (x, y, size) => (Math.floor(x / size) + 5000) * 10000 + Math.floor(y / size) + 5000;

/** Loads the tiles within radiusM of center and joins them into one graph. */
export async function loadGraph(center, radiusM, onProgress = () => {}) {
  const m = await loadMeta();
  const mPerDegLon = 111320 * Math.cos(center.lat * RAD);
  const keys = [];
  const row0 = Math.floor((center.lat - radiusM / M_PER_DEG_LAT - m.lat0) / m.tileLat);
  const row1 = Math.floor((center.lat + radiusM / M_PER_DEG_LAT - m.lat0) / m.tileLat);
  const col0 = Math.floor((center.lon - radiusM / mPerDegLon - m.lon0) / m.tileLon);
  const col1 = Math.floor((center.lon + radiusM / mPerDegLon - m.lon0) / m.tileLon);
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      if (m.tileSet.has(`${row}_${col}`)) keys.push(`${row}_${col}`);
    }
  }
  // A few at a time: small servers and phone connections drop a burst of requests.
  const tiles = new Array(keys.length);
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(TILES_AT_ONCE, keys.length) }, async () => {
    while (next < keys.length) {
      const i = next++;
      tiles[i] = await loadTile(keys[i]);
      onProgress(++done, keys.length);
    }
  }));
  return buildGraph(tiles, center, mPerDegLon);
}

function buildGraph(tiles, center, mPerDegLon) {
  let nodeCount = 0;
  let segmentCount = 0;
  for (const t of tiles) { nodeCount += t.n.length / 3; segmentCount += t.s.length / 4; }
  const g = {
    center, mPerDegLon,
    lat: new Float64Array(nodeCount), lon: new Float64Array(nodeCount),
    x: new Float32Array(nodeCount), y: new Float32Array(nodeCount),
    a: new Int32Array(segmentCount), b: new Int32Array(segmentCount),
    flags: new Int32Array(segmentCount), len: new Float32Array(segmentCount),
    name: new Int32Array(segmentCount), horizon: new Uint8Array(segmentCount * SECTORS),
    names: [''], pois: [], segPois: [], nodeCount, segmentCount: 0,
  };
  const index = new Map();
  let n = 0;
  for (const t of tiles) {
    for (let i = 0; i < t.n.length; i += 3) {
      index.set(t.n[i], n);
      g.lat[n] = t.o[0] + t.n[i + 1] / 1e6;
      g.lon[n] = t.o[1] + t.n[i + 2] / 1e6;
      g.x[n] = (g.lon[n] - center.lon) * mPerDegLon;
      g.y[n] = (g.lat[n] - center.lat) * M_PER_DEG_LAT;
      n++;
    }
  }
  const nameIndex = new Map([['', 0]]);
  const hexValue = (code) => (code < 58 ? code - 48 : code - 87);
  let s = 0;
  for (const t of tiles) {
    for (let i = 0, k = 0; i < t.s.length; i += 4, k++) {
      const a = index.get(t.s[i]);
      const b = index.get(t.s[i + 1]);
      if (a === undefined || b === undefined) continue;
      g.a[s] = a;
      g.b[s] = b;
      g.flags[s] = t.s[i + 2];
      g.len[s] = Math.hypot(g.x[a] - g.x[b], g.y[a] - g.y[b]);
      const name = t.names[t.s[i + 3]];
      if (!nameIndex.has(name)) { nameIndex.set(name, g.names.length); g.names.push(name); }
      g.name[s] = nameIndex.get(name);
      const from = k * HEX_PER_SEGMENT;
      for (let sector = 0; sector < SECTORS; sector++) {
        g.horizon[s * SECTORS + sector] = hexValue(t.h.charCodeAt(from + sector * 2)) * 16
          + hexValue(t.h.charCodeAt(from + sector * 2 + 1));
      }
      s++;
    }
    for (const [dLat, dLon, kind, weight, name, radiusM] of t.p) {
      const lat = t.o[0] + dLat / 1e6;
      const lon = t.o[1] + dLon / 1e6;
      g.pois.push({ lat, lon, kind, weight, name, radiusM,
        x: (lon - center.lon) * mPerDegLon, y: (lat - center.lat) * M_PER_DEG_LAT });
    }
  }
  g.segmentCount = s;

  // Which points of interest each segment passes.
  const poiGrid = new Map();
  g.pois.forEach((poi, i) => {
    const reach = POI_REACH_M + poi.radiusM;
    for (let x = poi.x - reach; x <= poi.x + reach + GRID_M; x += GRID_M) {
      for (let y = poi.y - reach; y <= poi.y + reach + GRID_M; y += GRID_M) {
        const key = cellKey(x, y, GRID_M);
        if (!poiGrid.has(key)) poiGrid.set(key, []);
        poiGrid.get(key).push(i);
      }
    }
  });
  g.segPois = new Array(s);
  for (let i = 0; i < s; i++) {
    const mx = (g.x[g.a[i]] + g.x[g.b[i]]) / 2;
    const my = (g.y[g.a[i]] + g.y[g.b[i]]) / 2;
    const near = poiGrid.get(cellKey(mx, my, GRID_M));
    if (!near) continue;
    const hits = near.filter((p) => Math.hypot(g.pois[p].x - mx, g.pois[p].y - my) <= POI_REACH_M + g.pois[p].radiusM);
    if (hits.length) g.segPois[i] = hits;
  }
  return g;
}

/** The adjacency for one way of moving, limited to the largest connected part. */
export function prepare(g, mode) {
  const allowed = mode === 'bike' ? BIKE : FOOT;
  const degree = new Int32Array(g.nodeCount + 1);
  for (let s = 0; s < g.segmentCount; s++) {
    if (g.flags[s] & allowed) { degree[g.a[s]]++; degree[g.b[s]]++; }
  }
  const offset = new Int32Array(g.nodeCount + 1);
  for (let i = 0; i < g.nodeCount; i++) offset[i + 1] = offset[i] + degree[i];
  const fill = offset.slice(0, g.nodeCount);
  const adjNode = new Int32Array(offset[g.nodeCount]);
  const adjSeg = new Int32Array(offset[g.nodeCount]);
  for (let s = 0; s < g.segmentCount; s++) {
    if (!(g.flags[s] & allowed)) continue;
    adjNode[fill[g.a[s]]] = g.b[s]; adjSeg[fill[g.a[s]]++] = s;
    adjNode[fill[g.b[s]]] = g.a[s]; adjSeg[fill[g.b[s]]++] = s;
  }

  const component = new Int32Array(g.nodeCount).fill(-1);
  const queue = new Int32Array(g.nodeCount);
  let best = -1;
  let bestSize = 0;
  for (let start = 0, label = 0; start < g.nodeCount; start++) {
    if (component[start] !== -1 || offset[start + 1] === offset[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    component[start] = label;
    while (head < tail) {
      const node = queue[head++];
      for (let e = offset[node]; e < offset[node + 1]; e++) {
        if (component[adjNode[e]] === -1) { component[adjNode[e]] = label; queue[tail++] = adjNode[e]; }
      }
    }
    if (tail > bestSize) { bestSize = tail; best = label; }
    label++;
  }
  const grid = new Map();
  for (let node = 0; node < g.nodeCount; node++) {
    if (component[node] !== best) continue;
    const key = cellKey(g.x[node], g.y[node], GRID_M);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(node);
  }
  return { mode, offset, adjNode, adjSeg, grid,
    dist: new Float32Array(g.nodeCount), stamp: new Int32Array(g.nodeCount), run: 0,
    prevNode: new Int32Array(g.nodeCount), prevSeg: new Int32Array(g.nodeCount),
    used: new Uint8Array(g.segmentCount) };
}

function nodesWithin(g, prep, x, y, radiusM) {
  const found = [];
  for (let cx = x - radiusM; cx <= x + radiusM + GRID_M; cx += GRID_M) {
    for (let cy = y - radiusM; cy <= y + radiusM + GRID_M; cy += GRID_M) {
      for (const node of prep.grid.get(cellKey(cx, cy, GRID_M)) || []) {
        if (Math.hypot(g.x[node] - x, g.y[node] - y) <= radiusM) found.push(node);
      }
    }
  }
  return found;
}

export function nearestNode(g, prep, x, y) {
  for (const radiusM of [60, 150, 400, 1000]) {
    let best = -1;
    let bestDistance = Infinity;
    for (const node of nodesWithin(g, prep, x, y, radiusM)) {
      const d = Math.hypot(g.x[node] - x, g.y[node] - y);
      if (d < bestDistance) { bestDistance = d; best = node; }
    }
    if (best !== -1) return best;
  }
  return -1;
}

/** What the light is like on every segment at a time, and how well each segment fits the wishes. */
export function scoreSegments(g, mode, wishes, time) {
  const sun = sunPosition(time, g.center.lat, g.center.lon);
  const day = sun.altitudeDeg > SUN_UP_DEG;
  const sector = Math.floor(sun.bearingDeg / SECTOR_DEG) % SECTORS;
  const leaves = LEAF_MONTHS.includes(time.getMonth());
  const light = wishes.light !== 'any' && !day ? 'lit' : wishes.light;
  const wantsPoi = wishes.art || wishes.history || wishes.view || wishes.food || wishes.play;
  const weightSum = (light === 'any' ? 0 : WEIGHT.light) + (wishes.trees ? WEIGHT.green : 0)
    + (wishes.water ? WEIGHT.water : 0) + (wantsPoi ? WEIGHT.poi : 0) + WEIGHT.quiet;

  const quality = new Float32Array(g.segmentCount);
  const factor = new Float32Array(g.segmentCount);
  const sunlit = new Uint8Array(g.segmentCount);
  const poiValue = (s) => {
    let sum = 0;
    for (const p of g.segPois[s] || []) {
      const want = POI_WANT[g.pois[p].kind];
      if (want === 'sight' ? wantsPoi : wishes[want]) sum += g.pois[p].weight;
    }
    return Math.min(1, sum / POI_FULL_WEIGHT);
  };
  for (let s = 0; s < g.segmentCount; s++) {
    const flags = g.flags[s];
    const inSun = day && sun.altitudeDeg > g.horizon[s * SECTORS + sector] && !(leaves && (flags & FOREST));
    sunlit[s] = inSun ? 1 : 0;
    let sum = WEIGHT.quiet * QUIET_BY_CLASS[highwayClass(flags)] * (flags & NOISY ? 0.5 : 1);
    if (light === 'sun') sum += WEIGHT.light * (inSun ? 1 : 0);
    else if (light === 'shade') sum += WEIGHT.light * (inSun ? 0 : 1);
    else if (light === 'lit') sum += WEIGHT.light * LIT_PROBABILITY[litLevel(flags)];
    if (wishes.trees) sum += WEIGHT.green * greenLevel(flags);
    if (wishes.water) sum += WEIGHT.water * (flags & WATER ? 1 : 0);
    if (wantsPoi) sum += WEIGHT.poi * poiValue(s);
    quality[s] = sum / weightSum;
    let f = COST_WORST - COST_SPAN * quality[s];
    if (mode === 'bike') {
      if (highwayClass(flags) === 0 && !(flags & BIKE_GOOD)) f *= BIKE_FOOTPATH_FACTOR;
      if (!(flags & PAVED)) f *= BIKE_UNPAVED_FACTOR;
    }
    factor[s] = f;
  }
  return { quality, factor, sunlit, sun, day, light, time, wishes, wantsPoi };
}

// --- shortest path (A*) ----------------------------------------------------------------------

class Heap {
  constructor() { this.keys = []; this.values = []; }
  get size() { return this.keys.length; }
  push(key, value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key); values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent]; values[i] = values[parent];
      i = parent;
    }
    keys[i] = key; values[i] = value;
  }
  pop() {
    const { keys, values } = this;
    const top = values[0];
    const key = keys.pop();
    const value = values.pop();
    const size = keys.length;
    if (size > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= size) break;
        if (child + 1 < size && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child]; values[i] = values[child];
        i = child;
      }
      keys[i] = key; values[i] = value;
    }
    return top;
  }
}

function shortestPath(g, prep, from, to, cost) {
  const { offset, adjNode, adjSeg, dist, stamp, prevNode, prevSeg, used } = prep;
  const run = ++prep.run;
  const tx = g.x[to];
  const ty = g.y[to];
  const heap = new Heap();
  dist[from] = 0; stamp[from] = run; prevNode[from] = -1;
  heap.push(0, from);
  const closed = -run;
  while (heap.size) {
    const node = heap.pop();
    if (stamp[node] === closed) continue;
    if (node === to) break;
    const base = dist[node];
    stamp[node] = closed;
    for (let e = offset[node]; e < offset[node + 1]; e++) {
      const next = adjNode[e];
      if (stamp[next] === closed) continue;
      const seg = adjSeg[e];
      const d = base + cost[seg] * (used[seg] ? REUSE_FACTOR : 1);
      if (stamp[next] !== run || d < dist[next]) {
        dist[next] = d; stamp[next] = run; prevNode[next] = node; prevSeg[next] = seg;
        heap.push(d + HEURISTIC_FACTOR * Math.hypot(g.x[next] - tx, g.y[next] - ty), next);
      }
    }
  }
  if (stamp[to] !== run && stamp[to] !== closed) return null;
  const nodes = [to];
  const segs = [];
  for (let node = to; prevNode[node] !== -1 && node !== from; node = prevNode[node]) {
    segs.push(prevSeg[node]);
    nodes.push(prevNode[node]);
  }
  return { nodes: nodes.reverse(), segs: segs.reverse() };
}

/** A path through the stops in order; later legs avoid what earlier legs used. */
function pathThrough(g, prep, stops, cost) {
  const nodes = [stops[0]];
  const segs = [];
  let ok = true;
  for (let i = 0; i + 1 < stops.length && ok; i++) {
    const leg = shortestPath(g, prep, stops[i], stops[i + 1], cost);
    if (!leg) { ok = false; break; }
    for (const s of leg.segs) { segs.push(s); prep.used[s] = 1; }
    for (let k = 1; k < leg.nodes.length; k++) nodes.push(leg.nodes[k]);
  }
  for (const s of segs) prep.used[s] = 0;
  if (!ok) return null;
  let lengthM = 0;
  for (const s of segs) lengthM += g.len[s];
  return { nodes, segs, lengthM };
}

// --- candidates ------------------------------------------------------------------------------

function pickVia(g, prep, scored, rng, x, y, homeX, homeY) {
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const radiusM of [150, 300]) {
      const nodes = nodesWithin(g, prep, x, y, radiusM);
      if (!nodes.length) continue;
      let best = -1;
      let bestValue = -1;
      for (let i = 0; i < Math.min(25, nodes.length); i++) {
        const node = nodes[Math.floor(rng() * nodes.length)];
        let sum = 0;
        const edges = prep.offset[node + 1] - prep.offset[node];
        for (let e = prep.offset[node]; e < prep.offset[node + 1]; e++) sum += scored.quality[prep.adjSeg[e]];
        const value = sum / edges + rng() * 0.15;
        if (value > bestValue) { bestValue = value; best = node; }
      }
      return best;
    }
    x = homeX + (x - homeX) * 0.75;
    y = homeY + (y - homeY) * 0.75;
  }
  return -1;
}

function candidate(g, prep, scored, request, rng) {
  const { startNode, endNode, lengthM } = request;
  const seed = Math.floor(rng() * 1e9);
  const cost = new Float32Array(g.segmentCount);
  for (let s = 0; s < g.segmentCount; s++) {
    const cx = Math.floor((g.x[g.a[s]] + 50000) / NOISE_CELL_M);
    const cy = Math.floor((g.y[g.a[s]] + 50000) / NOISE_CELL_M);
    let h = Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ seed;
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h ^= h >>> 13;
    cost[s] = g.len[s] * scored.factor[s] * (0.85 + ((h >>> 0) % 1000) / 1000 * 0.35);
  }
  const sx = g.x[startNode];
  const sy = g.y[startNode];
  const point = (bearing, distance) => [sx + Math.sin(bearing) * distance, sy + Math.cos(bearing) * distance];
  const loop = endNode === startNode;
  // A direction where the corners of the round trip land on paths, not in the fjord.
  let bearing = rng() * 2 * Math.PI;
  for (let i = 0; loop && i < 8; i++) {
    const onLand = [-0.6, 0, 0.6].every((turn) =>
      nodesWithin(g, prep, ...point(bearing + turn, lengthM / (3 * DETOUR)), LAND_WITHIN_M).length > 0);
    if (onLand) break;
    bearing = rng() * 2 * Math.PI;
  }
  const fourCorners = rng() < 0.5;
  const side = rng() < 0.5 ? 1 : -1;
  const along = 0.35 + rng() * 0.3;
  const ex = g.x[endNode];
  const ey = g.y[endNode];
  const straight = Math.hypot(ex - sx, ey - sy);

  let best = null;
  let scale = 1;
  for (let attempt = 0; attempt < 3; attempt++) {
    let targets = [];
    if (loop) {
      if (fourCorners) {
        const d = (lengthM / (3.85 * DETOUR)) * scale;
        targets = [point(bearing - Math.PI / 4, d), point(bearing, d * 1.3), point(bearing + Math.PI / 4, d)];
      } else {
        const d = (lengthM / (3 * DETOUR)) * scale;
        targets = [point(bearing - Math.PI / 6, d), point(bearing + Math.PI / 6, d)];
      }
    } else {
      const half = (lengthM / DETOUR / 2) * scale;
      const out = half > straight / 2 ? Math.sqrt(half * half - (straight / 2) ** 2) : 0;
      if (out > 100) {
        const nx = -(ey - sy) / (straight || 1);
        const ny = (ex - sx) / (straight || 1);
        targets = [[sx + (ex - sx) * along + nx * out * side, sy + (ey - sy) * along + ny * out * side]];
      }
    }
    const vias = targets.map(([x, y]) => pickVia(g, prep, scored, rng, x, y, sx, sy));
    if (vias.includes(-1)) break;
    const path = pathThrough(g, prep, [startNode, ...vias, endNode], cost);
    if (!path) break;
    const miss = Math.abs(path.lengthM - lengthM) / lengthM;
    if (!best || miss < best.miss) best = { ...path, miss };
    if (miss < LENGTH_TOLERANCE || (!loop && targets.length === 0)) break;
    scale *= Math.min(1.8, Math.max(0.5, lengthM / path.lengthM));
  }
  return best;
}

function describe(g, scored, path, request) {
  const stats = { lengthM: path.lengthM, sunM: 0, litM: 0, greenM: 0, waterM: 0, quietM: 0, repeatM: 0, qualityM: 0 };
  const poiAt = new Map();
  const nameM = new Map();
  // How much of the trip runs along itself (out and back), not only over the very same segment.
  const trail = new Map();
  const middles = [];
  let at = 0;
  for (const s of path.segs) {
    const mx = (g.x[g.a[s]] + g.x[g.b[s]]) / 2;
    const my = (g.y[g.a[s]] + g.y[g.b[s]]) / 2;
    middles.push([mx, my, at]);
    const key = cellKey(mx, my, DOUBLED_WITHIN_M);
    if (!trail.has(key)) trail.set(key, []);
    trail.get(key).push(middles.length - 1);
    at += g.len[s];
  }
  const doubled = ([mx, my, atM]) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of trail.get(cellKey(mx + dx * DOUBLED_WITHIN_M, my + dy * DOUBLED_WITHIN_M, DOUBLED_WITHIN_M)) || []) {
          const [ox, oy, otherM] = middles[i];
          const apartM = Math.abs(otherM - atM);
          if (apartM > DOUBLED_APART_M && path.lengthM - apartM > DOUBLED_APART_M
            && Math.hypot(ox - mx, oy - my) < DOUBLED_WITHIN_M) return true;
        }
      }
    }
    return false;
  };
  at = 0;
  for (let k = 0; k < path.segs.length; k++) {
    const s = path.segs[k];
    const flags = g.flags[s];
    const len = g.len[s];
    if (doubled(middles[k])) stats.repeatM += len;
    stats.qualityM += scored.quality[s] * len;
    if (scored.sunlit[s]) stats.sunM += len;
    if (litLevel(flags) >= 2) stats.litM += len;
    if (greenLevel(flags) >= 0.5) stats.greenM += len;
    if (flags & WATER) stats.waterM += len;
    if (highwayClass(flags) <= 3 && !(flags & NOISY)) stats.quietM += len;
    if (g.name[s]) nameM.set(g.name[s], (nameM.get(g.name[s]) || 0) + len);
    for (const p of g.segPois[s] || []) if (!poiAt.has(p)) poiAt.set(p, at);
    at += len;
  }
  const pois = [...poiAt].map(([p, atM]) => ({ ...g.pois[p], atM }))
    .filter((p) => p.weight >= POI_SHOWN_FROM_WEIGHT)
    .sort((a, b) => b.weight - a.weight);
  const wanted = pois.filter((p) => (POI_WANT[p.kind] === 'sight' ? true : scored.wishes[POI_WANT[p.kind]]));
  const weightOf = (list) => list.reduce((sum, p) => sum + p.weight, 0);
  const poiWeight = weightOf(wanted.filter((p) => POI_WANT[p.kind] !== 'food'))
    + Math.min(FOOD_WEIGHT_MOST, weightOf(wanted.filter((p) => POI_WANT[p.kind] === 'food')));
  const share = (m) => m / path.lengthM;
  const miss = Math.abs(path.lengthM - request.lengthM) / request.lengthM;
  const score = 100 * (0.7 * share(stats.qualityM) + 0.2 * Math.min(1, poiWeight / 12)
    + 0.1 * (1 - share(stats.repeatM))) - 30 * Math.max(0, miss - 0.1) - 40 * share(stats.repeatM);
  const streets = [...nameM].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => g.names[n]);
  const segState = path.segs.map((s) => {
    if (scored.day) return scored.sunlit[s] ? 'sun' : 'shade';
    return ['dark', 'dark', 'dim', 'lit'][litLevel(g.flags[s])];
  });
  const coords = path.nodes.map((n) => [g.lat[n], g.lon[n]]);
  const cumM = [0];
  for (const s of path.segs) cumM.push(cumM[cumM.length - 1] + g.len[s]);
  return { ...path, stats, share, pois, wanted, streets, score: Math.max(0, Math.round(score)), segState, coords, cumM,
    scored, horizon: path.segs.map((s) => g.horizon.subarray(s * SECTORS, (s + 1) * SECTORS)),
    forest: path.segs.map((s) => Boolean(g.flags[s] & FOREST)),
    lit: path.segs.map((s) => litLevel(g.flags[s])),
    green: path.segs.map((s) => greenLevel(g.flags[s])) };
}

function overlap(a, b) {
  const inA = new Set(a.segs);
  let shared = 0;
  let total = 0;
  for (const s of new Set(b.segs)) { total++; if (inA.has(s)) shared++; }
  return shared / total;
}

/** Tries `tries` random round trips and returns the different ones, best first. */
export async function findRoutes(g, prep, scored, request, rng, tries, onProgress = () => {}) {
  const routes = [];
  for (let i = 0; i < tries; i++) {
    onProgress(i + 1, tries);
    await new Promise((resolve) => setTimeout(resolve));
    const path = candidate(g, prep, scored, request, rng);
    if (!path || path.segs.length === 0) continue;
    const route = describe(g, scored, path, request);
    const twin = routes.findIndex((r) => overlap(r, route) > SAME_ROUTE_OVERLAP);
    if (twin === -1) routes.push(route);
    else if (route.score > routes[twin].score) routes[twin] = route;
  }
  return routes.sort((a, b) => b.score - a.score);
}

/** Sun or shade on a stretch of a finished route right now (for the view while walking). */
export function lightNow(route, segmentNumber, time, lat, lon) {
  const sun = sunPosition(time, lat, lon);
  if (sun.altitudeDeg <= SUN_UP_DEG) return ['dark', 'dark', 'dim', 'lit'][route.lit[segmentNumber]];
  const sector = Math.floor(sun.bearingDeg / SECTOR_DEG) % SECTORS;
  const shaded = sun.altitudeDeg <= route.horizon[segmentNumber][sector]
    || (route.forest[segmentNumber] && LEAF_MONTHS.includes(time.getMonth()));
  return shaded ? 'shade' : 'sun';
}
