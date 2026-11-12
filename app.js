// Oslo-turer: the page. It asks what kind of trip is wanted, lets graph.js propose and rank
// round trips on real map data, shows why each is good, and follows along while walking.

import { loadMeta, loadGraph, prepare, scoreSegments, findRoutes, routeFromCoords, nearestNode, mulberry32, lightNow } from './graph.js';
import { sunPosition } from './sun.js';
import { setScene } from './scene.js';

const OSLO_CENTER = [59.925, 10.745];
const OSLO_ZOOM = 12;
const M_PER_DEG_LAT = 111400;
const M_PER_DEG_LON = 111320 * Math.cos(59.925 * Math.PI / 180);
const SPEED_KMH = { walk: { slow: 3.5, normal: 4.8, fast: 6 }, bike: { slow: 12, normal: 16, fast: 22 } };
const DAY_MIN = 1440;
const CLOCK_STEP_MIN = 5;
const FOOD_SHOWN = 8;
const PLAY_SHOWN = 10;
const LENGTH_KM = { walk: { min: 2, max: 15, step: 0.5, value: 5 }, bike: { min: 5, max: 30, step: 1, value: 15 } };
const MAX_RADIUS_M = 9000;
const SHOWN_ROUTES = 6;
const TRIES = 12;
const APP_STARTS = { walk: 3, bike: 2 };
const OFF_ROUTE_M = 60;
const SIMULATION_STEP_M = { walk: 12, bike: 40 };
const SIMULATION_TICK_MS = 100;

// Good places to start from when the app chooses; the trip snaps to the nearest path.
const HUBS = [
  ['Frognerparken', 59.9270, 10.7005], ['St. Hanshaugen', 59.9275, 10.7405], ['Birkelunden', 59.9265, 10.7600],
  ['Tøyenparken', 59.9180, 10.7740], ['Ekebergparken', 59.8990, 10.7620], ['Sognsvann', 59.9690, 10.7330],
  ['Bygdøy', 59.9070, 10.6850], ['Akershus festning', 59.9075, 10.7365], ['Nydalen', 59.9495, 10.7655],
  ['Østensjøvannet', 59.8900, 10.8300], ['Sørenga', 59.9020, 10.7530], ['Slottsparken', 59.9170, 10.7270],
  ['Torshovparken', 59.9350, 10.7650], ['Kampen park', 59.9130, 10.7810], ['Ullevål hageby', 59.9440, 10.7330],
  ['Holmenkollen', 59.9640, 10.6680], ['Brekke ved Maridalsvannet', 59.9650, 10.7780], ['Aker Brygge', 59.9100, 10.7270],
  ['Vålerenga', 59.9080, 10.7860], ['Røa', 59.9470, 10.6440],
];

const STATE = {
  sun: { label: 'Sol', color: '#ffc24a' }, shade: { label: 'Skygge', color: '#6f7fe0' },
  lit: { label: 'Gatelys', color: '#ffd98a' }, dim: { label: 'Trolig gatelys', color: '#b99a5a' },
  dark: { label: 'Mørkt', color: '#4a5078' },
};
const INK = '#0a0e24';          // the dark line under every thread on the map
const GOLD = '#ffd98a';
const LANTERN = { radius: 7, color: '#f2a93b', weight: 3, fillColor: '#fff7dd', fillOpacity: 1 };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const VEIL_MS = 1400;
const ROUGH_WORTH_SAYING_M = 30;
const COPIED_SHOWN_MS = 2500;
const KIND = { art: 'kunst', culture: 'museum', history: 'historisk', building: 'bygg', view: 'utsikt',
  sight: 'severdighet', park: 'park', cafe: 'kafé', restaurant: 'spisested', bakery: 'bakeri', ice: 'is', pub: 'pub',
  fastfood: 'gatekjøkken', play: 'lekeplass' };
const FOOD = new Set(['cafe', 'restaurant', 'bakery', 'ice', 'pub', 'fastfood']);
const PLAY = 'play';
const PLAY_COLOR = '#9be0b0';
// Places listed on their own (food, playgrounds), not among the sights.
const aside = (p) => FOOD.has(p.kind) || p.kind === PLAY;
/** At most n of the items, spread evenly over the list. */
const spread = (items, n) => items.filter((_, i) => Math.floor(i * n / items.length) !== Math.floor((i - 1) * n / items.length));

const choice = { mode: 'walk', pace: 'normal', light: 'sun', start: 'app', end: 'loop' };
let clockMin = null;            // minutes after midnight today; null follows the real clock
const wishes = { trees: true, water: true, art: true, history: true, view: true, food: true, play: false, rolling: false };
const points = { start: null, end: null };
let picking = null;
let routes = [];
let selected = null;
let walk = null;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) node.append(child);
  return node;
};
const km = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const speed = () => SPEED_KMH[choice.mode][choice.pace];
const minutes = (m, speedKmh) => {
  const min = Math.round(m / 1000 / speedKmh * 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} t ${min % 60} min`;
};
const clock = (date) => date.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
const percent = (share) => `${Math.round(share * 100)} %`;
const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} og ${items[items.length - 1]}` : items[0]);

