import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const R = 1;

export const CATEGORY_COLOR = {
  seismic: '#ffb648',
  warning: '#ff9f1c',
  tsunami: '#35e0ff',
  storm: '#b58cff',
  fire: '#ff6b4a',
  volcano: '#ff4d6d',
  flood: '#54b6ff',
  disaster: '#ffd166',
  fireball: '#ffe6ff',
  iss: '#8ff7ff',
  aurora: '#5dffb0',
};

const CATEGORY_LAYER = {
  seismic: 'seismic',
  warning: 'warnings',
  tsunami: 'tsunami',
  storm: 'storms',
  fire: 'fires',
  volcano: 'disasters',
  flood: 'disasters',
  disaster: 'gdacs',
  fireball: 'fireballs',
};

export function layerOf(cat) { return CATEGORY_LAYER[cat] || 'disasters'; }

export function latLonToVec3(lat, lon, radius = R) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

export function vec3ToLatLon(v) {
  const n = v.clone().normalize();
  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, n.y))) * RAD;
  let lon = Math.atan2(n.z, -n.x) * RAD - 180;
  while (lon < -180) lon += 360;
  while (lon > 180) lon -= 360;
  return { lat, lon };
}

/** Sub-solar point (where the sun is directly overhead) for a given date. */
export function subsolarPoint(date = new Date()) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
  let lon = ra * RAD - gmst * 15;
  lon = ((lon + 540) % 360) - 180;
  return { lat: dec * RAD, lon };
}

function makeStarTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class EarthGlobe {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.events = [];
    this.activeLayers = null;
    this.markerIds = [];
    this.iss = null;
    this.probe = null;
    this.selected = null;
    this.ready = false;
    this.disposed = false;
    this.clock = new THREE.Clock();
    this.cameraTween = null;
    this.idleTimer = null;
    this.hovered = -1;
    this.lastPointer = { x: 0, y: 0, t: 0 };
    this.dragged = false;
    this._buildScene();
  }

  async init() {
    const loader = new THREE.TextureLoader();
    const load = (url, srgb = true) => new Promise((resolve, reject) => {
      loader.load(url, (t) => {
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        resolve(t);
      }, undefined, reject);
    });

    const [day, night, spec, clouds, borders] = await Promise.all([
      load('./assets/textures/earth-day.jpg'),
      load('./assets/textures/earth-night.jpg'),
      load('./assets/textures/earth-specular.jpg', false),
      load('./assets/textures/earth-clouds.png', false),
      fetch('./assets/data/countries-110m.json').then((r) => r.json()).catch(() => null),
    ]);

    this.dayTex = day;
    this.nightTex = night;
    this.specTex = spec;
    this.cloudTex = clouds;

    this._buildEarth(day, night, spec);
    this._buildClouds(this._softenClouds(clouds));
    this._buildAtmosphere();
    this._buildGraticule();
    if (borders) this._buildBorders(borders);
    this._buildMarkers();
    this._buildAurora();
    this._buildIss();
    this._buildSelection();

    this.setSun(new Date());
    this.renderer.setAnimationLoop(() => this._frame());
    this.ready = true;
    this.callbacks.onReady?.();
  }

  /* ---------------------------------------------------------------- */

  _buildScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = null;

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
    this.camera.position.copy(latLonToVec3(18, 100, 4.16));

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
    this.renderer.setClearColor(0x02060f, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.65;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 6.6;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.22;
    this.controls.target.set(0, 0, 0);

    this.controls.addEventListener('start', () => {
      this.dragged = false;
      this.controls.autoRotate = false;
      clearTimeout(this.idleTimer);
    });
    this.controls.addEventListener('end', () => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { this.controls.autoRotate = true; }, 26000);
    });

    this.scene.add(new THREE.AmbientLight(0x223355, 0.4));

    // stars
    this.starGroup = new THREE.Group();
    this.starGroup.rotation.z = 0.35;
    this.scene.add(this.starGroup);
    this._buildStars();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.30, 0.52, 0.80);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points.threshold = 0.045;
    this.pointer = new THREE.Vector2();

    this._bindPointer();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.container);

    this.label = document.createElement('div');
    this.label.className = 'marker-label';
    this.label.innerHTML = '<span class="ml-dot"></span><span class="ml-text"></span>';
    this.label.style.display = 'none';
    this.container.appendChild(this.label);
  }

  _buildStars() {
    const N = 7000;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const col = new Float32Array(N * 3);
    const phase = new Float32Array(N);
    const palette = [
      [0.75, 0.86, 1], [1, 1, 1], [0.9, 0.95, 1],
      [1, 0.9, 0.78], [0.72, 0.8, 1], [0.82, 1, 0.95],
    ];
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = 18 + Math.random() * 55;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(th) * s * r;
      pos[i * 3 + 1] = u * r;
      pos[i * 3 + 2] = Math.sin(th) * s * r;
      size[i] = 0.55 + Math.pow(Math.random(), 3) * 2.4;
      const c = palette[(Math.random() * palette.length) | 0];
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      phase[i] = Math.random() * 6.28;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));

    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: this.renderer.getPixelRatio() } },
      vertexShader: /* glsl */`
        attribute float aSize; attribute vec3 aColor; attribute float aPhase;
        varying vec3 vColor; varying float vTw;
        uniform float uTime; uniform float uPixelRatio;
        void main() {
          vColor = aColor;
          vTw = 0.72 + 0.28 * sin(uTime * 0.8 + aPhase * 5.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio * (105.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vTw;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(d));
          a = pow(a, 1.7);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor * vTw, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.starGroup.add(new THREE.Points(geo, this.starMat));

    // faint galactic band
    const M = 2600;
    const g2 = new THREE.BufferGeometry();
    const p2 = new Float32Array(M * 3);
    const s2 = new Float32Array(M);
    const c2 = new Float32Array(M * 3);
    const ph2 = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const ang = Math.random() * Math.PI * 2;
      const width = (Math.random() + Math.random() + Math.random() - 1.5) * 0.22;
      const r = 30 + Math.random() * 40;
      p2[i * 3] = Math.cos(ang) * r;
      p2[i * 3 + 1] = width * r;
      p2[i * 3 + 2] = Math.sin(ang) * r;
      s2[i] = 0.35 + Math.random() * 0.9;
      c2[i * 3] = 0.55; c2[i * 3 + 1] = 0.66; c2[i * 3 + 2] = 0.9;
      ph2[i] = Math.random() * 6.28;
    }
    g2.setAttribute('position', new THREE.BufferAttribute(p2, 3));
    g2.setAttribute('aSize', new THREE.BufferAttribute(s2, 1));
    g2.setAttribute('aColor', new THREE.BufferAttribute(c2, 3));
    g2.setAttribute('aPhase', new THREE.BufferAttribute(ph2, 1));
    const band = new THREE.Points(g2, this.starMat);
    band.rotation.set(0.6, 0.2, 1.1);
    this.starGroup.add(band);
  }

  _buildEarth(day, night, spec) {
    const geo = new THREE.SphereGeometry(R, 160, 120);
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uDay: { value: day },
        uNight: { value: night },
        uSpec: { value: spec },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying vec3 vN; varying vec3 vP;
        void main() {
          vUv = uv;
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vP = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uDay, uNight, uSpec;
        uniform vec3 uSunDir;
        varying vec2 vUv; varying vec3 vN; varying vec3 vP;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vP);
          float sd = dot(N, normalize(uSunDir));
          float dayMix = smoothstep(-0.16, 0.24, sd);
          vec3 dayC = texture2D(uDay, vUv).rgb;
          dayC = pow(dayC, vec3(1.02));
          float lum = dot(dayC, vec3(0.299, 0.587, 0.114));
          dayC = mix(vec3(lum), dayC, 1.24) * 1.02;
          vec3 nightC = texture2D(uNight, vUv).rgb;
          nightC *= vec3(1.0, 0.8, 0.55) * 1.9;
          vec3 darkSurface = dayC * vec3(0.16, 0.22, 0.32) * 0.55;
          float shade = clamp(sd * 1.3 + 0.22, 0.08, 1.0);
          vec3 col = mix(nightC + darkSurface, dayC * (0.12 + 1.02 * shade), dayMix);
          col *= vec3(0.96, 1.0, 1.05);
          vec3 H = normalize(normalize(uSunDir) + V);
          float ocean = texture2D(uSpec, vUv).r;
          float spec = pow(max(dot(N, H), 0.0), 74.0) * ocean * dayMix;
          col += vec3(0.4, 0.68, 1.0) * spec * 0.6;
          float term = smoothstep(-0.02, 0.18, sd) * (1.0 - smoothstep(0.18, 0.46, sd));
          col += vec3(0.42, 0.2, 0.06) * term * 0.28;
          float rim = pow(1.0 - max(dot(N, V), 0.0), 3.4);
          col += vec3(0.16, 0.48, 1.0) * rim * (0.18 + 0.55 * dayMix) * 0.5;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.earth = new THREE.Mesh(geo, this.earthMat);
    this.earth.name = 'earth';
    this.scene.add(this.earth);
  }

  _softenClouds(tex) {
    try {
      const c = document.createElement('canvas');
      c.width = 2048; c.height = 1024;
      const ctx = c.getContext('2d');
      ctx.filter = 'blur(2px) contrast(1.06)';
      ctx.drawImage(tex.image, 0, 0, c.width, c.height);
      const t = new THREE.CanvasTexture(c);
      t.wrapS = THREE.RepeatWrapping;
      t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      return t;
    } catch { return tex; }
  }

  _buildClouds(tex) {
    const geo = new THREE.SphereGeometry(R * 1.006, 128, 96);
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uClouds: { value: tex },
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uOpacity: { value: 0.5 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying vec3 vN;
        void main() {
          vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uClouds; uniform vec3 uSunDir; uniform float uOpacity;
        varying vec2 vUv; varying vec3 vN;
        void main() {
          float a = texture2D(uClouds, vUv).a;
          a = smoothstep(0.02, 0.58, a);
          if (a < 0.012) discard;
          float sd = dot(normalize(vN), normalize(uSunDir));
          float lit = smoothstep(-0.22, 0.4, sd);
          vec3 c = vec3(0.62, 0.74, 0.92) * (0.04 + 0.98 * lit);
          gl_FragColor = vec4(c, a * uOpacity);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.clouds = new THREE.Mesh(geo, this.cloudMat);
    this.scene.add(this.clouds);
  }

  _buildAtmosphere() {
    const outer = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.075, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: { value: new THREE.Vector3(1, 0, 0) } },
        vertexShader: /* glsl */`
          varying vec3 vN;
          void main() { vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
          varying vec3 vN;
          void main() {
            float rim = pow(1.0 - abs(vN.z), 2.6);
            vec3 c = mix(vec3(0.03, 0.18, 0.55), vec3(0.2, 0.62, 1.0), rim);
            gl_FragColor = vec4(c, rim * 0.17);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(outer);

    const inner = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.012, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: { value: new THREE.Vector3(1, 0, 0) } },
        vertexShader: /* glsl */`
          varying vec3 vN; varying vec3 vP;
          void main() {
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uSunDir;
          varying vec3 vN; varying vec3 vP;
          void main() {
            vec3 V = normalize(cameraPosition - vP);
            float rim = pow(1.0 - max(dot(normalize(vN), V), 0.0), 3.0);
            float sun = max(dot(normalize(vN), normalize(uSunDir)), 0.0);
            vec3 c = mix(vec3(0.08, 0.3, 0.85), vec3(0.4, 0.85, 1.0), rim);
            gl_FragColor = vec4(c, rim * (0.12 + 0.40 * sun) * 0.42);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(inner);
    this.atmoInner = inner;
  }

  _buildGraticule() {
    const pts = [];
    const r = R * 1.0012;
    for (let lon = -180; lon < 180; lon += 15) {
      for (let lat = -90; lat < 90; lat += 2) {
        pts.push(latLonToVec3(lat, lon, r), latLonToVec3(lat + 2, lon, r));
      }
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      for (let lon = -180; lon < 180; lon += 2) {
        pts.push(latLonToVec3(lat, lon, r), latLonToVec3(lat, lon + 2, r));
      }
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0x67c8ff, transparent: true, opacity: 0.07, depthWrite: false });
    this.scene.add(new THREE.LineSegments(geo, mat));
  }

  _buildBorders(topo) {
    try {
      const tj = window.topojson;
      if (!tj) return;
      const countries = tj.feature(topo, topo.objects.countries);
      const pts = [];
      const r = R * 1.0025;
      const addLine = (coords) => {
        for (let i = 0; i < coords.length - 1; i++) {
          const a = coords[i], b = coords[i + 1];
          if (Math.abs(a[0] - b[0]) > 180) continue;
          pts.push(latLonToVec3(a[1], a[0], r), latLonToVec3(b[1], b[0], r));
        }
      };
      for (const f of countries.features) {
        const g = f.geometry;
        if (!g) continue;
        if (g.type === 'Polygon') g.coordinates.forEach(addLine);
        else if (g.type === 'MultiPolygon') g.coordinates.forEach((poly) => poly.forEach(addLine));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: 0x7fd8ff, transparent: true, opacity: 0.16, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.scene.add(new THREE.LineSegments(geo, mat));
    } catch (e) { /* borders are decorative */ }
  }

  _buildMarkers() {
    const N = 1;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(3), 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(1), 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(1), 1));
    geo.setDrawRange(0, 0);

    const vert = /* glsl */`
      attribute vec3 aColor; attribute float aSize; attribute float aPhase;
      varying vec3 vColor; varying float vPhase;
      uniform float uPixelRatio; uniform float uTime;
      void main() {
        vColor = aColor; vPhase = aPhase;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (14.0 / -mv.z) * (1.0 + 0.12 * sin(uTime * 2.4 + aPhase));
        gl_Position = projectionMatrix * mv;
      }`;
    const frag = /* glsl */`
      varying vec3 vColor; varying float vPhase;
      uniform float uTime;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float d = length(p) * 2.0;
        if (d > 1.0) discard;
        float core = smoothstep(0.62, 0.0, d);
        float glow = smoothstep(1.0, 0.35, d) * 0.35;
        float ripple = 0.0;
        float t = fract(uTime * 0.5 + vPhase);
        float rr = 0.12 + t * 0.88;
        ripple = smoothstep(0.055, 0.0, abs(d - rr)) * (1.0 - t) * 0.55;
        vec3 c = vColor * (1.0 + 0.25 * core);
        gl_FragColor = vec4(c, core * 0.95 + glow + ripple);
      }`;

    this.markerMat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: this.renderer.getPixelRatio() }, uTime: { value: 0 } },
      vertexShader: vert, fragmentShader: frag,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.markers = new THREE.Points(geo, this.markerMat);
    this.markers.frustumCulled = false;
    this.scene.add(this.markers);

    // larger, very faint halo ring layer
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    haloGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(3), 3));
    haloGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(1), 1));
    haloGeo.setDrawRange(0, 0);
    this.haloMat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: this.renderer.getPixelRatio() }, uTime: { value: 0 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aSize;
        varying vec3 vColor; uniform float uPixelRatio; uniform float uTime;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio * (14.0 / -mv.z) * (1.5 + 0.4 * sin(uTime * 1.5));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          float a = smoothstep(1.0, 0.58, d) * 0.065;
          gl_FragColor = vec4(vColor, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.halos = new THREE.Points(haloGeo, this.haloMat);
    this.halos.frustumCulled = false;
    this.scene.add(this.halos);
  }

  _buildAurora() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(1), 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(1), 1));
    geo.setDrawRange(0, 0);
    this.auroraMat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: this.renderer.getPixelRatio() }, uTime: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float aSize; attribute float aAlpha;
        varying float vA; uniform float uPixelRatio; uniform float uTime;
        void main() {
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPixelRatio * (12.0 / -mv.z) * (1.0 + 0.25 * sin(uTime * 1.3 + position.y * 18.0));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          vec3 c = mix(vec3(0.1, 0.85, 0.55), vec3(0.55, 0.35, 1.0), smoothstep(0.0, 1.0, vA * 0.7));
          gl_FragColor = vec4(c, smoothstep(1.0, 0.15, d) * vA * 0.55);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.aurora = new THREE.Points(geo, this.auroraMat);
    this.aurora.frustumCulled = false;
    this.scene.add(this.aurora);
  }

  _buildIss() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.translate(64, 64);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 54);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.16, 'rgba(190,252,255,0.95)');
    g.addColorStop(0.42, 'rgba(70,215,255,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 54, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(150,246,255,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-19, 0); ctx.lineTo(19, 0);
    ctx.moveTo(0, -19); ctx.lineTo(0, 19);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex, color: 0xffffff, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.issSprite = new THREE.Sprite(mat);
    this.issSprite.scale.setScalar(0.085);
    this.issSprite.visible = false;
    this.issSprite.userData.kind = 'iss';
    this.scene.add(this.issSprite);

    this.issOrbitMat = new THREE.LineBasicMaterial({
      color: 0x7ef2ff, transparent: true, opacity: 0.5, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.issOrbit = new THREE.Line(new THREE.BufferGeometry(), this.issOrbitMat);
    this.issOrbit.visible = false;
    this.scene.add(this.issOrbit);
  }

  _buildSelection() {
    const geo = new THREE.RingGeometry(0.022, 0.028, 64);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x9feeff, transparent: true, opacity: 0.95,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.selRing = new THREE.Mesh(geo, mat);
    this.selRing.visible = false;
    this.scene.add(this.selRing);

    const geo2 = new THREE.RingGeometry(0.03, 0.033, 64);
    const mat2 = new THREE.MeshBasicMaterial({
      color: 0xff4d7a, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.probeRing = new THREE.Mesh(geo2, mat2);
    this.probeRing.visible = false;
    this.scene.add(this.probeRing);
  }

  /* ---------------------------------------------------------------- */

  _bindPointer() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.dragged = false;
      this.lastPointer = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('pointermove', (e) => {
      if (Math.hypot(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y) > 6) this.dragged = true;
      this._hover(e);
    });
    el.addEventListener('pointerleave', () => {
      el.style.cursor = '';
      this.label.style.display = 'none';
    });
    el.addEventListener('pointerup', (e) => {
      if (this.dragged || performance.now() - this.lastPointer.t > 600) return;
      if (Math.hypot(e.clientX - this.lastPointer.x, e.clientY - this.lastPointer.y) > 6) return;
      this._pick(e);
    });
  }

  _setPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  _hover(e) {
    this._setPointer(e);
    const hits = this.raycaster.intersectObject(this.markers, false);
    const el = this.renderer.domElement;
    if (hits.length && hits[0].index != null) {
      const id = this.markerIds[hits[0].index];
      el.style.cursor = 'pointer';
      const ev = this.events.find((x) => x.id === id);
      if (ev) {
        this.label.querySelector('.ml-text').textContent = `${ev.title}`;
        this.label.style.display = 'flex';
        this._placeLabel(ev.lat, ev.lon);
      }
    } else {
      el.style.cursor = 'grab';
      this.label.style.display = 'none';
    }
  }

  _pick(e) {
    this._setPointer(e);
    const issHit = this.issSprite?.visible ? this.raycaster.intersectObject(this.issSprite, false) : [];
    if (issHit.length) {
      this.callbacks.onIss?.();
      return;
    }
    const hits = this.raycaster.intersectObject(this.markers, false);
    if (hits.length && hits[0].index != null) {
      const id = this.markerIds[hits[0].index];
      const ev = this.events.find((x) => x.id === id);
      if (ev) {
        this.callbacks.onMarker?.(ev);
        return;
      }
    }
    const earth = this.raycaster.intersectObject(this.earth, false);
    if (earth.length) {
      const { lat, lon } = vec3ToLatLon(earth[0].point);
      this.callbacks.onGlobeClick?.({ lat, lon });
    }
  }

  _placeLabel(lat, lon) {
    if (!this.label || this.label.style.display === 'none') return;
    const v = latLonToVec3(lat, lon, R * 1.02);
    const p = v.clone().project(this.camera);
    const occluded = v.clone().normalize().dot(this.camera.position.clone().normalize()) < 0.05;
    if (occluded || p.z > 1) { this.label.style.opacity = '0'; return; }
    this.label.style.opacity = '1';
    const x = (p.x * 0.5 + 0.5) * this.container.clientWidth;
    const y = (-p.y * 0.5 + 0.5) * this.container.clientHeight;
    this.label.style.transform = `translate(-50%, -140%) translate(${x}px, ${y}px)`;
  }

  /* ---------------------------------------------------------------- */

  setSun(date) {
    const { lat, lon } = subsolarPoint(date instanceof Date ? date : new Date(date));
    const dir = latLonToVec3(lat, lon, 1);
    this.earthMat.uniforms.uSunDir.value.copy(dir);
    this.cloudMat.uniforms.uSunDir.value.copy(dir);
    this.atmoInner.material.uniforms.uSunDir.value.copy(dir);
    this.sun = { lat, lon };
  }

  setEvents(events) {
    this.events = events || [];
    this._rebuildMarkers();
  }

  setFilters(activeLayers) {
    this.activeLayers = activeLayers;
    this._rebuildMarkers();
  }

  _rebuildMarkers() {
    const visible = this.events.filter((e) => {
      if (e.cat === 'fireball') return false; // space tab only
      const layer = layerOf(e.cat);
      return !this.activeLayers || this.activeLayers.has(layer);
    });

    const n = visible.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const hCol = new Float32Array(n * 3);
    const hSize = new Float32Array(n);
    const color = new THREE.Color();
    this.markerIds = [];

    visible.forEach((e, i) => {
      const v = latLonToVec3(e.lat, e.lon, R * 1.008);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
      color.set(CATEGORY_COLOR[e.cat] || '#8fd8ff');
      col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b;
      hCol[i * 3] = color.r; hCol[i * 3 + 1] = color.g; hCol[i * 3 + 2] = color.b;
      const base = e.cat === 'seismic' ? 1.5 + (e.mag || 0) * 0.34 : e.cat === 'storm' ? 2.7 : 2.35;
      size[i] = base + (e.severity || 0.4) * 0.45;
      hSize[i] = size[i] * 2.2;
      phase[i] = Math.random() * 6.28;
      this.markerIds.push(e.id);
    });

    const geo = this.markers.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setDrawRange(0, n);
    geo.computeBoundingSphere();

    const hg = this.halos.geometry;
    hg.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
    hg.setAttribute('aColor', new THREE.BufferAttribute(hCol, 3));
    hg.setAttribute('aSize', new THREE.BufferAttribute(hSize, 1));
    hg.setDrawRange(0, n);
    hg.computeBoundingSphere();
    this.visibleEvents = visible;
  }

  setAurora(aurora) {
    const pts = aurora?.points || [];
    const n = Math.min(pts.length, 12000);
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const alpha = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const [lat, lon, v] = pts[i];
      const p = latLonToVec3(lat, lon, R * 1.012);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      size[i] = 0.6 + Math.random() * 0.6;
      alpha[i] = Math.min(1, v / 70);
    }
    const geo = this.aurora.geometry;
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setDrawRange(0, n);
    geo.computeBoundingSphere();
    this.aurora.visible = true;
  }

  setAuroraVisible(v) { if (this.aurora) this.aurora.visible = v; }

  setIss(iss, visible = true) {
    this.iss = iss;
    if (!iss || !visible) {
      this.issSprite.visible = false;
      this.issOrbit.visible = false;
      return;
    }
    const p = latLonToVec3(iss.lat, iss.lon, R * 1.055);
    this.issSprite.position.copy(p);
    this.issSprite.visible = true;
    const track = (iss.track || []).map((t) => latLonToVec3(t.lat, t.lon, R * 1.045));
    if (track.length > 1) {
      this.issOrbit.geometry.setFromPoints(track);
      this.issOrbit.geometry.computeBoundingSphere();
      this.issOrbit.visible = true;
    } else {
      this.issOrbit.visible = false;
    }
  }

  setIssVisible(v) {
    if (!this.iss) return;
    this.issSprite.visible = v;
    this.issOrbit.visible = v && this.issOrbit.geometry.attributes.position?.count > 1;
  }

  setProbe(lat, lon, color = '#ff4d7a') {
    this.probe = { lat, lon };
    const p = latLonToVec3(lat, lon, R * 1.012);
    const normal = p.clone().normalize();
    this.probeRing.position.copy(p);
    this.probeRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.probeRing.material.color.set(color);
    this.probeRing.visible = true;
  }

  clearProbe() {
    this.probe = null;
    this.probeRing.visible = false;
  }

  highlight(event) {
    this.selected = event;
    if (!event) { this.selRing.visible = false; this.label.style.display = 'none'; return; }
    const p = latLonToVec3(event.lat, event.lon, R * 1.015);
    const normal = p.clone().normalize();
    this.selRing.position.copy(p);
    this.selRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.selRing.material.color.set(CATEGORY_COLOR[event.cat] || '#9feeff');
    this.selRing.visible = true;
  }

  focus(lat, lon, distance = 2.9, animate = true) {
    const dir = latLonToVec3(lat, lon, 1);
    const from = this.camera.position.clone();
    const dist = Math.max(1.45, Math.min(5.5, distance ?? from.length()));
    const to = dir.multiplyScalar(dist);
    this.controls.autoRotate = false;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.controls.autoRotate = true; }, 40000);
    if (!animate) {
      this.camera.position.copy(to);
      this.controls.update();
      return;
    }
    this.cameraTween = {
      from, to,
      qFrom: from.clone().normalize(),
      qTo: to.clone().normalize(),
      t: 0,
      dur: 1.15,
      start: performance.now(),
    };
  }

  resetView() {
    this.focus(12, 40, 4.32);
    this.controls.autoRotate = true;
  }

  takeSnapshot() {
    try { this.composer.render(); return this.renderer.domElement.toDataURL('image/png'); } catch { return null; }
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.fov = w < 1100 ? 42 : 35;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, true);
    this.composer.setSize(w, h);
    this.bloom?.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    if (this.markerMat) this.markerMat.uniforms.uPixelRatio.value = pr;
    if (this.haloMat) this.haloMat.uniforms.uPixelRatio.value = pr;
    if (this.auroraMat) this.auroraMat.uniforms.uPixelRatio.value = pr;
    if (this.starMat) this.starMat.uniforms.uPixelRatio.value = pr;
  }

  _frame() {
    if (this.disposed) return;
    const t = this.clock.getElapsedTime();

    if (this.cameraTween) {
      const tw = this.cameraTween;
      const k = Math.min(1, (performance.now() - tw.start) / (tw.dur * 1000));
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      // rotate direction from -> to
      const qq = new THREE.Quaternion().setFromUnitVectors(tw.qFrom, tw.qTo);
      const qi = new THREE.Quaternion().slerp(qq, e);
      const dir = tw.qFrom.clone().applyQuaternion(qi).normalize();
      const dist = tw.from.length() + (tw.to.length() - tw.from.length()) * e;
      this.camera.position.copy(dir.multiplyScalar(dist));
      this.camera.lookAt(0, 0, 0);
      if (k >= 1) this.cameraTween = null;
    }

    this.controls.update();
    this.starGroup.rotation.y += 0.000035;
    this.clouds.rotation.y += 0.000075;
    this.markerMat.uniforms.uTime.value = t;
    this.haloMat.uniforms.uTime.value = t;
    this.auroraMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uTime.value = t;

    if (this.selRing.visible) {
      const s = 1 + 0.12 * Math.sin(t * 3);
      this.selRing.scale.setScalar(s);
    }
    if (this.probeRing.visible) {
      const s = 1 + 0.18 * Math.sin(t * 2.2);
      this.probeRing.scale.setScalar(s);
    }
    if (this.selected) this._placeLabel(this.selected.lat, this.selected.lon);

    this.composer.render();
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this._ro?.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}







