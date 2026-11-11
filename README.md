# Oslo-turer

Forslag til fine runder til fots og på sykkel i Oslo. Du velger gå eller sykle, fart, lengde, lys (sol, skygge eller
gatelys) og hva du vil ha langs ruta (trær, vann, kunst, bygg og historie, utsikt, mat, lekeplasser). Klokka står på nå; dra i
himmelen øverst for å velge en annen time i dag. Appen lager flere runder på
ekte kartdata, rangerer dem, sier hvorfor hver er god, og følger deg på kartet mens du går.

En ren statisk side: ingen server, ingen database, ingen nøkler.

## Se den lokalt

```sh
python3 -m http.server 8000
```

Åpne <http://localhost:8000>. «Forhåndsvis turen» flytter prikken langs ruta uten GPS.

Knappen med siktemerket øverst til høyre i kartet spør om posisjonen din og viser deg som en prikk som følger deg.
Et nytt trykk flytter kartet tilbake til prikken.

## Slik virker den

- `tools/build_data.py` leser et OpenStreetMap-utdrag av Oslo og skriver `data/` (kartruter på ca. 1 × 1 km). Hver
  sti og gate deles i biter på høyst 40 m, og hver bit får:
  - en horisont: for 24 himmelretninger, hvor høyt nærmeste bygninger (innen 90 m) rager. Appen sammenligner den
    med solas stilling på tidspunktet og vet om biten ligger i sol eller skygge.
  - gatelys: fra `lit`-merket, en lyktestolpe innen 20 m, eller en antakelse ut fra type vei.
  - grønt (trær, trerekker, parker, skog), vann, støy fra hovedvei, dekke, og om den kan gås og sykles.
- `graph.js` gir hver bit en verdi ut fra ønskene, legger tilfeldige hjørner rundt startpunktet, finner den beste
  veien mellom dem, og rangerer rundene. Hvert søk gir nye forslag.
- `sun.js` regner ut solas stilling. `app.js` er siden. `scene.js` tegner Oslo sett fra fjorden øverst i panelet;
  himmelen, sola, stjernene og vinduene følger solhøyden på det valgte tidspunktet, og kartet er pergament om dagen
  og nattblått etter mørkets frambrudd.

## Oppdater kartdataene

```sh
curl -L -o tools/osm/Oslo.osm.pbf https://download.bbbike.org/osm/bbbike/Oslo/Oslo.osm.pbf
uv run tools/build_data.py
```

Tar litt over ett minutt. Området er 59,84–60,01° N, 10,58–10,92° Ø (konstanter øverst i skriptet).

## Det den ikke vet

- Terreng: skygge fra åser og høydeforskjeller er ikke med, heller ikke stigning på turen.
- Bygningshøyder: få bygg i OpenStreetMap har høyde, resten er anslått fra etasjer eller byggtype.
- Trær skygger bare i skog (mai–september), ikke enkelttrær i gater.
- Gatelys er kjent for omtrent en femdel av bitene; resten er en antakelse.
- Enveiskjøring for sykkel er ikke med.

## Publisering på Cloudflare Pages

1. Legg repoet på GitHub (med `data/`, ca. 53 MB).
2. I Cloudflare: Workers & Pages → Create → Pages → Connect to Git, og velg repoet.
3. Build command: tom. Build output directory: `/`.

Posisjon på telefonen krever HTTPS, som Cloudflare Pages gir.

## Kilder

Kart: Kartverket. Stier, bygninger, trær og severdigheter: © OpenStreetMap-bidragsytere (ODbL).