// --- map -------------------------------------------------------------------------------------

const map = L.map('map').setView(OSLO_CENTER, OSLO_ZOOM);
L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topograatone/default/webmercator/{z}/{y}/{x}.png', {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.kartverket.no/">Kartverket</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);

function drawPoints() {
  pointLayer.clearLayers();
  if (points.start) {
    L.circleMarker(points.start, LANTERN).bindTooltip('Start').addTo(pointLayer);
  }
  if (points.end) {
    L.circleMarker(points.end, { ...LANTERN, color: '#ff9d7a' }).bindTooltip('Slutt').addTo(pointLayer);
  }
}

function drawRoutes() {
  routeLayer.clearLayers();
  for (const route of routes) {
    if (route === selected) continue;
    L.polyline(route.coords, { color: INK, weight: 6, opacity: 0.55 })
      .on('click', () => select(route)).bindTooltip(route.title, { sticky: true }).addTo(routeLayer);
    L.polyline(route.coords, { color: GOLD, weight: 2, opacity: 0.9, dashArray: '2 7', interactive: false }).addTo(routeLayer);
  }
  if (!selected) return;
  L.polyline(selected.coords, { color: GOLD, weight: 16, opacity: 0.55, className: 'route-glow', interactive: false }).addTo(routeLayer);
  L.polyline(selected.coords, { color: INK, weight: 9, opacity: 0.9 }).addTo(routeLayer);
  let from = 0;
  for (let i = 1; i <= selected.segState.length; i++) {
    if (i < selected.segState.length && selected.segState[i] === selected.segState[from]) continue;
    L.polyline(selected.coords.slice(from, i + 1),
      { color: STATE[selected.segState[from]].color, weight: 5, opacity: 1 }).addTo(routeLayer);
    from = i;
  }
  for (const poi of selected.shownPois) {
    L.circleMarker([poi.lat, poi.lon], { radius: 4, color: INK, weight: 2, fillColor: '#fff7dd', fillOpacity: 1 })
      .bindTooltip(`${poi.name} (${KIND[poi.kind]})`).addTo(routeLayer);
  }
  for (const poi of selected.food) {
    L.circleMarker([poi.lat, poi.lon], { radius: 4, color: INK, weight: 2, fillColor: '#ff9d7a', fillOpacity: 1 })
      .bindTooltip(`${poi.name} (${KIND[poi.kind]})`).addTo(routeLayer);
  }
  for (const poi of selected.play) {
    L.circleMarker([poi.lat, poi.lon], { radius: 5, color: INK, weight: 2, fillColor: PLAY_COLOR, fillOpacity: 1 })
      .bindTooltip(poi.name).addTo(routeLayer);
  }
  L.circleMarker(selected.coords[0], LANTERN).bindTooltip('Start').addTo(routeLayer);
}

/** Fits the map to the coordinates, clear of the panel. */
function fit(coords) {
  const wide = window.matchMedia('(min-width: 761px)').matches;
  map.fitBounds(L.latLngBounds(coords), { paddingTopLeft: [wide ? 460 : 30, 40], paddingBottomRight: [40, 40] });
}

// The button on the map that shows where you are. The first press asks the browser for the
// position; after that the dot follows you, and a press brings the map back to it.
const ME_ZOOM = 16;
const ME_ICON = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const LOCATE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" '
  + 'stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2.2" '
  + 'fill="currentColor" stroke="none"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/></svg>';
const PERMISSION_DENIED = 1;
const me = { watch: undefined, marker: null, at: null };
const locateButton = el('button', { type: 'button', className: 'locate', title: 'Vis hvor jeg er', innerHTML: LOCATE_SVG });
locateButton.setAttribute('aria-label', 'Vis hvor jeg er');

function stopLocating(message) {
  if (me.watch !== undefined) navigator.geolocation.clearWatch(me.watch);
  me.marker?.remove();
  Object.assign(me, { watch: undefined, marker: null, at: null });
  locateButton.classList.remove('asking', 'on');
  status(message, true);
}

function locate() {
  if (me.watch !== undefined) {
    if (me.at) map.setView(me.at, Math.max(map.getZoom(), ME_ZOOM), { animate: true });
    return;
  }
  if (!navigator.geolocation) { status('Nettleseren gir ikke posisjon.', true); return; }
  locateButton.classList.add('asking');
  me.watch = navigator.geolocation.watchPosition(
    (p) => {
      const first = !me.at;
      me.at = [p.coords.latitude, p.coords.longitude];
      if (!me.marker) me.marker = L.marker(me.at, { icon: ME_ICON, interactive: false, zIndexOffset: 900 });
      me.marker.setLatLng(me.at);
      if (walk) return;       // the walk draws its own dot
      me.marker.addTo(map);
      if (!first) return;
      locateButton.classList.replace('asking', 'on');
      map.setView(me.at, Math.max(map.getZoom(), ME_ZOOM), { animate: true });
    },
    (error) => {
      // A lost signal after the first fix leaves the dot where it was; the watch keeps trying.
      if (me.at && error.code !== PERMISSION_DENIED) return;
      stopLocating('Fikk ikke posisjonen din. Gi siden lov til å se den i nettleseren.');
    },
    { enableHighAccuracy: true, maximumAge: 2000 });
}

