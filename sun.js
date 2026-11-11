// The sun's position (after the SunCalc formulas, Vladimir Agafonkin, BSD-2).

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

/** Altitude above the horizon and compass bearing (0 = north, 90 = east), both in degrees. */
export function sunPosition(date, lat, lon) {
  const days = date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
  const anomaly = RAD * (357.5291 + 0.98560028 * days);
  const centre = RAD * (1.9148 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly) + 0.0003 * Math.sin(3 * anomaly));
  const longitude = anomaly + centre + RAD * 102.9372 + Math.PI;
  const declination = Math.asin(Math.sin(OBLIQUITY) * Math.sin(longitude));
  const rightAscension = Math.atan2(Math.sin(longitude) * Math.cos(OBLIQUITY), Math.cos(longitude));
  const hourAngle = RAD * (280.16 + 360.9856235 * days) + RAD * lon - rightAscension;
  const phi = RAD * lat;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(declination)
    + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle));
  const azimuth = Math.atan2(Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi));
  return { altitudeDeg: altitude / RAD, bearingDeg: ((azimuth / RAD + 180) % 360 + 360) % 360 };
}
