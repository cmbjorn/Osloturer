# /// script
# requires-python = ">=3.11"
# dependencies = ["osmium", "shapely>=2", "numpy", "scipy"]
# ///
"""Build the map data the app routes on, from an OpenStreetMap extract of Oslo.

    uv run tools/build_data.py            (reads tools/osm/Oslo.osm.pbf, writes data/)

Every path and street is cut into segments of at most MAX_SEGMENT_M. Each segment gets:
  - a horizon: for 24 compass sectors, the elevation angle of the highest building edge
    within HORIZON_RADIUS_M. The app compares the sun's position with it to tell sun from shade.
  - lit: street lighting, from the lit tag, a lamp nearby, or a guess from the kind of way.
  - green: trees, tree rows, parks and forest along it (0-10).
  - water, forest, noisy (a main road nearby), paved, and what may use it (foot, bike).
Points of interest (art, viewpoints, historic sites, notable buildings, parks, playgrounds, places to eat) are written per tile.
"""
from __future__ import annotations

import datetime
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import osmium
import shapely
from scipy.spatial import cKDTree
from shapely import STRtree

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tools" / "osm" / "Oslo.osm.pbf"
OUT = ROOT / "data"

LAT0, LAT1 = 59.84, 60.01
LON0, LON1 = 10.58, 10.92
TILE_LAT_DEG, TILE_LON_DEG = 0.01, 0.02
M_PER_DEG_LAT = 111_400.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians((LAT0 + LAT1) / 2))
MARGIN_DEG = 0.003  # features just outside the area still cast shade and count as green

MAX_SEGMENT_M = 40.0
HORIZON_SECTORS = 24
HORIZON_RADIUS_M = 90.0
HORIZON_MIN_DISTANCE_M = 3.0
HORIZON_SPREAD_WITHIN_M = 15.0  # a wall this close fills the neighbouring sectors too
BUILDING_EDGE_STEP_M = 3.0
LEVEL_HEIGHT_M = 3.2
DEFAULT_HEIGHT_M = {"house": 6.5, "detached": 6.5, "semidetached_house": 6.5, "terrace": 7.0, "garage": 3.0,
                    "garages": 3.0, "shed": 2.5, "hut": 2.5, "cabin": 3.5, "roof": 3.0, "kiosk": 3.0,
                    "apartments": 15.0, "office": 18.0, "commercial": 14.0, "retail": 9.0, "school": 10.0,
                    "church": 18.0, "industrial": 9.0, "warehouse": 9.0, "hospital": 18.0, "university": 16.0}
FALLBACK_HEIGHT_M = 9.0

LAMP_RADIUS_M = 20.0
TREE_RADIUS_M = 15.0
GREEN_NEAR_M = 20.0
WATER_RADIUS_M = 40.0
MAIN_ROAD_RADIUS_M = 30.0
SECONDARY_ROAD_RADIUS_M = 15.0

HIGHWAY_CLASS = {"footway": 0, "path": 0, "pedestrian": 0, "steps": 0, "cycleway": 1, "track": 2,
                 "living_street": 3, "residential": 3, "service": 3, "unclassified": 3, "road": 3,
                 "tertiary": 4, "tertiary_link": 4, "secondary": 5, "secondary_link": 5,
                 "primary": 6, "primary_link": 6}
MAIN_ROADS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link"}
PAVED = {"asphalt", "paved", "concrete", "paving_stones", "sett", "concrete:plates", "concrete:lanes", "metal",
         "wood"}
UNPAVED = {"unpaved", "gravel", "fine_gravel", "compacted", "dirt", "earth", "ground", "grass", "sand", "mud",
           "pebblestone", "woodchips", "rock"}
GREEN_VALUE = {"forest": 1.0, "wood": 1.0, "park": 0.8, "garden": 0.8, "nature_reserve": 0.8, "cemetery": 0.8,
               "allotments": 0.6, "recreation_ground": 0.6, "village_green": 0.6, "grass": 0.4, "meadow": 0.4,
               "scrub": 0.5, "heath": 0.5, "grassland": 0.4, "farmland": 0.4, "orchard": 0.7}


# Places to eat and drink: (kind, weight). They count as something to pass when the walker asks for food.
FOOD_AMENITY = {"cafe": ("cafe", 1.0), "restaurant": ("restaurant", 1.0), "ice_cream": ("ice", 1.2),
                "pub": ("pub", 0.8), "bar": ("pub", 0.8), "fast_food": ("fastfood", 0.6),
                "food_court": ("restaurant", 1.0), "marketplace": ("restaurant", 1.5)}