const locateControl = L.control({ position: 'topright' });
locateControl.onAdd = () => {
  const box = el('div', { className: 'leaflet-control' }, locateButton);
  L.DomEvent.disableClickPropagation(box);
  locateButton.addEventListener('click', locate);
  return box;
};
locateControl.addTo(map);

map.on('click', (event) => {
  if (!picking) return;
  points[picking] = [event.latlng.lat, event.latlng.lng];
  picking = choice.end === 'map' && !points.end ? 'end' : null;
  drawPoints();
  updateHints();
});

// --- the form --------------------------------------------------------------------------------

const minuteOfDay = (date) => date.getHours() * 60 + date.getMinutes();

/** The hour the trip is for: now, or another time today. */
function chosenTime() {
  const time = new Date();
  if (clockMin !== null) time.setHours(0, clockMin, 0, 0);
  return time;
}

function setClock(min) {
  clockMin = min === null ? null
    : Math.min(DAY_MIN - CLOCK_STEP_MIN, Math.max(0, Math.round(min / CLOCK_STEP_MIN) * CLOCK_STEP_MIN));
  updateHints();
}

function updateHints() {
  const sun = sunPosition(chosenTime(), OSLO_CENTER[0], OSLO_CENTER[1]);
  const at = clock(chosenTime());
  $('sun-hint').textContent = sun.altitudeDeg > 0.5
    ? `Sola står ${Math.round(sun.altitudeDeg)}° over byen. Dra i himmelen for å skru klokka.`
    : 'Sola er nede, så lyktene teller. Dra i himmelen for å skru klokka.';
  $('clock-out').textContent = at;
  $('clock').value = minuteOfDay(chosenTime());
  $('now').hidden = clockMin === null;
  setScene($('scene'), chosenTime());
  $('map').classList.toggle('picking', Boolean(picking));
  $('pick-hint').textContent = picking === 'start' ? 'Klikk i kartet der turen skal starte.'
    : picking === 'end' ? 'Klikk i kartet der turen skal slutte.' : '';
  $('length-out').textContent = `${String($('length').value).replace('.', ',')} km, ca. ${minutes($('length').value * 1000, speed())} i ${String(speed()).replace('.', ',')} km/t`;
}

function onChoice(name, value) {
  choice[name] = value;
  if (name === 'mode') {
    const range = LENGTH_KM[value];
    Object.assign($('length'), { min: range.min, max: range.max, step: range.step });
    $('length').value = range.value;
    $('rolling-row').hidden = value === 'bike';
  }
  if (name === 'start') { points.start = null; picking = value === 'map' ? 'start' : null; }
  if (name === 'end') { points.end = null; if (value === 'map' && !picking) picking = 'end'; if (value === 'loop' && picking === 'end') picking = null; }
  drawPoints();
  updateHints();
}

for (const group of document.querySelectorAll('[data-choice]')) {
  group.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    for (const other of group.querySelectorAll('.chip')) other.setAttribute('aria-pressed', String(other === chip));
    onChoice(group.dataset.choice, chip.dataset.value);
  });
}
for (const group of document.querySelectorAll('[data-toggles]')) {
  group.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    wishes[chip.dataset.value] = !wishes[chip.dataset.value];
    chip.setAttribute('aria-pressed', String(wishes[chip.dataset.value]));
  });
}
/** What is asked for on this trip: the wishes, the light, and rolling only on foot. */
const asked = () => ({ ...wishes, rolling: wishes.rolling && choice.mode === 'walk', light: choice.light });
$('length').addEventListener('input', updateHints);
$('clock').addEventListener('input', () => setClock(Number($('clock').value)));
$('now').addEventListener('click', () => setClock(null));
setInterval(() => { if (clockMin === null) updateHints(); }, 30000);

// Dragging the sky turns the clock: the whole width is one day.
{
  const sky = document.querySelector('.scene');
  let drag = null;
  sky.addEventListener('pointerdown', (event) => {
    if (event.target.closest('input, button')) return;
    drag = { x: event.clientX, min: minuteOfDay(chosenTime()) };
    sky.setPointerCapture(event.pointerId);
  });
  sky.addEventListener('pointermove', (event) => {
    if (drag) setClock(drag.min + (event.clientX - drag.x) / sky.clientWidth * DAY_MIN);
  });
  const release = () => { drag = null; };
  sky.addEventListener('pointerup', release);
  sky.addEventListener('pointercancel', release);
}

// --- search ----------------------------------------------------------------------------------

function status(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function position() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Nettleseren gir ikke posisjon.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.latitude, p.coords.longitude]),
      () => reject(new Error('Fikk ikke posisjonen din. Gi siden lov til å se den, eller velg start i kartet.')),
      { enableHighAccuracy: true, timeout: 15000 });
  });
}

