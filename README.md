# Apex Rush — 3D arcade racing in the browser

A complete 3D car racing game built with [Three.js](https://threejs.org/) and plain ES modules.
No build step, no bundler, no server-side code: the repository *is* the website, so it can be
hosted directly on GitHub Pages (or any static host).

**Features**

- **Free Roam open world** (new): an island about 6 km across, streamed in chunks around you, with sea
  all the way round and an irregular coastline of beaches, headlands (Lighthouse Point, Sunset Cape,
  Frost Point…), a cove and a bay. Six regions: Meadowvale farmland, Pinewood Hills forest, Red Mesa Flats
  desert, the Frostpeak alpine pass, the Azure Shore and Apex City, whose streets bend and run on uneven
  blocks (two stop short at T-junctions), with buildings turned to face their street and seven roads in
  and out. Twenty-eight roads from a four-lane highway ring and the Shoreline Highway round the coast down
  to gravel trails, all joined into one network: every road meets another at a real junction, where
  both surfaces match across the whole crossing and the markings and kerbs stop at its edge. Outside
  the city the roadsides are lived in: villages, farms with barns, silos and hay bales, forest cabins,
  desert shacks and a water tower, mountain lodges, beach huts and lifeguard towers, gas stations,
  billboards, utility poles, boulders, and green direction signs before every junction. Every circuit and stage
  is placed in the world as a drive-up event: roll onto its ring and press Enter to race it against
  Dynamic AI, with prize money and XP. Ten speed traps, six drift zones, four speed zones and forty bonus
  boards give star ratings and XP; levels pay out credits. The full-screen map (M) works like the ones
  in Forza Horizon or GTA: shaded terrain, city blocks, road and region names, drag to pan and scroll or
  pinch to zoom, filters per marker type, and a waypoint on any marker or any point on a road. The GPS
  plans the shortest route along the roads and draws it in purple on the map and on the radar, and the
  HUD gives turn-by-turn directions ("Turn right onto Meridian Road · 240 m"). The radar is heading-up,
  shows terrain, road classes and traffic, and zooms out with speed. Fast travel goes to any place you
  have discovered. Your position and all progress
  save in the browser. Ambient traffic drives the network in its lane, slows for corners, queues behind
  you, turns at junctions and can be hit (or passed closely for a near-miss XP bonus).
- **One career, in the world**: Play drops you on the island, and that *is* the career. One wallet
  (shown on every screen and on the HUD, with a "+N cr" pop) collects everything: events, the four
  championships, speed traps, drift zones, bonus boards and level-ups. The championships (Rookie Cup →
  Pro Series → Grand Prix → Legends Endurance) are gold venues on the map: drive up and press Enter to
  see the rounds and standings and race the next round, then you're back on the island. The bigger
  ones need a level as well as a result in the series before. **Festival HQ**, next to the festival
  start, is the garage: drive onto its pad to buy cars, upgrade and paint them, and drive away in the
  new one (or pause → Go to garage to fast-travel there). New players get a short guided first drive.
  Quick Race, Split Screen and Time Trial are the **Arcade**: every car unlocked, no credits or XP.

- Sixteen circuits with elevation: eight original themed tracks (club circuit, coast, harbour,
  desert, canyon, alpine, forest, neon night city) and eight layouts inspired by real-world
  circuits: Silverstone, Monza, Spa-Francorchamps, Interlagos, Red Bull Ring, Bahrain, Circuit
  of the Americas and Zandvoort. Real circuits carry hand-authored height profiles (Eau Rouge
  climbs, the Red Bull Ring hillside, the Senna S plunge); originals get rolling terrain.
- Four point-to-point stages (6–10 km): a 390 m mountain hillclimb, a coastal highway run, a
  desert dune crossing and a narrow forest rally stage. Single run from start to finish, with
  elevation, varying width, a finish gantry and barriers at both ends.
- Ten cars, each modelled on a real car's dimensions and signature details: a Jaguar E-Type-style
  roadster, a Golf GTI-style hot hatch, a '67 Mustang-style fastback, a 911 GT3 RS-style track car,
  a GR Yaris Rally1-style gravel car, an Audi quattro S1-style Group B car, a Huracán-style
  supercar, a Le Mans Hypercar prototype, a Chiron-style hypercar and a 2022-rules F1 car. Bodies
  are smooth procedural lofts with real wheel-arch openings, surface-hugging lights, glass and
  liveries, and wheels with brake discs and calipers. Race cars carry per-car numbers and livery
  colours. Open `showroom.html` to inspect every car up close.
- Arcade driving model with a grip-limited bicycle steering model, off-road grip loss (the
  rally car barely cares), slope gravity, barrier and car-to-car collisions.
- Proper drifting: tap the handbrake while turning and the rear steps out. Throttle holds the
  slide, steering into the corner deepens the angle, counter-steering or lifting off lets the
  tyres hook up again. A long handbrake pull spins the car round for a handbrake turn.
  Sliding tyres lay rubber on the road and throw up smoke (or dust off the track).
- **Split-screen multiplayer**: two players on one keyboard (WASD vs arrow keys) or two gamepads.
  The screen splits left/right on wide displays and top/bottom on tall ones.
- Championships have points standings and prize money; the garage sells nine cars and has four
  upgrade lines and paint. Progress is saved in the browser (`localStorage`).
- Quick Race and Time Trial modes with adjustable laps, opponent count and AI difficulty
  (Easy, Medium, Hard, or **Dynamic**, where the AI measures its time gap to you continuously and
  paces itself around you: a couple of drivers just ahead, most just behind, on circuits and stages).
- Road width varies from track to track and along each lap, from tight 10 m street sections
  to 20 m+ desert straights.
  Time Trial replays your best lap as a translucent **ghost car** (stored per track and car).
- Touch controls appear automatically on phones and tablets.
- AI drivers with racing lines, braking for corners, overtaking/avoidance and un-stuck logic.
- Per-player HUD with position, lap timer, best lap, minimap and live standings.
- Procedural engine, skid, impact and countdown sounds (Web Audio, no asset files).

## Play locally

Any static file server works. For example:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from disk will not work because browsers block ES-module imports
from `file://` URLs.

## Deploy to GitHub Pages

Two options; both need nothing more than the repository contents.

**Option A — Deploy from branch (current setup).** In *Settings → Pages*, choose
**Deploy from a branch**, pick `main` and the `/ (root)` folder. Every push to `main` is
published automatically. The included `.nojekyll` file makes Pages serve the files as-is.

**Option B — GitHub Actions.** `.github/workflows/deploy.yml` uploads the repository root to
GitHub Pages. It is manual-only (`workflow_dispatch`) so it does not conflict with Option A; set
**Source** to **GitHub Actions** and add a `push` trigger if you prefer this route.

Your game will be available at `https://<user>.github.io/<repo>/`. All asset paths are relative,
so it works from a project sub-path as well as from a custom domain.

## Controls

| Action            | Player 1        | Player 2                | Gamepad            |
|-------------------|-----------------|-------------------------|--------------------|
| Accelerate        | `W`             | `↑`                     | RT / A             |
| Brake / reverse   | `S`             | `↓`                     | LT / X             |
| Steer             | `A` / `D`       | `←` / `→`               | Left stick         |
| Handbrake (drift) | `Shift` / `Space` | `Right Shift` / `Right Ctrl` | B / RB      |
| Reset to track    | `R`             | `.`                     | Y                  |
| Pause             | `Esc`           | `Esc`                   | Start              |
| Free Roam: map    | `M` / `Tab`     |                         | Back / Select      |
| Free Roam: start event | `Enter` / `E` |                       | A                  |

On touch devices, on-screen steering, gas, brake and drift buttons are shown for Player 1.

Each player picks their controls (WASD, arrows, gamepad 1, gamepad 2, or touch) on the race
setup screen; the choice is remembered. Career uses the Player 1 choice, changeable on the
career screen or in *Settings*.

## Project layout

```
index.html            entry page, import map, HUD/menu containers
style.css             menus and HUD styling
vendor/three.module.js vendored Three.js (r170) so no CDN is needed
src/main.js           app state machine, render loop, race lifecycle
src/race.js           race manager: physics loop, collisions, laps, ranking, split-screen rendering
src/car.js            car physics
src/carmodels.js      the ten car models (proportions, lights, aero, liveries)
src/carkit.js         procedural body toolkit: lofted shells, arch cut-outs, surface panels, wheels
showroom.html         turntable viewer for every car (drag to orbit, pick colours)
src/ai.js             AI driver behaviour
src/track.js          spline sampling, road/curb/barrier geometry, track queries
src/tracks.js         track definitions (control points, incl. real-circuit-inspired layouts) and themes
src/scenery.js        ground, trees, buildings, mountains, grandstand, sponsor boards
src/hud.js            per-player HUD and minimap
src/ui.js             all menu screens (main, setup, career, garage, settings, results, pause)
src/career.js         save/load, championships, prize money, garage logic
src/data.js           cars, upgrades, series, AI roster, points table
src/input.js          keyboard schemes and gamepad polling
src/audio.js          procedural Web Audio sound effects
```

## Adding a track

Add an entry to `src/tracks.js` with an `id`, `name`, `theme` (one of `grass`, `coastal`,
`desert`, `forest`, `alpine`, `city`), `kind` (`real` or `original`), a road `width` and a list
of 2D control `points`. The points are joined by a closed Catmull-Rom spline; keep neighbouring
points roughly 80–150 m apart and avoid crossings. The car starts at the first point heading
toward the second. Optionally add `elevation: [[t, height], ...]` keypoints (t is the lap
fraction from the start line) or an `elevationAmp` for a seeded rolling profile.

## License

Game code: MIT. Three.js is © its authors, MIT licensed (see `vendor/THREE_LICENSE`).