FOOD_SHOP = {"bakery": ("bakery", 1.0), "pastry": ("bakery", 1.0), "ice_cream": ("ice", 1.2)}
# Playgrounds count only when the walker asks for them; most have no name.
PLAYGROUND_WEIGHT = 2.0


def to_xy(lon, lat):
    return (np.asarray(lon) - LON0) * M_PER_DEG_LON, (np.asarray(lat) - LAT0) * M_PER_DEG_LAT


def project(geom):
    return shapely.transform(geom, lambda c: np.column_stack(to_xy(c[:, 0], c[:, 1])))


def inside(lat, lon, margin=0.0):
    return LAT0 - margin <= lat <= LAT1 + margin and LON0 - margin <= lon <= LON1 + margin


def classify_poi(tags, is_area):
    """(kind, weight) of a point of interest, or None."""
    name = tags.get("name")
    tourism, historic = tags.get("tourism"), tags.get("historic")
    found = None
    if tourism == "viewpoint":
        found = ("view", 3.0)
    elif tourism == "artwork":
        found = ("art", 2.0 if name else 1.0)
    elif tourism == "attraction":
        found = ("sight", 3.0)
    elif tourism in ("museum", "gallery"):
        found = ("culture", 2.0)
    elif tags.get("waterway") == "waterfall":
        found = ("sight", 3.0)
    elif historic and historic != "no":
        small = historic == "memorial" and tags.get("memorial") in ("stolperstein", "plaque")
        found = ("history", 0.3 if small else (2.0 if name else 1.0))
    elif tags.get("leisure") == "playground" and tags.get("access") not in ("private", "no"):
        found = ("play", PLAYGROUND_WEIGHT)
    elif tags.get("amenity") == "fountain":
        found = ("art", 1.5)
    elif tags.get("amenity") == "place_of_worship" and name:
        found = ("building", 1.5)
    elif is_area and tags.get("leisure") == "park" and name:
        found = ("park", 1.5)
    elif is_area and tags.get("building") and name and (tags.get("wikidata") or tags.get("wikipedia")):
        found = ("building", 1.0)
    if found is None and name:
        found = FOOD_AMENITY.get(tags.get("amenity")) or FOOD_SHOP.get(tags.get("shop"))
    if found is None:
        return None
    bonus = 1.0 if (tags.get("wikidata") or tags.get("wikipedia")) else 0.0
    return found[0], found[1] + bonus


def building_height(tags):
    for key, scale, extra in (("height", 1.0, 0.0), ("building:levels", LEVEL_HEIGHT_M, 1.0)):
        raw = tags.get(key)
        if raw:
            try:
                return max(2.0, float(raw.replace("m", "").replace(",", ".").strip()) * scale + extra)
            except ValueError:
                pass
    return DEFAULT_HEIGHT_M.get(tags.get("building"), FALLBACK_HEIGHT_M)