async function startPlaces(meta, rng) {
  const inside = ([lat, lon]) => lat > meta.lat0 && lat < meta.lat1 && lon > meta.lon0 && lon < meta.lon1;
  if (choice.start === 'app') {
    const pool = HUBS.slice();
    const picked = [];
    const wanted = choice.end === 'map' ? 1 : APP_STARTS[choice.mode];
    while (picked.length < wanted) {
      const [name, lat, lon] = pool.splice(Math.floor(rng() * pool.length), 1)[0];
      picked.push({ name, at: [lat, lon] });
    }
    return picked;
  }
  if (choice.start === 'map' && !points.start) throw new Error('Klikk i kartet der turen skal starte først.');
  const at = choice.start === 'me' ? (me.at ?? await position()) : points.start;
  if (!inside(at)) throw new Error('Det punktet ligger utenfor kartet appen har over Oslo.');
  points.start = at;
  drawPoints();
  return [{ name: choice.start === 'me' ? 'der du er' : 'punktet ditt', at }];
}

function nameRoutes(found) {
  const taken = new Set();
  for (const route of found) {
    let picks = route.wanted.filter((p) => p.name && p.weight >= 2 && !aside(p) && !taken.has(p.name))
      .slice(0, 2).map((p) => p.name);
    if (!picks.length) picks = route.streets.filter((s) => !taken.has(s)).slice(0, 2);
    if (!picks.length) picks = route.streets.slice(0, 1);
    picks.forEach((p) => taken.add(p));
    route.title = picks.length ? `Via ${list(picks)}` : 'Runde i nabolaget';
    const names = new Set();
    const fresh = (p) => p.name && !names.has(p.name) && names.add(p.name);
    route.shownPois = route.pois.filter((p) => !aside(p) && fresh(p)).slice(0, 14);
    // Places to eat, in the order they come, thinned to a handful spread along the trip.
    const food = route.scored.wishes.food
      ? route.pois.filter((p) => FOOD.has(p.kind) && fresh(p)).sort((a, b) => a.atM - b.atM) : [];
    route.foodCount = food.length;
    route.food = spread(food, FOOD_SHOWN);
    // Playgrounds, in the order they come; most have no name in the map data.
    const play = route.scored.wishes.play
      ? route.pois.filter((p) => p.kind === PLAY).sort((a, b) => a.atM - b.atM).map((p) => ({ ...p, name: p.name || 'Lekeplass' })) : [];
    route.playCount = play.length;
    route.play = spread(play, PLAY_SHOWN);
    route.why = reasons(route);
    route.verse = verse(route);
  }
}

/** Two short lines about what the trip is like, from its numbers. */
function verse(route) {
  const { stats, share, scored } = route;
  const pick = (lines) => lines[Math.floor(Math.random() * lines.length)];
  const sunShare = share(stats.sunM);
  let light;
  if (!scored.day) {
    light = share(stats.litM) > 0.85 ? pick(['Lyktene er tent hele veien.', 'Du går fra lykt til lykt.'])
      : pick(['Mørket får noen strekninger for seg selv.', 'Noen steder er det bare du og natta.']);
  } else if (scored.light === 'shade') {
    light = sunShare < 0.45 ? pick(['Skyggene holder deg med selskap.', 'Veien holder seg i ly for sola.'])
      : 'Sola finner deg likevel, her og der.';
  } else {
    light = sunShare > 0.85 ? pick(['Sola følger deg nesten hele veien.', 'Lyset ligger langs hele runden.'])
      : sunShare > 0.6 ? pick(['Mest sol, med svale pauser.', 'Sola kommer og går mellom husene.'])
        : 'Sol og skygge bytter på.';
  }
  const more = [];
  if (stats.waterM >= 800) more.push(pick(['Vannet er aldri langt unna.', 'Du har vann ved siden av deg lenge.']));
  if (share(stats.greenM) >= 0.6) more.push(pick(['Trærne står tett.', 'Det er løv over deg det meste av veien.']));
  if (route.foodCount >= 4) more.push(pick(['Det lukter kaffe og nybakt underveis.', 'Det er aldri langt til en kopp kaffe.']));
  const sight = route.wanted.find((p) => p.name && p.weight >= 3 && !aside(p));
  if (sight) more.push(`Underveis venter ${sight.name}.`);
  if (!more.length) more.push('Rolige gater, lite hastverk.');
  return `${light} ${pick(more)}`;
}

