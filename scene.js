// The picture at the top: Oslo seen from the fjord, in the light of the chosen hour.
// The sky, the sun, the stars and the windows follow the sun's real altitude; the skyline is drawn by hand.

import { sunPosition } from './sun.js';

const OSLO = [59.91, 10.74];
const WIDTH = 400;
const HEIGHT = 150;
const WATERLINE = 112;
const HILLTOP_Y = 66;        // the sun sets behind the hills here
const STAR_COUNT = 70;
const NIGHT_BELOW_DEG = -6;
const SUN_UP_DEG = 0.5;
const GOLDEN_BELOW_DEG = 9;
const SUN_GONE_BELOW_DEG = -5;
// The sun crosses the picture from the east (left) to the west (right).
const BEARING_LEFT_DEG = 50;
const BEARING_RIGHT_DEG = 310;
const ALTITUDE_TOP_DEG = 55;

// A small repeatable random source, so the stars and windows stay where they are.
function random(seed) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function windows(rng, x, y, width, height, step = 3) {
  let out = '';
  for (let wx = x + 1.2; wx < x + width - 1; wx += step) {
    for (let wy = y + 2; wy < y + height - 2; wy += step) {
      if (rng() < 0.55) out += `<rect x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="1" height="1.2"/>`;
    }
  }
  return out;
}

function draw() {
  const rng = random(1814);
  let stars = '';
  for (let i = 0; i < STAR_COUNT; i++) {
    stars += `<circle cx="${(rng() * WIDTH).toFixed(1)}" cy="${(rng() * 78).toFixed(1)}" r="${(0.25 + rng() * 0.6).toFixed(2)}" opacity="${(0.4 + rng() * 0.6).toFixed(2)}"/>`;
  }
  // The Barcode row: slabs of different heights.
  const slabs = [[298, 30], [305, 22], [312, 36], [320, 27], [327, 33], [335, 24], [342, 29]];
  const barcode = slabs.map(([x, h]) => `<rect x="${x}" y="${WATERLINE - h}" width="5.5" height="${h}"/>`).join('');
  const lights = windows(rng, 163, 78, 11, 20) + windows(rng, 182, 78, 11, 20) + windows(rng, 160, 98, 36, 12)
    + slabs.map(([x, h]) => windows(rng, x, WATERLINE - h, 5.5, h, 2.6)).join('')
    + windows(rng, 108, 100, 44, 11) + windows(rng, 356, 76, 12, 34, 2.8) + windows(rng, 206, 103, 34, 8, 4);
  let ripples = '';
  for (let i = 0; i < 26; i++) {
    const y = WATERLINE + 3 + rng() * 32;
    const length = 6 + rng() * 26;
    ripples += `<line x1="${(rng() * WIDTH).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(rng() * WIDTH + length).toFixed(1)}" y2="${y.toFixed(1)}" opacity="${(0.15 + rng() * 0.35).toFixed(2)}"/>`;
  }
  return `
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="sky-top"/><stop offset="0.6" class="sky-mid"/><stop offset="1" class="sky-low"/>
    </linearGradient>
    <linearGradient id="fjord" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="sky-low"/><stop offset="0.5" class="sky-mid"/><stop offset="1" class="sky-top"/>
    </linearGradient>
    <radialGradient id="halo"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.25" stop-color="#ffd98a" stop-opacity="0.55"/><stop offset="1" stop-color="#ffd98a" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${WIDTH}" height="${WATERLINE}" fill="url(#sky)"/>
  <g class="stars" fill="#fff">${stars}</g>
  <g class="moon"><circle cx="338" cy="26" r="7" fill="#f3efdc"/><circle cx="341" cy="24" r="6.4" class="moon-bite"/></g>
  <g class="sun"><circle r="30" fill="url(#halo)"/><circle r="5.5" class="sun-disc"/></g>
  <g class="hills">
    <path d="M0,92 C28,70 52,58 78,60 C104,54 122,66 150,70 C190,60 226,66 262,72 C300,64 344,70 400,84 L400,${WATERLINE} L0,${WATERLINE} Z"/>
    <path d="M50,64 q9,-15 23,-18 l1.2,2.6 q-11,4 -18,16 z"/>
    <path d="M94.4,58 L94.4,40 L95.6,40 L95.6,58 Z M93.2,47 h3.6 v2.4 h-3.6 z"/>
    <path d="M330,${WATERLINE} C350,92 372,84 400,80 L400,${WATERLINE} Z"/>
  </g>
  <g class="city">
    <path d="M104,${WATERLINE} v-9 h8 v-4 h9 v5 h7 v-7 h8 v6 h9 v-4 h8 v13 z"/>
    <rect x="160" y="97" width="36" height="15"/><rect x="163" y="77" width="11" height="35"/><rect x="182" y="77" width="11" height="35"/>
    <path d="M204,${WATERLINE} v-8 h6 v-2 h8 v-6 l3,-9 l3,9 v6 h10 v2 h6 v8 z"/>
    ${barcode}
    <path d="M356,${WATERLINE} V80 l5,-8 l7,2 V${WATERLINE} Z"/>
  </g>
  <path class="opera" d="M248,${WATERLINE} L262,100.5 L284,100.5 L294,${WATERLINE} Z M266,100.5 l4,-5 h12 l2,5 z"/>
  <g class="lights" fill="#ffd98a">${lights}</g>
  <rect y="${WATERLINE}" width="${WIDTH}" height="${HEIGHT - WATERLINE}" fill="url(#fjord)"/>
  <g class="ripples" stroke="#fff" stroke-width="0.5">${ripples}</g>`;
}

export function phaseOf(altitudeDeg) {
  if (altitudeDeg < NIGHT_BELOW_DEG) return 'night';
  if (altitudeDeg < SUN_UP_DEG) return 'blue';
  if (altitudeDeg < GOLDEN_BELOW_DEG) return 'golden';
  return 'day';
}

/** Sets the picture, and the page's phase (night, blue, golden, day), to the light at a time. */
export function setScene(svg, time) {
  if (!svg.firstChild) {
    svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMax slice');
    svg.innerHTML = draw();
  }
  const sun = sunPosition(time, OSLO[0], OSLO[1]);
  const phase = phaseOf(sun.altitudeDeg);
  document.body.dataset.phase = phase;
  const across = Math.min(1, Math.max(0, (sun.bearingDeg - BEARING_LEFT_DEG) / (BEARING_RIGHT_DEG - BEARING_LEFT_DEG)));
  const x = 20 + across * (WIDTH - 40);
  const y = HILLTOP_Y - (Math.max(sun.altitudeDeg, SUN_GONE_BELOW_DEG) / ALTITUDE_TOP_DEG) * (HILLTOP_Y - 12);
  const disc = svg.querySelector('.sun');
  disc.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  disc.style.opacity = sun.altitudeDeg > SUN_GONE_BELOW_DEG ? 1 : 0;
  return phase;
}