class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.wkb = osmium.geom.WKBFactory()
        self.ways = []          # (tags dict, [(ref, lat, lon)])
        self.trees = []         # (lon, lat)
        self.lamps = []
        self.tree_rows = []     # [(lon, lat)]
        self.water_lines = []
        self.main_roads = []
        self.secondary_roads = []
        self.buildings = []     # (geometry in degrees, height)
        self.green = []         # (geometry, value, is forest)
        self.water_areas = []
        self.pois = []          # (lat, lon, kind, weight, name, radius m)

    def node(self, n):
        if not n.location.valid() or not inside(n.location.lat, n.location.lon, MARGIN_DEG):
            return
        tags = n.tags
        if tags.get("natural") == "tree":
            self.trees.append((n.location.lon, n.location.lat))
        elif tags.get("highway") == "street_lamp":
            self.lamps.append((n.location.lon, n.location.lat))
        poi = classify_poi(tags, False)
        if poi:
            self.pois.append((n.location.lat, n.location.lon, poi[0], poi[1], tags.get("name") or "", 0))

    def way(self, w):
        tags = w.tags
        highway = tags.get("highway")
        line_kind = None
        if highway in MAIN_ROADS:
            line_kind = self.main_roads
        elif highway in ("secondary", "secondary_link"):
            line_kind = self.secondary_roads
        elif tags.get("natural") == "tree_row":
            line_kind = self.tree_rows
        elif tags.get("natural") == "coastline" or (
                tags.get("waterway") in ("river", "stream", "canal") and tags.get("tunnel") is None):
            line_kind = self.water_lines
        routable = highway in HIGHWAY_CLASS
        if line_kind is None and not routable:
            return
        try:
            points = [(n.ref, n.lat, n.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(points) < 2 or not any(inside(lat, lon, MARGIN_DEG) for _, lat, lon in points):
            return
        if line_kind is not None:
            line_kind.append([(lon, lat) for _, lat, lon in points])
        if routable:
            if tags.get("access") in ("private", "no") and tags.get("foot") not in ("yes", "designated", "permissive"):
                return
            if tags.get("service") in ("parking_aisle", "driveway") or tags.get("indoor") == "yes":
                return
            self.ways.append(({t.k: t.v for t in tags}, points))

    def area(self, a):
        tags = a.tags
        building = tags.get("building")
        green_kind = None
        for key in ("landuse", "natural", "leisure"):
            if tags.get(key) in GREEN_VALUE:
                green_kind = tags.get(key)
                break
        water = tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
        poi = classify_poi(tags, True)
        if not (building or green_kind or water or poi):
            return
        try:
            geom = shapely.from_wkb(self.wkb.create_multipolygon(a))
        except Exception:
            return
        if geom is None or geom.is_empty:
            return
        lon_a, lat_a, lon_b, lat_b = geom.bounds
        if lat_b < LAT0 - MARGIN_DEG or lat_a > LAT1 + MARGIN_DEG or lon_b < LON0 - MARGIN_DEG or lon_a > LON1 + MARGIN_DEG:
            return
        if building and building != "no" and tags.get("location") != "underground":
            self.buildings.append((geom, building_height(tags)))
        if green_kind:
            self.green.append((geom, GREEN_VALUE[green_kind], green_kind in ("forest", "wood")))
        if water:
            self.water_areas.append(geom)
        if poi:
            point = geom.representative_point() if poi[0] != "park" else geom.centroid
            radius = math.sqrt(project(geom).area / math.pi) if poi[0] == "park" else 0
            self.pois.append((point.y, point.x, poi[0], poi[1], tags.get("name") or "", min(400, round(radius))))


def densify_lines(lines, step_m):
    """Points every step_m along lines given in degrees, as an (n, 2) array in metres."""
    if not lines:
        return np.zeros((0, 2))
    geoms = project(np.array([shapely.LineString(line) for line in lines if len(line) >= 2]))
    return shapely.get_coordinates(shapely.segmentize(geoms, step_m))


def near(points_xy, targets_xy, radius_m):
    if len(targets_xy) == 0:
        return np.zeros(len(points_xy), dtype=bool)
    distance, _ = cKDTree(targets_xy).query(points_xy, distance_upper_bound=radius_m, workers=-1)
    return np.isfinite(distance)


def main():
    if not SOURCE.exists():
        sys.exit(f"Missing {SOURCE}. Download https://download.bbbike.org/osm/bbbike/Oslo/Oslo.osm.pbf")
    reader = Reader()
    print("reading", SOURCE.name, flush=True)
    reader.apply_file(str(SOURCE), locations=True)
    print(f"  {len(reader.ways)} ways, {len(reader.buildings)} buildings, {len(reader.green)} green areas, "
          f"{len(reader.trees)} trees, {len(reader.lamps)} lamps, {len(reader.pois)} points of interest", flush=True)

    # --- segments -------------------------------------------------------------------------------
    node_index = {}
    node_lat, node_lon = [], []

    def node_id(key, lat, lon):
        found = node_index.get(key)
        if found is None:
            found = node_index[key] = len(node_lat)
            node_lat.append(lat)
            node_lon.append(lon)
        return found

    seg_a, seg_b, seg_way = [], [], []
    for way_number, (_, points) in enumerate(reader.ways):
        for i in range(len(points) - 1):
            (ref_a, lat_a, lon_a), (ref_b, lat_b, lon_b) = points[i], points[i + 1]
            if not inside((lat_a + lat_b) / 2, (lon_a + lon_b) / 2):
                continue
            length = math.hypot((lat_b - lat_a) * M_PER_DEG_LAT, (lon_b - lon_a) * M_PER_DEG_LON)
            parts = max(1, math.ceil(length / MAX_SEGMENT_M))
            previous = node_id(ref_a, lat_a, lon_a)
            for part in range(1, parts + 1):
                if part == parts:
                    current = node_id(ref_b, lat_b, lon_b)
                else:
                    f = part / parts
                    current = node_id((way_number, i, part), lat_a + (lat_b - lat_a) * f, lon_a + (lon_b - lon_a) * f)
                seg_a.append(previous)
                seg_b.append(current)
                seg_way.append(way_number)
                previous = current
    seg_a, seg_b, seg_way = np.array(seg_a), np.array(seg_b), np.array(seg_way)
    node_lat, node_lon = np.array(node_lat), np.array(node_lon)
    node_x, node_y = to_xy(node_lon, node_lat)
    mid = np.column_stack(((node_x[seg_a] + node_x[seg_b]) / 2, (node_y[seg_a] + node_y[seg_b]) / 2))
    count = len(seg_a)
    print(f"  {count} segments, {len(node_lat)} nodes", flush=True)

    # --- horizon from buildings -----------------------------------------------------------------
    print("horizon", flush=True)
    outlines = shapely.segmentize(project(shapely.boundary(np.array([g for g, _ in reader.buildings]))),
                                  BUILDING_EDGE_STEP_M)
    edge_xy, owner = shapely.get_coordinates(outlines, return_index=True)
    edge_height = np.array([h for _, h in reader.buildings])[owner]
    tree = cKDTree(edge_xy)
    horizon = np.zeros((count, HORIZON_SECTORS), dtype=np.float32)
    sector_deg = 360.0 / HORIZON_SECTORS
    chunk = 4000
    for start in range(0, count, chunk):
        found = tree.query_ball_point(mid[start:start + chunk], HORIZON_RADIUS_M, workers=-1)
        sizes = np.fromiter((len(f) for f in found), dtype=np.int64, count=len(found))
        if sizes.sum() == 0:
            continue
        edge = np.fromiter((i for f in found for i in f), dtype=np.int64, count=int(sizes.sum()))
        point = np.repeat(np.arange(len(found)), sizes) + start
        dx = edge_xy[edge, 0] - mid[point, 0]
        dy = edge_xy[edge, 1] - mid[point, 1]
        distance = np.hypot(dx, dy)
        elevation = np.degrees(np.arctan2(edge_height[edge], np.maximum(distance, HORIZON_MIN_DISTANCE_M)))
        sector = (np.degrees(np.arctan2(dx, dy)) % 360.0 / sector_deg).astype(np.int64) % HORIZON_SECTORS
        np.maximum.at(horizon, (point, sector), elevation)
        close = distance < HORIZON_SPREAD_WITHIN_M
        for shift in (-1, 1):
            np.maximum.at(horizon, (point[close], (sector[close] + shift) % HORIZON_SECTORS), elevation[close])
        if start % (chunk * 20) == 0:
            print(f"  {start}/{count}", flush=True)
    horizon = np.clip(np.rint(horizon), 0, 89).astype(np.uint8)

    # --- green, water, light, noise -------------------------------------------------------------
    print("green, water, light", flush=True)
    points = shapely.points(mid)
    green = np.zeros(count)
    forest = np.zeros(count, dtype=bool)
    if reader.green:
        areas = project(np.array([g for g, _, _ in reader.green]))
        value = np.array([v for _, v, _ in reader.green])
        is_forest = np.array([f for _, _, f in reader.green])
        index = STRtree(areas)
        p, a = index.query(points, predicate="within")
        np.maximum.at(green, p, value[a])
        np.logical_or.at(forest, p, is_forest[a])
        p, a = index.query(points, predicate="dwithin", distance=GREEN_NEAR_M)
        np.maximum.at(green, p, value[a] * 0.6)
    tree_xy = np.vstack([np.column_stack(to_xy(*np.array(reader.trees).T)) if reader.trees else np.zeros((0, 2)),
                         densify_lines(reader.tree_rows, 8.0)])
    if len(tree_xy):
        trees_near = cKDTree(tree_xy).query_ball_point(mid, TREE_RADIUS_M, return_length=True, workers=-1)
        green = np.maximum(green, np.select([trees_near >= 3, trees_near == 2, trees_near == 1], [0.8, 0.65, 0.4], 0))

    water_xy = densify_lines(reader.water_lines, 10.0)
    if reader.water_areas:
        shores = shapely.segmentize(project(shapely.boundary(np.array(reader.water_areas))), 10.0)
        water_xy = np.vstack([water_xy, shapely.get_coordinates(shores)])
    water = near(mid, water_xy, WATER_RADIUS_M)
    noisy = near(mid, densify_lines(reader.main_roads, 10.0), MAIN_ROAD_RADIUS_M) | near(
        mid, densify_lines(reader.secondary_roads, 10.0), SECONDARY_ROAD_RADIUS_M)
    lamp_xy = np.column_stack(to_xy(*np.array(reader.lamps).T)) if reader.lamps else np.zeros((0, 2))
    lamp_near = near(mid, lamp_xy, LAMP_RADIUS_M)

    # --- per-way flags --------------------------------------------------------------------------
    way_flags, way_name = [], []
    for tags, _ in reader.ways:
        highway = tags["highway"]
        cls = HIGHWAY_CLASS[highway]
        steps = highway == "steps"
        foot = tags.get("foot") != "no"
        bicycle = tags.get("bicycle")
        bike = not steps and bicycle not in ("no", "dismount")
        bike_good = highway == "cycleway" or bicycle in ("yes", "designated") or any(
            k.startswith("cycleway") and v not in ("no", "none") for k, v in tags.items())
        surface = tags.get("surface")
        if surface in PAVED:
            paved = True
        elif surface in UNPAVED:
            paved = False
        else:
            paved = highway not in ("path", "track")
        lit_tag = tags.get("lit")
        if lit_tag == "no":
            lit = 0
        elif lit_tag:
            lit = 3
        else:
            lit = 1 if highway in ("path", "track") else 2
        way_flags.append(cls | foot << 3 | bike << 4 | lit << 5 | paved << 14 | steps << 15 | bike_good << 16)
        way_name.append(tags.get("name") or "")
    flags = np.array(way_flags)[seg_way]
    lit = (flags >> 5) & 3
    lit = np.where(lamp_near & (lit != 0), 3, lit)
    flags = (flags & ~(3 << 5)) | (lit << 5)
    flags |= np.rint(green * 10).astype(np.int64) << 7
    flags |= water.astype(np.int64) << 11 | forest.astype(np.int64) << 12 | noisy.astype(np.int64) << 13

    # --- tiles ----------------------------------------------------------------------------------
    print("writing tiles", flush=True)
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("t_*.json"):
        old.unlink()

    def tile_of(lat, lon):
        return int((lat - LAT0) / TILE_LAT_DEG), int((lon - LON0) / TILE_LON_DEG)

    tiles = defaultdict(lambda: {"nodes": [], "segments": [], "pois": []})
    used = np.zeros(len(node_lat), dtype=bool)
    used[seg_a] = used[seg_b] = True
    for node in np.flatnonzero(used):
        tiles[tile_of(node_lat[node], node_lon[node])]["nodes"].append(int(node))
    for segment in range(count):
        a = seg_a[segment]
        tiles[tile_of(node_lat[a], node_lon[a])]["segments"].append(segment)
    for poi in reader.pois:
        if inside(poi[0], poi[1]):
            tiles[tile_of(poi[0], poi[1])]["pois"].append(poi)

    names = []
    for (row, col), content in tiles.items():
        lat_origin, lon_origin = LAT0 + row * TILE_LAT_DEG, LON0 + col * TILE_LON_DEG
        n = []
        for node in content["nodes"]:
            n += [node, round((node_lat[node] - lat_origin) * 1e6), round((node_lon[node] - lon_origin) * 1e6)]
        name_table, name_number, s = [""], {"": 0}, []
        for segment in content["segments"]:
            name = way_name[seg_way[segment]]
            if name not in name_number:
                name_number[name] = len(name_table)
                name_table.append(name)
            s += [int(seg_a[segment]), int(seg_b[segment]), int(flags[segment]), name_number[name]]
        h = horizon[content["segments"]].tobytes().hex() if content["segments"] else ""
        p = [[round((lat - lat_origin) * 1e6), round((lon - lon_origin) * 1e6), kind, weight, name, radius]
             for lat, lon, kind, weight, name, radius in content["pois"]]
        tile = {"o": [lat_origin, lon_origin], "n": n, "s": s, "h": h, "names": name_table, "p": p}
        (OUT / f"t_{row}_{col}.json").write_text(json.dumps(tile, separators=(",", ":"), ensure_ascii=False))
        names.append(f"{row}_{col}")
    meta = {"lat0": LAT0, "lon0": LON0, "lat1": LAT1, "lon1": LON1, "tileLat": TILE_LAT_DEG, "tileLon": TILE_LON_DEG,
            "sectors": HORIZON_SECTORS, "tiles": sorted(names), "built": datetime.date.today().isoformat(),
            "source": "OpenStreetMap contributors (ODbL), extract from download.bbbike.org"}
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    total = sum(f.stat().st_size for f in OUT.glob("*.json"))
    print(f"{len(names)} tiles, {total / 1e6:.1f} MB; green segments {np.mean(green > 0.3):.0%}, "
          f"lit {np.mean(lit == 3):.0%}, by water {np.mean(water):.0%}", flush=True)


if __name__ == "__main__":
    main()