function reasons(route) {
  const { stats, share, scored } = route;
  const why = [];
  const at = clock(scored.time);
  if (scored.day) {
    if (scored.light === 'shade') why.push(`${percent(1 - share(stats.sunM))} av turen ligger i skygge kl. ${at}.`);
    else why.push(`${percent(share(stats.sunM))} av turen ligger i sol kl. ${at}.`);
  } else {
    why.push(`${percent(share(stats.litM))} av turen har gatelys (kjent eller sannsynlig).`);
  }
  if (share(stats.greenM) >= 0.25) why.push(`${percent(share(stats.greenM))} går langs trær eller gjennom parker og skog.`);
  if (stats.waterM >= 200) why.push(`${km(stats.waterM)} går langs vann.`);
  if (share(stats.quietM) >= 0.5) why.push(`${percent(share(stats.quietM))} går på gangveier og rolige gater.`);
  const named = route.wanted.filter((p) => p.name && !aside(p)).slice(0, 5).map((p) => p.name);
  if (named.length) why.push(`Du passerer ${list(named)}.`);
  if (route.foodCount === 1) why.push(`Du går forbi ${route.food[0].name}, om du blir sulten.`);
  else if (route.foodCount > 1) {
    why.push(`Du går forbi ${route.foodCount} steder å spise, blant annet ${list(route.food.slice(0, 3).map((p) => p.name))}.`);
  }
  if (scored.wishes.rolling) {
    why.push(stats.roughM < ROUGH_WORTH_SAYING_M ? 'Ingen trapper og ingen grov sti: turen kan trilles.'
      : `Ingen trapper, men ${km(stats.roughM)} går på grov sti.`);
  }
  if (route.playCount === 1) why.push(`Du går forbi én lekeplass, ${km(route.play[0].atM)} ut i turen.`);
  else if (route.playCount > 1) why.push(`Du går forbi ${route.playCount} lekeplasser, den første etter ${km(route.play[0].atM)}.`);
  if (route.streets.length) why.push(`Ruta går blant annet via ${list(route.streets)}.`);
  if (share(stats.repeatM) > 0.1) why.push(`${km(stats.repeatM / 2)} går du fram og tilbake langs samme strekning.`);
  return why;
}

async function search(event) {
  event.preventDefault();
  $('go').disabled = true;
  routes = [];
  selected = null;
  drawRoutes();
  $('results').replaceChildren();
  try {
    const meta = await loadMeta();
    const rng = mulberry32((Math.random() * 2 ** 32) >>> 0);
    const lengthM = $('length').value * 1000;
    const start = chosenTime();
    const speedKmh = speed();
    const middle = new Date(start.getTime() + lengthM / 1000 / speedKmh * 1800000);
    if (choice.end === 'map' && !points.end) throw new Error('Klikk i kartet der turen skal slutte først.');
    const places = await startPlaces(meta, rng);
    const found = [];
    for (const place of places) {
      const end = choice.end === 'map' ? points.end : place.at;
      const center = { lat: (place.at[0] + end[0]) / 2, lon: (place.at[1] + end[1]) / 2 };
      const straightM = Math.hypot((end[0] - place.at[0]) * M_PER_DEG_LAT, (end[1] - place.at[1]) * M_PER_DEG_LON);
      const radiusM = Math.min(MAX_RADIUS_M, straightM / 2 + lengthM * 0.33 + 400);
      status(`Bretter ut kartet rundt ${place.name} …`);
      const graph = await loadGraph(center, radiusM, (done, total) => status(`Bretter ut kartet rundt ${place.name}: ${done} av ${total} …`));
      const prep = prepare(graph, choice.mode, asked().rolling);
      const scored = scoreSegments(graph, choice.mode, asked(), middle);
      const node = (at) => nearestNode(graph, prep, (at[1] - center.lon) * graph.mPerDegLon, (at[0] - center.lat) * M_PER_DEG_LAT);
      const startNode = node(place.at);
      const endNode = choice.end === 'map' ? node(end) : startNode;
      if (startNode === -1 || endNode === -1) continue;
      const here = await findRoutes(graph, prep, scored, { startNode, endNode, lengthM }, rng,
        Math.ceil(TRIES / places.length) + 2, (i, n) => status(`Leter etter veier fra ${place.name}: ${i} av ${n} …`));
      here.forEach((route) => Object.assign(route, { from: place.name, mode: choice.mode, pace: choice.pace, speedKmh, askedM: lengthM,
        clockMin }));
      found.push(...here);
    }
    if (!found.length) throw new Error('Fant ingen runde der. Prøv et annet startpunkt eller en annen lengde.');
    routes = found.sort((a, b) => b.score - a.score).slice(0, SHOWN_ROUTES);
    nameRoutes(routes);
    const fallback = choice.light !== 'any' && choice.light !== 'lit' && !routes[0].scored.day;
    status(`${routes.length} veier, den fineste først.${fallback ? ` Sola er nede kl. ${clock(middle)}, så lyktene teller i stedet.` : ''}`);
    renderResults();
    drawRoutes();
    fit(routes.flatMap((r) => r.coords));
    $('go').textContent = 'Nye veier';
  } catch (error) {
    status(error.message, true);
  }
  $('go').disabled = false;
}
$('form').addEventListener('submit', search);

function lightBar(route) {
  const bar = el('div', { className: 'lightbar' });
  const sums = {};
  route.segState.forEach((state, i) => { sums[state] = (sums[state] || 0) + route.cumM[i + 1] - route.cumM[i]; });
  for (const state of Object.keys(STATE)) {
    if (sums[state]) bar.append(el('i', { className: state, style: `width:${(sums[state] / route.lengthM) * 100}%` }));
  }
  bar.title = Object.keys(sums).map((s) => `${STATE[s].label} ${percent(sums[s] / route.lengthM)}`).join(', ');
  return [bar, Object.keys(STATE).filter((s) => sums[s])];
}

