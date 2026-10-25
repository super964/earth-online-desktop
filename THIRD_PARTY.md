# Third-party assets & licenses

Earth Online bundles the following third-party resources. They remain under
their respective licenses; the MIT license in `LICENSE` applies to the
application code only.

## Runtime libraries

| Component | Version | License | Source |
|---|---|---|---|
| Three.js | r186 | MIT | https://threejs.org/ |
| topojson-client | 3.x | ISC | https://github.com/topojson/topojson-client |
| Electron | 45 | MIT | https://www.electronjs.org/ |

The portable Windows build also contains Electron's own `LICENSES.chromium.html`
and `LICENSE` files in its install directory.

## Fonts

| Font | License | Source |
|---|---|---|
| Inter | SIL Open Font License 1.1 | https://rsms.me/inter/ |
| Space Grotesk | SIL Open Font License 1.1 | https://fonts.google.com/specimen/Space+Grotesk |

The `.woff2` files are subsetted/redistributed for offline use.

## Geographic data

| Asset | License | Source |
|---|---|---|
| `countries-110m.json` | ISC (world-atlas); underlying Natural Earth data is public domain | https://github.com/topojson/world-atlas |

## Earth imagery

`src/assets/textures/` contains day, night, cloud, normal, specular and
topology imagery derived from NASA Earth observation imagery (NASA Earth
Observatory / Visible Earth). NASA imagery is generally not copyrighted and is
free to use; see the NASA Media Usage Guidelines:

https://www.nasa.gov/nasa-brand-center/images-and-media/

The images were resized and renamed for this project. If you plan to
redistribute them commercially, verify the original source and NASA's current
usage guidelines.

## Live data

Live event data is fetched at runtime from USGS, NASA EONET, NOAA/NWS, NOAA
SWPC, NASA CNEOS, WhereTheISS.at, Open-Meteo, BigDataCloud and ipwho.is. The
data remains subject to each provider's terms and attribution requirements.
Earth Online is not affiliated with any of these organizations.

## Icons

The interface icons are inline SVG paths authored for this project and are
covered by the MIT license.
