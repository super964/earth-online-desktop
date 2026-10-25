# Changelog

All notable changes to Earth Online are documented here.

## [1.0.0] — 2026-10-25

First public release of the Electron + Three.js desktop edition.

### Added

- Interactive 3D globe with day/night shader, cloud shell, atmosphere glow,
  bloom post-processing, starfield, country borders and graticule.
- Ten toggleable data layers: earthquakes, natural disasters, other EONET
  events, tsunami bulletins, storm tracks, wildfires, NWS warnings, aurora,
  ISS, and fireballs.
- Live event stream with priority sorting, fly-to, and detailed event cards.
- Place search and click-anywhere surface probes with local weather, local
  time, sun elevation, pressure, sunrise/sunset and nearby hazards.
- 30-day time machine for USGS earthquakes and NASA EONET events.
- Operator progression: points, ranks, achievements, probes and waypoints,
  persisted in `localStorage`.
- PNG snapshot export of the current globe.
- Disk cache and synthetic demo telemetry for offline startup.
- Portable Windows x64 packaging via `npm run package`.
- Bundled textures, fonts, borders and Three.js modules — no CDN required.
- English UI throughout, with Chinese documentation.