function renderResults() {
  $('results').replaceChildren(...routes.map((route, i) => {
    const button = el('button', { type: 'button', className: 'result' }, [
      el('span', { className: 'rank', textContent: ROMAN[i] }),
      el('h2', { textContent: route.title }),
      el('span', { className: 'score', textContent: route.score, title: 'Poeng av 100' }),
      el('p', { className: 'verse', textContent: route.verse }),
      el('p', { className: 'meta', textContent: `${km(route.lengthM)} · ${minutes(route.lengthM, route.speedKmh)} · fra ${route.from}` }),
      lightBar(route)[0],
    ]);
    button.addEventListener('click', () => select(route));
    return el('li', {}, button);
  }));
}

// --- one route -------------------------------------------------------------------------------

function show(view) {
  for (const name of ['plan', 'detail', 'nav']) $(`${name}-view`).hidden = name !== view;
  $('layout').classList.toggle('walking', view === 'nav');
  $('panel').scrollTop = 0;
  map.invalidateSize();
}

function select(route) {
  selected = route;
  drawRoutes();
  if (!route) { show('plan'); return; }
  const [bar, states] = lightBar(route);
  const fact = (label, value) => el('div', {}, [el('dt', { textContent: label }), el('dd', { textContent: value })]);
  const along = route.shownPois.slice().sort((a, b) => a.atM - b.atM)
    .map((p) => el('li', { textContent: `${km(p.atM)}: ${p.name} (${KIND[p.kind]})` }));
  $('detail').replaceChildren(el('article', { className: 'detail' }, [
    el('h2', { textContent: route.title }),
    el('p', { className: 'verse', textContent: route.verse }),
    el('p', { className: 'sub', textContent: `${ROMAN[routes.indexOf(route)]} av ${ROMAN[routes.length - 1]} · fra ${route.from}` }),
    el('dl', { className: 'facts' }, [
      fact('Lengde', km(route.lengthM)), fact('Tid', minutes(route.lengthM, route.speedKmh)), fact('Poeng', `${route.score} / 100`),
    ]),
    el('h3', { textContent: 'Hvorfor denne' }),
    el('ul', { className: 'why' }, route.why.map((text) => el('li', { textContent: text }))),
    el('h3', { textContent: `Lys langs ruta kl. ${clock(route.scored.time)}` }),
    bar,
    el('ul', { className: 'legend' }, states.map((s) => el('li', {}, [el('i', { className: s }), STATE[s].label]))),
    ...(along.length ? [el('h3', { textContent: 'Underveis' }), el('ul', { className: 'why' }, along)] : []),
    ...(route.food.length ? [el('h3', { textContent: 'Mat langs veien' }), el('ul', { className: 'why' },
      route.food.map((p) => el('li', { textContent: `${km(p.atM)}: ${p.name} (${KIND[p.kind]})` })))] : []),
    ...(route.play.length ? [el('h3', { textContent: 'Lekeplasser langs veien' }), el('ul', { className: 'why' },
      route.play.map((p) => el('li', { textContent: `${km(p.atM)}: ${p.name}` })))] : []),
    el('div', { className: 'actions' }, [
      el('button', { type: 'button', className: 'primary', textContent: 'Start turen', onclick: () => startWalk(false) }),
      el('button', { type: 'button', className: 'secondary', textContent: 'Forhåndsvis turen', onclick: () => startWalk(true) }),
      el('button', { type: 'button', className: 'secondary', textContent: 'Del turen', onclick: (event) => share(route, event.currentTarget) }),
      el('button', { type: 'button', className: 'secondary', textContent: 'Last ned GPX', onclick: () => downloadGpx(route) }),
    ]),
  ]));
  show('detail');
  fit(route.coords);
}
$('back').addEventListener('click', () => select(null));

// --- sharing a trip --------------------------------------------------------------------------
// The whole trip is in the link, after #tur=: how it was asked for and every point of the path.
// The page has no server to keep it on.

const SHARE_KEY = '#tur=';
const SHARE_VERSION = '1';
const SHARE_DEG = 1e5;          // points are kept to about a metre
const SHARE_MARGIN_M = 300;
const SHARE_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const WISH_LETTER = { trees: 't', water: 'w', art: 'a', history: 'h', view: 'v', food: 'f', play: 'p', rolling: 'r' };
const LIGHT_LETTER = { sun: 's', shade: 'h', lit: 'l', any: 'a' };
const letterOf = (table, letter) => Object.keys(table).find((key) => table[key] === letter);

/** Whole numbers as text: five bits a digit, the sixth says that more follow. */
function packNumbers(numbers) {
  let text = '';
  for (const number of numbers) {
    let rest = number < 0 ? -2 * number - 1 : 2 * number;
    do {
      const digit = rest % 32;
      rest = Math.floor(rest / 32);
      text += SHARE_DIGITS[digit + (rest ? 32 : 0)];
    } while (rest);
  }
  return text;
}

function unpackNumbers(text) {
  const numbers = [];
  let value = 0;
  let scale = 1;
  for (const char of text) {
    const digit = SHARE_DIGITS.indexOf(char);
    if (digit === -1) throw new Error('bad digit');
    value += (digit % 32) * scale;
    scale *= 32;
    if (digit < 32) {
      numbers.push(value % 2 ? -(value + 1) / 2 : value / 2);
      value = 0;
      scale = 1;
    }
  }
  return numbers;
}

function shareLink(route) {
  const numbers = [];
  let before = [0, 0];
  for (const [lat, lon] of route.coords) {
    const now = [Math.round(lat * SHARE_DEG), Math.round(lon * SHARE_DEG)];
    numbers.push(now[0] - before[0], now[1] - before[1]);
    before = now;
  }
  const { wishes: w, light } = route.scored;
  const fields = [SHARE_VERSION, route.mode[0] + route.pace[0], Math.round(route.askedM / 100), LIGHT_LETTER[light],
    Object.keys(WISH_LETTER).filter((key) => w[key]).map((key) => WISH_LETTER[key]).join('') || '-',
    route.clockMin ?? 'n', packNumbers(numbers)];
  return `${location.origin}${location.pathname}${SHARE_KEY}${fields.join('.')}`;
}

async function share(route, button) {
  const url = shareLink(route);
  const say = (text) => {
    button.textContent = text;
    setTimeout(() => { button.textContent = 'Del turen'; }, COPIED_SHOWN_MS);
  };
  if (navigator.share) {
    try { await navigator.share({ title: `Oslo-turer: ${route.title}`, url }); return; } catch (error) {
      if (error.name === 'AbortError') return;      // closed without sharing
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    say('Lenka er kopiert');
  } catch {
    window.prompt('Kopier lenka:', url);
  }
}

/** Shows the pressed chips as the choices and wishes are. */
function syncChips() {
  for (const group of document.querySelectorAll('[data-choice]')) {
    for (const chip of group.querySelectorAll('.chip')) {
      chip.setAttribute('aria-pressed', String(chip.dataset.value === choice[group.dataset.choice]));
    }
  }
  for (const chip of document.querySelectorAll('[data-toggles] .chip')) {
    chip.setAttribute('aria-pressed', String(Boolean(wishes[chip.dataset.value])));
  }
}

/** Opens the trip in the link, if the page was opened with one. */
async function openShared() {
  if (!location.hash.startsWith(SHARE_KEY)) return;
  try {
    let parsed;
    try {
      const [version, how, length, light, letters, minute, path] = location.hash.slice(SHARE_KEY.length).split('.');
      const mode = { w: 'walk', b: 'bike' }[how[0]];
      const pace = { s: 'slow', n: 'normal', f: 'fast' }[how[1]];
      const numbers = unpackNumbers(path);
      const coords = [];
      let at = [0, 0];
      for (let i = 0; i + 1 < numbers.length; i += 2) {
        at = [at[0] + numbers[i], at[1] + numbers[i + 1]];
        coords.push([at[0] / SHARE_DEG, at[1] / SHARE_DEG]);
      }
      const askedM = Number(length) * 100;
      const minuteOfTrip = minute === 'n' ? null : Number(minute);
      const lightName = letterOf(LIGHT_LETTER, light);
      if (version !== SHARE_VERSION || !mode || !pace || !lightName || !(askedM > 0) || coords.length < 2
        || !(minuteOfTrip === null || (minuteOfTrip >= 0 && minuteOfTrip < DAY_MIN))) throw new Error('bad link');
      parsed = { mode, pace, askedM, light: lightName, letters, minuteOfTrip, coords };
    } catch {
      throw new Error('Lenka til turen er ikke hel. Be om å få den en gang til.');
    }
    const { coords } = parsed;
    onChoice('mode', parsed.mode);
    Object.assign(choice, { pace: parsed.pace, light: parsed.light, start: 'app', end: 'loop' });
    for (const key of Object.keys(WISH_LETTER)) wishes[key] = parsed.letters.includes(WISH_LETTER[key]);
    $('length').value = parsed.askedM / 1000;
    picking = null;
    points.start = null;
    points.end = null;
    drawPoints();
    syncChips();
    setClock(parsed.minuteOfTrip);

    status('Henter turen du fikk …');
    const lats = coords.map((c) => c[0]);
    const lons = coords.map((c) => c[1]);
    const center = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 };
    const radiusM = SHARE_MARGIN_M + Math.max(...coords.map(([lat, lon]) =>
      Math.hypot((lat - center.lat) * M_PER_DEG_LAT, (lon - center.lon) * M_PER_DEG_LON)));
    const graph = await loadGraph(center, radiusM, (done, total) => status(`Henter turen du fikk: ${done} av ${total} …`));
    const prep = prepare(graph, choice.mode, asked().rolling);
    const speedKmh = speed();
    const middle = new Date(chosenTime().getTime() + parsed.askedM / 1000 / speedKmh * 1800000);
    const route = routeFromCoords(graph, prep, scoreSegments(graph, choice.mode, asked(), middle), coords, parsed.askedM);
    if (!route) throw new Error('Fant ikke turen i kartet. Den kan være laget på et eldre kart.');
    Object.assign(route, { from: 'en delt lenke', mode: choice.mode, pace: choice.pace, speedKmh, askedM: parsed.askedM, clockMin });
    routes = [route];
    nameRoutes(routes);
    status('Turen du fikk. «Finn en vei» lager nye med de samme ønskene.');
    renderResults();
    select(route);
  } catch (error) {
    status(error.message, true);
  }
}
window.addEventListener('hashchange', openShared);

function downloadGpx(route) {
  const safe = (text) => text.replace(/[<>&]/g, '');
  const body = route.coords.map(([lat, lon]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Oslo-turer" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${safe(route.title)}</name><trkseg>${body}</trkseg></trk></gpx>`;
  const link = el('a', { href: URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' })), download: 'oslo-tur.gpx' });
  link.click();
  URL.revokeObjectURL(link.href);
}

// --- while walking ---------------------------------------------------------------------------

function startWalk(simulated) {
  const route = selected;
  me.marker?.remove();
  walk = { route, index: 0, simulated, marker: L.marker(route.coords[0], { icon: ME_ICON, zIndexOffset: 1000 }).addTo(map) };
  show('nav');
  $('nav').replaceChildren(el('p', { className: 'status', textContent: simulated ? '' : 'Venter på posisjonen din …' }));
  if (simulated) {
    let atM = 0;
    walk.timer = setInterval(() => {
      atM = Math.min(route.lengthM, atM + SIMULATION_STEP_M[route.mode]);
      let i = walk.index;
      while (i + 1 < route.cumM.length - 1 && route.cumM[i + 1] < atM) i++;
      const f = (atM - route.cumM[i]) / Math.max(1, route.cumM[i + 1] - route.cumM[i]);
      const [a, b] = [route.coords[i], route.coords[i + 1]];
      onPosition(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
      if (atM >= route.lengthM) clearInterval(walk.timer);
    }, SIMULATION_TICK_MS);
  } else {
    walk.watch = navigator.geolocation.watchPosition(
      (p) => onPosition(p.coords.latitude, p.coords.longitude),
      () => $('nav').replaceChildren(el('p', { className: 'status error', textContent: 'Får ikke posisjonen din. Gi siden lov til å se den i nettleseren.' })),
      { enableHighAccuracy: true, maximumAge: 2000 });
    navigator.wakeLock?.request('screen').then((lock) => { if (walk) walk.lock = lock; else lock.release(); }).catch(() => {});
  }
}

function onPosition(lat, lon) {
  if (!walk) return;
  const { route } = walk;
  const distanceTo = (i) => Math.hypot((route.coords[i][0] - lat) * M_PER_DEG_LAT, (route.coords[i][1] - lon) * M_PER_DEG_LON);
  const nearest = (from, to) => {
    let best = from;
    for (let i = from; i <= to; i++) if (distanceTo(i) < distanceTo(best)) best = i;
    return best;
  };
  const last = route.coords.length - 1;
  let index = nearest(Math.max(0, walk.index - 3), Math.min(last, walk.index + 40));
  if (distanceTo(index) > OFF_ROUTE_M * 1.5) index = nearest(0, last);
  walk.index = index;
  const offM = distanceTo(index);
  const atM = route.cumM[index];
  const leftM = route.lengthM - atM;
  const segment = Math.min(index, route.segState.length - 1);
  const state = lightNow(route, segment, walk.simulated ? route.scored.time : new Date(), lat, lon);
  const next = [...route.shownPois, ...route.food, ...route.play].filter((p) => p.atM > atM + 15).sort((a, b) => a.atM - b.atM)[0];
  const done = leftM < 40 && atM > route.lengthM / 2;

  walk.marker.setLatLng([lat, lon]);
  map.setView([lat, lon], Math.max(map.getZoom(), 17), { animate: true });
  $('nav').replaceChildren(
    el('div', { className: 'navcard' }, [
      el('p', { className: 'label', textContent: done ? 'Framme' : 'Gjenstår' }),
      el('p', { className: 'big', textContent: done ? 'Turen er gått' : `${km(leftM)} · ${minutes(leftM, route.speedKmh)}` }),
      ...(offM > OFF_ROUTE_M ? [el('p', { className: 'status error', textContent: `Du er ${km(offM)} fra ruta.` })] : []),
    ]),
    el('div', { className: 'navcard' }, [
      el('p', { className: 'label', textContent: 'Akkurat her' }),
      el('p', {}, [
        el('span', { className: `badge ${state}`, textContent: STATE[state].label }),
        route.green[segment] >= 0.5 ? ' Trær langs veien.' : '',
      ]),
    ]),
    el('div', { className: 'navcard' }, [
      el('p', { className: 'label', textContent: 'Neste' }),
      el('p', { textContent: next ? `Om ${km(next.atM - atM)}: ${next.name}${next.kind === PLAY ? '' : ` (${KIND[next.kind]})`}` : 'Ikke mer å se etter før du er framme.' }),
    ]),
  );
}

$('stop').addEventListener('click', () => {
  if (!walk) return;
  clearInterval(walk.timer);
  if (walk.watch !== undefined) navigator.geolocation.clearWatch(walk.watch);
  walk.lock?.release();
  walk.marker.remove();
  walk = null;
  me.marker?.addTo(map);
  show('detail');
  fit(selected.coords);
});

updateHints();
loadMeta().then(openShared, () => status('Kartdataene mangler. Kjør tools/build_data.py.', true));
setTimeout(() => $('veil').classList.add('lifted'), VEIL_MS);
