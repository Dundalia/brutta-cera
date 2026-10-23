// Table mode for the visuals player: the sheets lie on a lamp-lit wooden table
// among a few props, rendered with three.js. index.html runs the player itself and
// falls back to the plain full-screen view when this module cannot load (file://).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  BlendFunction,
  BloomEffect,
  BrightnessContrastEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from "postprocessing";

const { SETLIST, COVER, slides, setShown, attachTable, loading, finishLoading, getSpeed, SPREAD, spreadCamera, spreadFrame } = window.visuals;

// Where each sheet lies on the table: x, z in metres, rotation in degrees.
// About 20 cm apart, so the props in between show up on every move.
const LAYOUT = [
  [-0.8, -0.22, -9],
  [-0.3, -0.32, 6],
  [0.21, -0.24, -5],
  [0.74, -0.31, 11],
  [0.56, 0.23, -8],
  [0.04, 0.27, 4],
  [-0.5, 0.24, -12],
  [-1.12, 0.55, 0], // 7-quebec: the Polaroid spread (its cards are placed by quebec.js)
];
const SHEET_W = 0.3;
const SHEET_H = 0.225;
const COVER_SIZE = 0.25;
const WOOD_SIZE = 1.55; // metres covered by one tile of the wood photo
const VFOV = (30 * Math.PI) / 180;
const FIT_MARGIN = 0.96;
const MAX_TILT = (7 * Math.PI) / 180;

const canvas = document.getElementById("scene");
// On dense (retina) screens multisampling costs a lot and adds little.
const MAX_RATIO = Math.min(window.devicePixelRatio || 1, 2);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: MAX_RATIO < 2, powerPreference: "high-performance" });
let ratio = MAX_RATIO;
renderer.setPixelRatio(ratio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// The glass ashtray's refraction is rendered at half resolution: far cheaper, and
// the difference is invisible on such a small object.
renderer.transmissionResolutionScale = 0.5;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// Nothing on the table moves, so the lamp's shadow map is drawn once (and again
// whenever something is added) instead of every frame.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0806);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);

// --- film look, with the pmndrs "postprocessing" library ----------------------------
// Shallow depth of field that follows what the camera looks at, a soft bloom round
// strong lights, neutral tone mapping (keeps the drawings' whites close to true), a
// slightly faded grade, chromatic fringes, vignette and live grain.
renderer.toneMapping = THREE.NoToneMapping; // done by the effect chain instead
// no multisampling: the grain hides the edges anyway, and it saves a lot
const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera));
const dof = new DepthOfFieldEffect(camera, { worldFocusDistance: 0.5, worldFocusRange: 0.07, bokehScale: 2.2, resolutionScale: 0.5 });
dof.target = new THREE.Vector3();
composer.addPass(new EffectPass(camera, dof));
const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY });
grain.blendMode.opacity.value = 0.3;
composer.addPass(
  new EffectPass(
    camera,
    new BloomEffect({ luminanceThreshold: 0.9, luminanceSmoothing: 0.25, intensity: 0.5, mipmapBlur: true, radius: 0.75 }),
    new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }),
    new HueSaturationEffect({ saturation: -0.12 }),
    new BrightnessContrastEffect({ contrast: -0.1 }),
    new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0009, 0.0006), radialModulation: true, modulationOffset: 0.3 }),
    new VignetteEffect({ offset: 0.32, darkness: 0.5 }),
    grain
  )
);

const manager = new THREE.LoadingManager();
manager.onProgress = (url, loaded, total) => loading(0.08 + (0.74 * loaded) / total);
const textures = new THREE.TextureLoader(manager);
const aniso = renderer.capabilities.getMaxAnisotropy();
const small = matchMedia("(pointer: coarse)").matches || renderer.capabilities.maxTextureSize < 4096;

// --- light: a fireplace-lit room for reflections, plus a warm desk lamp ----------
const pmrem = new THREE.PMREMGenerator(renderer);
new RGBELoader(manager).load("assets/env/fireplace_1k.hdr", (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  hdr.dispose();
});
scene.add(new THREE.HemisphereLight(0xffeedd, 0x2a1a10, 0.35));
const lamp = new THREE.SpotLight(0xffd8a8, 9, 0, 0.8, 1, 2);
lamp.position.set(-0.45, 1.3, -0.55);
lamp.target.position.set(0.12, 0, 0.08);
lamp.castShadow = true;
lamp.shadow.mapSize.set(2048, 2048);
lamp.shadow.camera.near = 0.5;
lamp.shadow.camera.far = 3;
lamp.shadow.bias = -0.0002;
lamp.shadow.normalBias = 0.004;
scene.add(lamp, lamp.target);

// --- the table: photographed reclaimed planks (Poly Haven, CC0) ------------------
function tableTexture(url, srgb) {
  const t = textures.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5 / WOOD_SIZE, 4 / WOOD_SIZE);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const woodArm = tableTexture("assets/table/wood_arm_1k.jpg"); // AO, roughness, metalness
const tableTop = new THREE.Mesh(
  new THREE.PlaneGeometry(5, 4),
  new THREE.MeshStandardMaterial({
    map: tableTexture("assets/table/wood_diff_" + (small ? "2k" : "4k") + ".jpg", true),
    normalMap: tableTexture("assets/table/wood_nor_2k.jpg"),
    roughnessMap: woodArm,
    aoMap: woodArm,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.45,
  })
);
tableTop.rotation.x = -Math.PI / 2;
tableTop.receiveShadow = true;
scene.add(tableTop);

// --- soft contact shadows under the sheets (pre-blurred decals) --------------------
function shadowTexture(blur) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.shadowColor = "#000";
  g.shadowBlur = blur;
  g.shadowOffsetX = 1000;
  g.fillRect(256 * 0.15 - 1000, 256 * 0.15, 256 * 0.7, 256 * 0.7);
  return new THREE.CanvasTexture(c);
}
const contactShadow = shadowTexture(6);
const softShadow = shadowTexture(28);
function addShadow(tex, w, h, x, z, rot, opacity, dx, dz) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w / 0.7, h / 0.7),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false })
  );
  m.rotation.set(-Math.PI / 2, 0, rot);
  m.position.set(x + dx, 0.0003, z + dz);
  scene.add(m);
}

// --- sheets -------------------------------------------------------------------------
function random(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

// A sheet that is not perfectly flat: corners lift a few millimetres.
function paperGeometry(w, h, seed) {
  const g = new THREE.PlaneGeometry(w, h, 24, 18);
  g.rotateX(-Math.PI / 2);
  const r = random(seed * 7919 + 13);
  const lift = [r(), r(), r(), r()].map((v) => 0.0012 + v * 0.0045);
  const bow = r() * 0.0015;
  const p = g.attributes.position;
  for (let k = 0; k < p.count; k++) {
    const u = p.getX(k) / w + 0.5;
    const v = p.getZ(k) / h + 0.5;
    const nx = 2 * u - 1;
    const nz = 2 * v - 1;
    const corner = lift[0] * (1 - u) * (1 - v) + lift[1] * u * (1 - v) + lift[2] * (1 - u) * v + lift[3] * u * v;
    p.setY(k, corner * nx * nx * nz * nz + bow * nx * nx);
  }
  g.computeVertexNormals();
  return g;
}

// Lit paper that can cross-fade from its poster to the live video (uVideoMix) and,
// when the camera sits on it, show the texture's exact colours (uFocus): the mix
// happens after tone mapping, so the output encoding turns it back into the source.
function sheetMaterial(poster, u) {
  const m = new THREE.MeshStandardMaterial({ map: poster, roughness: 0.92, metalness: 0, envMapIntensity: 0.5 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader =
      "uniform sampler2D uVideo;\nuniform float uVideoMix;\nuniform float uFocus;\n" +
      "vec3 sheetToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }\n" +
      shader.fragmentShader
        .replace(
          "#include <map_fragment>",
          "vec4 sheetTexel = mix(texture2D(map, vMapUv), texture2D(uVideo, vMapUv), uVideoMix);\n" +
            "\tvec3 sheetLinear = sheetToLinear(sheetTexel.rgb);\n" +
            // landed on this sheet: skip all lighting and show the texture as is
            "\tif (uFocus > 0.999) { gl_FragColor = linearToOutputTexel(vec4(sheetLinear, 1.0)); return; }\n" +
            "\tdiffuseColor.rgb *= sheetLinear;"
        )
        .replace(
          "#include <tonemapping_fragment>",
          "#include <tonemapping_fragment>\n\tgl_FragColor.rgb = mix(gl_FragColor.rgb, sheetLinear, uFocus);"
        );
  };
  return m;
}

// "7-quebec": a spread of Polaroids in the bottom-left corner of the table, laid out by
// assets/polaroids/quebec.js. They glow a little (half self-lit) so they read in the
// lamp's dimmer corner; burst prints flip through their frames like stop-motion.
const CARD_W = 0.088;
const CARD_H = 0.107;
function polaroidSpread(i) {
  const [x, z] = LAYOUT[i];
  const edge = new THREE.MeshStandardMaterial({ color: 0xf1eee6, roughness: 0.8 });
  const glow = { value: 0.45 };
  const cards = window.QUEBEC.cards.map((card) => {
    const frames = card.frames.map((url) => {
      const t = textures.load(url);
      t.anisotropy = aniso;
      return t;
    });
    const top = sheetMaterial(frames[0], { uVideo: { value: frames[0] }, uVideoMix: { value: 0 }, uFocus: glow });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, 0.0011, CARD_H), [edge, edge, top, edge, edge, edge]);
    const turn = (-card.rot * Math.PI) / 180;
    mesh.position.set(card.x, 0.0012 + card.layer * 0.00035, card.z);
    mesh.rotation.y = turn;
    scene.add(mesh);
    addShadow(contactShadow, CARD_W, CARD_H, card.x, card.z, turn, 0.5, 0.001, 0.0015);
    addShadow(softShadow, CARD_W * 1.05, CARD_H * 1.05, card.x, card.z, turn, 0.45, 0.004, 0.006);
    return { card, frames, top, shown: 0 };
  });
  return {
    i,
    spread: cards,
    w: 0.4,
    h: 0.3,
    x,
    z,
    rot: 0,
    u: { uVideo: { value: null }, uVideoMix: { value: 0 }, uFocus: { value: 0 } },
    poster: null,
    videoTexture: null,
    live: false,
    fade: 0,
    time: 0,
  };
}

// Camera state for the current point of the spread tour.
function spreadPose(s) {
  const p = spreadCamera(s.time);
  return { x: p.x, z: p.z, yaw: p.yaw, d: p.frame / 2 / Math.tan(VFOV / 2), tilt: SPREAD.tilt };
}

// Stop-motion: show each burst print's frame for the current time.
function updateSpread(now) {
  for (const s of sheets) {
    if (!s.spread) continue;
    s.spread.forEach((c, k) => {
      if (c.frames.length < 2) return;
      const f = spreadFrame(c.card, k, (now / 1000) * getSpeed());
      if (f === c.shown) return;
      c.shown = f;
      c.top.map = c.frames[f];
    });
  }
}

const sheets = SETLIST.map((name, i) => {
  if (slides[i].spread) return polaroidSpread(i);
  const isCover = name === COVER;
  const w = isCover ? COVER_SIZE : SHEET_W;
  const h = isCover ? COVER_SIZE : SHEET_H;
  const [x, z, deg] = LAYOUT[i];
  const rot = (deg * Math.PI) / 180;
  const poster = textures.load(isCover ? "public/cover.png" : "assets/posters/" + encodeURIComponent(name) + ".jpg");
  poster.anisotropy = aniso;
  const u = { uVideo: { value: poster }, uVideoMix: { value: 0 }, uFocus: { value: 0 } };
  const mesh = new THREE.Mesh(paperGeometry(w, h, i + 1), sheetMaterial(poster, u));
  mesh.position.set(x, 0.0008 + i * 0.0002, z);
  mesh.rotation.y = rot;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  addShadow(contactShadow, w, h, x, z, rot, 0.55, 0.001, 0.0015);
  addShadow(softShadow, w * 1.03, h * 1.03, x, z, rot, 0.6, 0.009, 0.014);
  let videoTexture = null;
  if (!isCover) {
    // No mipmaps: regenerating them for every video frame costs more than it gives.
    videoTexture = new THREE.VideoTexture(slides[i].el);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.generateMipmaps = false;
  }
  return { i, w, h, x, z, rot, mesh, u, poster, videoTexture, live: false, fade: 0 };
});

// The printed cover card carries the same Spotify QR as the animated cover overlay
// (same SVG, same place), so it is always on the cover, not only once landed.
(function printQrOnCover() {
  const card = sheets.find((s) => s.i === 0);
  const svg = document.querySelector("#cover .qr svg");
  if (!card || !svg) return;
  const k = 1.6; // the overlay box is 1000px wide, the cover texture 1600px
  const copy = svg.cloneNode(true);
  copy.setAttribute("width", String(185 * k));
  copy.setAttribute("height", String(185 * k));
  const base = new Image();
  base.src = "public/cover.png";
  const qr = new Image();
  qr.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy));
  Promise.all([base.decode(), qr.decode()])
    .then(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 1600;
      const g = c.getContext("2d");
      g.drawImage(base, 0, 0, 1600, 1600);
      // as laid out by "body.table #cover .qr": 185px QR, 9px gap, 15px label, 3% from the bottom
      g.drawImage(qr, (500 - 92.5) * k, 761 * k, 185 * k, 185 * k);
      g.fillStyle = "#1b1107";
      g.font = `600 ${15 * k}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "bottom";
      if ("letterSpacing" in g) g.letterSpacing = `${15 * 0.14 * k}px`;
      g.fillText("ascolta su spotify", 800, 970 * k);
      const tex = new THREE.CanvasTexture(c);
      tex.anisotropy = aniso;
      card.mesh.material.map = tex;
      card.u.uVideo.value = tex;
      card.poster = tex;
    })
    .catch(() => {});
})();

// --- props --------------------------------------------------------------------------
const gltf = new GLTFLoader(manager);
function shade(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
  });
  return obj;
}
const lathe = (points, material, segments = 72) =>
  new THREE.Mesh(new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments), material);
const mm = (v) => v / 1000;

function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

// A cylinder between two points (strings, wires).
function rod(a, b, r, material) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), 8), material);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

// Woven wire mesh for the microphone grille, used as an alpha map.
function wireMesh() {
  const t = canvasTexture(
    256,
    256,
    (g) => {
      g.fillStyle = "#000";
      g.fillRect(0, 0, 256, 256);
      g.strokeStyle = "#fff";
      g.lineWidth = 2.4;
      for (let k = 4; k < 256; k += 8) {
        g.beginPath();
        g.moveTo(k, 0);
        g.lineTo(k, 256);
        g.moveTo(0, k);
        g.lineTo(256, k);
        g.stroke();
      }
    },
    false
  );
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3.2, 1.3);
  return t;
}

// A dynamic vocal mic in the SM58 style, lying on the table.
function microphone() {
  const black = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.45, metalness: 0.25 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xd9d9dd, roughness: 0.25, metalness: 1 });
  const mic = new THREE.Group();
  mic.add(lathe([[0, 0], [0.0098, 0], [0.0108, 0.002], [0.0108, 0.013], [0.0113, 0.0136]], steel));
  mic.add(
    lathe(
      [[0.0113, 0.0136], [0.0117, 0.03], [0.0129, 0.06], [0.0153, 0.088], [0.0187, 0.106], [0.0226, 0.1158], [0.0238, 0.1185], [0, 0.1185]],
      black
    )
  );
  mic.add(lathe([[0.0234, 0.118], [0.0252, 0.1188], [0.0255, 0.1226], [0.0236, 0.1234], [0, 0.1234]], steel));
  const grille = new THREE.Mesh(
    new THREE.SphereGeometry(0.0256, 72, 40, 0, Math.PI * 2, 0, Math.PI * 0.82),
    new THREE.MeshStandardMaterial({
      color: 0xd0d1d5,
      roughness: 0.32,
      metalness: 1,
      alphaMap: wireMesh(),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    })
  );
  grille.position.y = 0.1415;
  grille.scale.y = 0.94;
  const foam = new THREE.Mesh(new THREE.SphereGeometry(0.0236, 40, 28), new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 1 }));
  foam.position.y = 0.1405;
  foam.scale.y = 0.93;
  mic.add(grille, foam);
  // Lying down it rests on the tail and the grille, so its axis tilts up a little.
  const tilt = Math.asin((0.0256 - 0.0108) / 0.1415);
  mic.rotation.z = -Math.PI / 2 + tilt;
  mic.position.y = 0.0109;

  // XLR plug.
  const plug = new THREE.Group();
  plug.add(lathe([[0, 0], [0.0094, 0], [0.0096, 0.004], [0.0096, 0.034], [0.0078, 0.044], [0.0045, 0.05], [0.0036, 0.058], [0, 0.058]], black));
  plug.add(lathe([[0.0097, 0.004], [0.0099, 0.0045], [0.0099, 0.008], [0.0097, 0.0085]], steel));
  plug.rotation.z = Math.PI / 2;
  plug.position.set(-0.0005, 0.0096, 0);

  const group = new THREE.Group();
  group.add(mic, plug);
  return shade(group);
}

function cable(points) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0.0034, z)));
  const m = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 240, 0.0034, 12, false),
    new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.55, metalness: 0.1 })
  );
  return shade(m);
}

// A cigarette along +x, filter first; a butt has a short paper and a burnt tip.
const filterMat = new THREE.MeshStandardMaterial({ color: 0xc98d52, roughness: 0.8 });
const paperMat = new THREE.MeshStandardMaterial({ color: 0xefebe3, roughness: 0.85 });
const burntMat = new THREE.MeshStandardMaterial({ color: 0x2b2724, roughness: 1 });
function cigarette(paperLength, burnt) {
  const b = new THREE.Group();
  const part = (len, r, mat, x) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 24), mat);
    c.rotation.z = Math.PI / 2;
    c.position.x = x + len / 2;
    b.add(c);
  };
  part(0.021, 0.0039, filterMat, 0);
  part(paperLength, 0.0038, paperMat, 0.021);
  if (burnt) part(0.0035, 0.0035, burntMat, 0.021 + paperLength);
  return shade(b);
}

// A heavy round glass ashtray with three cigarette rests, a couple of butts and ash.
const NOTCHES = [0.4, 0.4 + (Math.PI * 2) / 3, 0.4 + (Math.PI * 4) / 3];
function ashtray() {
  // Real refraction: only rendered when the ashtray is in view.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.02,
    metalness: 0,
    transmission: 1,
    thickness: 0.014,
    ior: 1.5,
    attenuationColor: new THREE.Color(0xc4e6d6),
    attenuationDistance: 0.05,
    specularIntensity: 1,
    envMapIntensity: 1.4,
  });
  const group = new THREE.Group();
  const bowl = lathe(
    [[0, 0.0004], [0.05, 0.0004], [0.0555, 0.0022], [0.0585, 0.008], [0.06, 0.024], [0.0596, 0.0284], [0.0582, 0.0306], [0.0558, 0.0312], [0.0488, 0.0298], [0.0442, 0.0262], [0.0362, 0.0162], [0.0284, 0.0127], [0, 0.0121]],
    glass,
    120
  );
  // cut the three rests into the rim
  const p = bowl.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 0.022) continue;
    const a = Math.atan2(p.getZ(i), p.getX(i));
    let cut = 0;
    for (const n of NOTCHES) {
      const d = Math.atan2(Math.sin(a - n), Math.cos(a - n));
      cut = Math.max(cut, Math.exp(-(d * d) / (2 * 0.075 * 0.075)));
    }
    p.setY(i, y - cut * 0.0075 * ((y - 0.022) / 0.0092));
  }
  bowl.geometry.computeVertexNormals();
  group.add(bowl);
  const ashMat = new THREE.MeshStandardMaterial({ color: 0x8e8a85, roughness: 1 });
  const b1 = cigarette(0.012, true);
  b1.position.set(-0.022, 0.0162, 0.004);
  b1.rotation.set(0, 0.5, 0.05);
  // a longer butt resting in one of the notches, burnt end inside
  const rest = NOTCHES[0];
  const b2 = cigarette(0.02, true);
  b2.position.set(Math.cos(rest) * 0.072, 0.03, Math.sin(rest) * 0.072);
  b2.rotation.set(0, Math.PI - rest, -0.22);
  group.add(b1, b2);
  const r = random(77);
  for (let k = 0; k < 9; k++) {
    const a = new THREE.Mesh(new THREE.SphereGeometry(0.0022 + r() * 0.002, 10, 8), ashMat);
    const ang = r() * Math.PI * 2;
    const rad = r() * 0.02;
    a.position.set(Math.cos(ang) * rad, 0.0127, Math.sin(ang) * rad);
    a.scale.y = 0.35;
    group.add(a);
  }
  shade(group);
  bowl.castShadow = false;
  return group;
}

// --- herb grinder, open, with ground weed in the grinding chamber ------------------------
const aluMat = new THREE.MeshStandardMaterial({ color: 0x9ea3aa, roughness: 0.3, metalness: 1 });
const darkAluMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.5, metalness: 0.8 });
const GR = 0.0315;

// Fine vertical ridges on the side of a lathe piece.
function knurl(mesh, y0, y1) {
  const p = mesh.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < y0 + 0.0022 || y > y1 - 0.0022) continue;
    const x = p.getX(i);
    const z = p.getZ(i);
    const s = 1 + 0.022 * Math.max(0, Math.cos(Math.atan2(z, x) * 64));
    p.setX(i, x * s);
    p.setZ(i, z * s);
  }
  mesh.geometry.computeVertexNormals();
  return mesh;
}

function grinderSection(y0, y1) {
  const b = 0.0009;
  return lathe([[0, y0], [GR - b, y0], [GR, y0 + b], [GR, y1 - b], [GR - b, y1], [0, y1]], aluMat, 192);
}

// Rings of pyramid teeth standing on a floor at height y.
function teeth(radii, counts, y) {
  const g = new THREE.Group();
  const geo = new THREE.ConeGeometry(0.0017, 0.0042, 4);
  radii.forEach((rad, k) => {
    for (let i = 0; i < counts[k]; i++) {
      const a = ((i + (k % 2) * 0.5) / counts[k]) * Math.PI * 2;
      const t = new THREE.Mesh(geo, aluMat);
      t.position.set(Math.cos(a) * rad, y + 0.0021, Math.sin(a) * rad);
      t.rotation.y = -a;
      g.add(t);
    }
  });
  return g;
}

// Ground weed: many small irregular bits in greens, browns and orange hairs.
function herb(count, seed, where) {
  const mesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 }),
    count
  );
  const palette = [0x5f7426, 0x75892f, 0x8e9b3f, 0x4c5d1f, 0x6f7f2b, 0x9c8a45, 0x6d5528, 0xc2843a].map((c) => new THREE.Color(c));
  const r = random(seed);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const size = 0.0007 + r() * 0.0016;
    s.set(size * (0.8 + r() * 0.6), size * (0.5 + r() * 0.5), size * (0.7 + r() * 0.6));
    q.setFromEuler(e.set(r() * 6.3, r() * 6.3, r() * 6.3));
    m.compose(where(r), q, s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, palette[Math.floor(r() * palette.length)]);
  }
  return mesh;
}

function openGrinder() {
  const g = new THREE.Group();
  g.add(grinderSection(0, 0.0112), grinderSection(0.0118, 0.0226));
  g.add(lathe([[0, 0.0111], [GR - 0.0012, 0.0111], [GR - 0.0012, 0.0119], [0, 0.0119]], darkAluMat, 96));
  g.add(lathe([[0, 0.0225], [GR - 0.0012, 0.0225], [GR - 0.0012, 0.0233], [0, 0.0233]], darkAluMat, 96));
  // the grinding chamber is an open cup: rim, inner wall, floor with teeth
  const b = 0.0009;
  const y0 = 0.0232;
  const y1 = 0.034;
  const inner = 0.0262;
  const floor = 0.0262;
  g.add(lathe([[0, y0], [GR - b, y0], [GR, y0 + b], [GR, y1 - b], [GR - b, y1], [inner, y1], [inner, floor], [0, floor]], aluMat, 192));
  g.add(teeth([0.009, 0.015, 0.021], [6, 10, 14], floor));
  g.add(
    herb(700, 11, (r) => {
      const a = r() * Math.PI * 2;
      const rad = Math.sqrt(r()) * 0.0246;
      const heap = 0.0045 * (1 - rad / 0.027) + 0.0015;
      return new THREE.Vector3(Math.cos(a) * rad, floor + 0.0008 + r() * heap, Math.sin(a) * rad);
    })
  );
  return shade(g);
}

// The lid lies upside down next to it, teeth up, a few bits stuck inside.
function grinderLid() {
  const g = new THREE.Group();
  const h = 0.0134;
  const b = 0.0009;
  const inner = 0.0262;
  const depth = 0.006;
  const lid = lathe([[0, 0], [GR - b, 0], [GR, b], [GR, h - b], [GR - b, h], [inner, h], [inner, h - depth], [0, h - depth]], aluMat, 192);
  g.add(knurl(lid, 0, h));
  g.add(teeth([0.012, 0.018], [8, 12], h - depth));
  const magnet = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.0008, 32), darkAluMat);
  magnet.position.y = h - depth + 0.0004;
  g.add(magnet);
  g.add(
    herb(60, 12, (r) => {
      const a = r() * Math.PI * 2;
      const rad = 0.006 + r() * 0.018;
      return new THREE.Vector3(Math.cos(a) * rad, h - depth + 0.0007, Math.sin(a) * rad);
    })
  );
  return shade(g);
}

// --- a PS3 DualShock 3, lying face up -------------------------------------------------------
// The shell is a smooth mesh modelled offline (assets/models/ds3) together with a
// height map of its top, used to sit every button and recess on the curved plastic.
function decal(size, draw) {
  return canvasTexture(256, 256, (c) => {
    c.clearRect(0, 0, 256, 256);
    draw(c);
  });
}
function symbolDecal(color, path) {
  return decal(256, (c) => {
    c.strokeStyle = color;
    c.lineWidth = 20;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.beginPath();
    path(c);
    c.stroke();
  });
}

function ps3Controller() {
  const group = new THREE.Group();
  const shellMat = new THREE.MeshPhysicalMaterial({ color: 0x070708, roughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12 });
  const keyMat = new THREE.MeshPhysicalMaterial({ color: 0x0e0e11, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.08 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.82 });
  const matte = new THREE.MeshStandardMaterial({ color: 0x030303, roughness: 0.7 });
  const printMat = (tex) => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });

  const files = new THREE.FileLoader(manager);
  files.setResponseType("arraybuffer");
  const base = "assets/models/ds3/ds3_shell";
  Promise.all([
    new Promise((ok) => gltf.load(base + ".glb", ok)),
    new Promise((ok) => new THREE.FileLoader(manager).load(base + "_height.json", (t) => ok(JSON.parse(t)))),
    new Promise((ok) => files.load(base + "_height.bin", ok)),
  ]).then(([g, info, buffer]) => {
    let shell;
    g.scene.traverse((o) => {
      if (o.isMesh) shell = o;
    });
    shell.material = shellMat;
    group.add(shell);

    // Height of the shell's top (mm) at (x, z) in mm, bilinear in the map.
    const heights = new Float32Array(buffer);
    const heightAt = (x, z) => {
      const fx = Math.min(info.nx - 1.001, Math.max(0, (x - info.x0) / info.step));
      const fz = Math.min(info.nz - 1.001, Math.max(0, (z - info.z0) / info.step));
      const i = Math.floor(fx);
      const k = Math.floor(fz);
      const u = fx - i;
      const v = fz - k;
      const h = (a, b) => heights[a * info.nz + b];
      return (h(i, k) * (1 - u) + h(i + 1, k) * u) * (1 - v) + (h(i, k + 1) * (1 - u) + h(i + 1, k + 1) * u) * v;
    };
    const upY = new THREE.Vector3(0, 1, 0);
    const surface = (x, z) => {
      const e = 0.8;
      const normal = new THREE.Vector3(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
      return { point: new THREE.Vector3(mm(x), mm(heightAt(x, z)), mm(z)), normal };
    };
    // A dark recess that hugs the curved surface.
    const recess = (cx, cz, r, material, lift = 0.06) => {
      const geo = new THREE.RingGeometry(mm(0.01), mm(r), 48, 8);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = cx + pos.getX(i) * 1000;
        const z = cz + pos.getZ(i) * 1000;
        pos.setXYZ(i, mm(x), mm(heightAt(x, z) + lift), mm(z));
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, material);
      group.add(m);
      return m;
    };
    const put = (obj, x, z, lift = 0, spin = 0) => {
      const { point, normal } = surface(x, z);
      const holder = new THREE.Group();
      holder.position.copy(point).addScaledVector(normal, mm(lift));
      holder.quaternion.setFromUnitVectors(upY, normal);
      obj.rotation.y = spin;
      holder.add(obj);
      group.add(holder);
      return obj;
    };
    const disc = (r, material) => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(mm(r), 48), material);
      m.rotation.x = -Math.PI / 2;
      return m;
    };

    // D-pad: four separate arrow keys pointing at the centre
    const arrow = new THREE.Shape();
    arrow.moveTo(mm(-4), mm(3));
    arrow.lineTo(mm(-4), mm(11));
    arrow.lineTo(mm(4), mm(11));
    arrow.lineTo(mm(4), mm(3));
    arrow.lineTo(0, mm(-0.8));
    arrow.closePath();
    const arrowGeo = new THREE.ExtrudeGeometry(arrow, { depth: mm(1.8), bevelEnabled: true, bevelThickness: mm(0.7), bevelSize: mm(0.7), bevelSegments: 3 });
    arrowGeo.rotateX(-Math.PI / 2);
    const pad = [-46, -5];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const dx = Math.sin(a);
      const dz = -Math.cos(a);
      put(new THREE.Mesh(arrowGeo, keyMat), pad[0] + dx * 1.5, pad[1] + dz * 1.5, 0.2, -a);
    }
    recess(pad[0], pad[1], 16.5, matte);

    // face buttons: domed caps with their coloured symbols
    const face = [46, -5];
    const capGeo = new THREE.LatheGeometry([[0, 0], [5.1, 0], [5.25, 2.1], [4.8, 3.3], [3.1, 3.9], [0, 4.1]].map(([r, y]) => new THREE.Vector2(mm(r), mm(y))), 40);
    const symbols = [
      [0, -12, "#3ec9a7", (c) => { c.moveTo(128, 58); c.lineTo(196, 178); c.lineTo(60, 178); c.closePath(); }],
      [12, 0, "#ff5f57", (c) => c.arc(128, 128, 62, 0, Math.PI * 2)],
      [0, 12, "#7ba2f0", (c) => { c.moveTo(70, 70); c.lineTo(186, 186); c.moveTo(186, 70); c.lineTo(70, 186); }],
      [-12, 0, "#f08fd8", (c) => c.rect(70, 70, 116, 116)],
    ];
    for (const [dx, dz, color, path] of symbols) {
      const cap = put(new THREE.Mesh(capGeo, keyMat), face[0] + dx, face[1] + dz, -0.4);
      const mark = disc(3.4, printMat(symbolDecal(color, path)));
      mark.position.y = mm(4.15);
      cap.add(mark);
      recess(face[0] + dx, face[1] + dz, 6.3, matte);
    }

    // analog sticks: rubber caps, concave on top with a ridged rim
    const stickGeo = new THREE.LatheGeometry(
      [[0, 4.6], [6.4, 4.4], [9.4, 5.4], [10.5, 6.6], [10.7, 7.8], [10.1, 8.8], [8.9, 9.2], [7.3, 9.0], [3.6, 8.0], [0, 7.8]].map(([r, y]) => new THREE.Vector2(mm(r), mm(y))),
      96
    );
    const sp = stickGeo.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i);
      const z = sp.getZ(i);
      const r = Math.hypot(x, z);
      if (r < mm(9.6) || sp.getY(i) < mm(5.8)) continue;
      const f = 1 + 0.025 * Math.max(0, Math.cos(Math.atan2(z, x) * 40));
      sp.setX(i, x * f);
      sp.setZ(i, z * f);
    }
    stickGeo.computeVertexNormals();
    for (const sx of [-1, 1]) {
      const x = sx * 23;
      const z = 17;
      recess(x, z, 12.8, matte);
      put(new THREE.Mesh(new THREE.CylinderGeometry(mm(4), mm(4.6), mm(6), 24), rubber), x, z, 2.5);
      put(new THREE.Mesh(stickGeo, rubber), x, z, 0);
    }

    // PS button with its logo; SELECT and START with their printed labels
    const psTop = decal(256, (c) => {
      const grad = c.createRadialGradient(128, 110, 10, 128, 128, 128);
      grad.addColorStop(0, "#5d5e63");
      grad.addColorStop(1, "#2a2b2f");
      c.fillStyle = grad;
      c.beginPath();
      c.arc(128, 128, 126, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#0b0b0c";
      c.font = "italic 900 118px Arial Black, Arial, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("PS", 128, 134);
    });
    const ps = new THREE.Mesh(new THREE.CylinderGeometry(mm(5.6), mm(5.8), mm(1.4), 48), [keyMat, new THREE.MeshPhysicalMaterial({ map: psTop, roughness: 0.3, metalness: 0.5, clearcoat: 1 }), keyMat]);
    ps.position.y = mm(0.5);
    put(ps, 0, 9, 0);
    recess(0, 9, 7, matte);
    const label = (text) =>
      decal(256, (c) => {
        c.fillStyle = "rgba(235,235,235,0.92)";
        c.font = "600 38px Helvetica, Arial, sans-serif";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(text, 128, 128);
      });
    const select = new THREE.Shape();
    select.moveTo(mm(-3.6), mm(-1.9));
    select.lineTo(mm(3.6), mm(-1.9));
    select.lineTo(mm(3.6), mm(1.9));
    select.lineTo(mm(-3.6), mm(1.9));
    select.closePath();
    const start = new THREE.Shape();
    start.moveTo(mm(-3.4), mm(-2.6));
    start.lineTo(mm(3.8), 0);
    start.lineTo(mm(-3.4), mm(2.6));
    start.closePath();
    for (const [x, shape, text] of [[-13, select, "SELECT"], [13, start, "START"]]) {
      const geo = new THREE.ExtrudeGeometry(shape, { depth: mm(1), bevelEnabled: true, bevelThickness: mm(0.5), bevelSize: mm(0.6), bevelSegments: 2 });
      geo.rotateX(-Math.PI / 2);
      put(new THREE.Mesh(geo, keyMat), x, -9, 0.1);
      const print = new THREE.Mesh(new THREE.PlaneGeometry(mm(14), mm(14)), printMat(label(text)));
      print.rotation.x = -Math.PI / 2;
      put(print, x, -14.5, 0.08);
    }

    // player LEDs on the back edge, the first one lit
    for (let k = 0; k < 4; k++) {
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(mm(2.2), mm(0.4), mm(1.2)),
        k === 0 ? new THREE.MeshBasicMaterial({ color: 0xff3a2a, toneMapped: false }) : new THREE.MeshStandardMaterial({ color: 0x2a0d0b, roughness: 0.4 })
      );
      put(led, -6 + k * 4, -31.5, 0.1);
    }

    // L1 / R1 on the back corners
    const bumper = new THREE.Shape();
    bumper.absarc(mm(-11), 0, mm(5), Math.PI / 2, (Math.PI * 3) / 2, false);
    bumper.absarc(mm(11), 0, mm(5), -Math.PI / 2, Math.PI / 2, false);
    const bumperGeo = new THREE.ExtrudeGeometry(bumper, { depth: mm(6), bevelEnabled: true, bevelThickness: mm(2), bevelSize: mm(2), bevelSegments: 4 });
    for (const sx of [-1, 1]) {
      const l1 = new THREE.Mesh(bumperGeo, keyMat);
      l1.rotation.set(-Math.PI / 2, 0, sx * 0.1);
      l1.position.set(mm(sx * 46), mm(12.5), mm(-30.5));
      group.add(l1);
    }

    shade(group);
    renderer.shadowMap.needsUpdate = true;
  });
  group.scale.setScalar(1.02);
  return group;
}

// --- an electric guitar: a sunburst Stratocaster lying on its back ------------------------------
// Built in millimetres at full size, then scaled down a touch so it fits between the sheets.
// Outlines traced from a to-scale drawing ("Red Fender Stratocaster.svg" by Johan Förberg,
// Wikimedia Commons, CC BY-SA 3.0): pairs of u (from the nut toward the bridge) and v (across
// the strings, treble side positive). In the guitar's own frame x = -u, z = v, y is up.
const STRAT = {
  body: [398,-28.8,400.7,-30.2,403.1,-31.9,405.2,-34,407,-36.5,408.4,-39.4,409.4,-42.5,409.9,-45.9,409.9,-49.9,409.6,-54.2,408.9,-58.6,407.8,-63.2,406.1,-67.7,403.9,-71.9,401.5,-75.7,398.5,-79.3,395.3,-82.5,391.5,-85.4,387.3,-88.1,382.8,-90.3,379.1,-91.8,376.8,-92.7,369.9,-94.1,363,-94.9,356,-95.6,349,-96.1,346,-96.2,343.3,-96,340.8,-96.3,338.7,-96.9,336.7,-98.1,335.1,-99.6,333.7,-101.7,332.6,-104.5,332,-107.4,331.8,-110.4,332.1,-113.1,333,-116,334.4,-118.6,336.9,-121.8,340.4,-125.3,345.1,-129.1,350,-132.4,354.6,-135,358.5,-136.7,361.8,-137.9,368.7,-139.1,375.6,-140.1,382.6,-140.9,388,-141.5,390.8,-141.6,397.8,-141,404.7,-140.2,411.6,-139.2,418.5,-138.1,425.4,-136.8,432.3,-135.3,439.1,-133.7,445.8,-131.9,452.6,-129.9,459.2,-127.8,465.8,-125.4,472.4,-123.1,479.1,-120.9,485.8,-118.9,492.5,-117.1,499.3,-115.5,506.2,-114.2,513.2,-113.3,518.9,-112.8,523.6,-112.9,530.6,-113.7,537.5,-115.1,544.2,-116.8,550.9,-118.9,557.5,-121.2,564.1,-123.8,570.5,-126.5,576.8,-129.5,583,-132.7,589.2,-136.1,595.3,-139.5,601.6,-142.5,608,-145.3,614.5,-147.9,621.1,-150.2,627.8,-152.3,634.6,-154.2,641.4,-155.8,648.2,-157.3,655.1,-158.5,662,-159.6,669,-160.4,676,-160.9,682.2,-161.1,689.2,-160.9,696.2,-160.2,703.1,-159,709.4,-157.5,715.4,-155.7,721,-153.5,726.1,-151,731.1,-148.1,735.3,-145,739.1,-141.7,742.6,-138.1,747,-132.7,751.2,-127.1,755.2,-121.4,759.1,-115.5,762.7,-109.5,766.1,-103.4,769.3,-97.2,772.2,-90.8,773.9,-86.7,775.9,-79.9,777.5,-73.1,779,-66.3,780.3,-59.4,781.5,-52.5,782.4,-45.6,783.3,-38.6,784,-31.7,784.5,-24.7,784.9,-17.7,785.2,-10.7,785.3,-3.7,785.3,1,785.6,8,785.9,15,786,22,786.1,29,786,36,785.8,43,785.5,50,785.1,57,784.6,64,783.8,71,782.9,77.9,781.8,84.8,780.3,91.7,778.6,98.2,776.4,104.6,773.7,111,770.5,117.3,766.9,123.3,763.4,128.4,759.3,133.5,755,138.3,750.3,142.8,745.8,146.5,742.4,149,738.8,151.7,734.1,154.5,728.9,156.9,723,159.1,716.5,160.9,709.9,162.3,703,163.3,696,163.9,689,164.1,682,163.9,675,163.4,668.1,162.7,661.2,161.5,654.3,160.1,647.5,158.5,640.8,156.6,634.1,154.4,627.5,152.1,621,149.6,614.5,147,608.1,144.2,601.7,141.2,595.4,138.1,589.2,134.9,583.1,131.5,577.8,128.2,572.3,125.2,566,122.2,559.9,119.9,553.4,118,546.8,116.6,540.4,115.7,534.2,115.3,527.7,115.3,522.9,115.7,517.8,116.6,512.9,117.8,508.2,119.5,502.1,122.4,495.7,125.3,489.2,127.9,482.7,130.4,476.1,132.6,469.4,134.7,462.6,136.5,455.8,138.1,449.4,139.1,443.6,139.7,438.4,139.8,433.9,139.5,427,138.3,420.7,137,415.4,135.5,410.9,133.8,407.1,131.9,404.2,130.1,401.7,127.9,399.6,125.5,397.9,122.7,396.7,119.7,396,117,395.8,114.8,396.2,112.3,397.2,109.8,398.6,107.4,400.5,105.4,402.9,103.7,405.1,102.6,412.2,101,419.1,99.7,423.3,99,427.7,97.9,431.9,96.4,435.9,94.4,439.7,92,443.2,89.2,446.6,85.9,449.4,82.3,451.9,78.3,453.7,74.5,455.2,70.2,456.2,65.8,456.7,61.1,456.7,56.4,456.2,51.6,455.2,46.8,453.7,42.2,452,38.3,450,34.9,448.1,32.3,446.1,30.3,444.7,29.3,443.3,28.9,436,28.9,429,28.9,422,28.9,415,28.9,408,28.9,401,28.9,396.3,28.9,394.6,28.8,392.8,27.9,391.2,27.1,390.4,26.6,390.2,25.4,390.1,18.4,390,11.4,389.9,4.4,389.8,-2.6,389.7,-9.6,389.6,-16.6,389.5,-21.6,389.5,-22.8,389.9,-23.9,390.9,-24.5,396.5,-27.9],
  guard: [410.6,114.2,411.3,114.1,412.3,114,417.8,113.4,423.7,112.3,429.2,110.9,434.7,109.1,439.8,107,444.5,104.7,448.6,102.2,452.2,99.6,455.4,96.8,458.3,93.7,460.8,90.5,462.9,87.2,464.9,83.4,466.6,79,468,74.2,469,69.5,469.5,64.8,469.7,60.1,469.5,55.3,468.9,50.4,467.9,45.5,466.4,40.4,464.7,35.7,462.6,31.2,461.5,29.1,463.5,24.2,465.1,19.4,466.3,14.6,467.1,9.7,467.6,4.8,467.8,0,467.6,-4.9,467.1,-9.7,466.3,-14.6,465.1,-19.4,463.5,-24.3,461.5,-29.1,436.9,-29.1,430.8,-43.6,430.7,-45.3,430.8,-47.5,431.3,-49.5,432.2,-51.3,433.3,-52.6,434.7,-53.6,436.6,-54.4,438.6,-54.7,441.5,-54.5,448.4,-53.1,455.2,-51.5,462,-50,468.9,-48.7,475.6,-47.9,481.6,-47.4,487.6,-47.4,493.8,-47.8,500.8,-48.7,507.7,-49.6,514.6,-50.7,521.5,-52.1,528.3,-53.9,534.9,-56,541.5,-58.4,548,-61,554.5,-63.6,561,-66.2,567.3,-68.8,573.2,-70.8,579.2,-72.5,584.5,-73.7,590.7,-74.7,596.4,-75.2,602.2,-75.3,607.9,-75.1,613.2,-74.5,618.6,-73.4,623.6,-72,628.1,-70.4,631.5,-68.9,634,-67.3,636.8,-65.1,639.2,-62.6,641.4,-59.8,643.3,-56.6,644.7,-53.4,645.8,-50.1,646.5,-46.4,646.8,-42.7,646.8,-40.9,646.8,-40.2,646.6,-39.6,645.9,-39.4,645.2,-39.4,638.7,-39.3,637.2,-39.3,635.8,-38.8,634.6,-37.9,633.8,-36.9,633.4,-35.8,633.5,-28.5,633.5,-21.5,633.6,-14.5,633.7,-7.5,633.7,-0.5,633.8,6.5,633.9,13.5,634,20.5,634,27.5,634.1,31.7,634.1,33.2,634.7,34.6,635.6,35.7,636.9,36.6,638.3,36.9,645.3,37.1,646.5,37.1,647.2,37.2,647.6,37.9,647.6,38.7,647.9,45.7,648.4,52.7,649.1,59.6,650,66.6,651,72,652.1,76.3,653.3,79.6,654.5,82.1,658.5,87.9,662.6,93.5,666.8,99.2,671,104.7,675.2,110.3,679.5,115.9,683.8,121.4,687.8,126.5,688.8,127.9,689.5,129.5,690.2,132.4,690.4,135.2,690.2,137.7,689.6,139.8,688.6,141.9,687.2,143.6,685.5,145.1,683.4,146.3,681,147.3,678.8,147.7,675.6,147.7,670.6,147.1,664,145.7,657.3,143.9,650.6,141.8,644,139.6,637.4,137.2,630.8,134.7,624.3,132.2,617.8,129.5,611.4,126.8,605,124,598.6,121.1,592.3,118.1,589.6,116.7,587.8,115.4,581.4,112.5,574.9,109.9,568.3,107.6,561.6,105.5,554.9,103.7,549,102.5,543.3,101.6,538.3,101.2,533.8,101.1,529.9,101.4,523,102.8,516.2,104.6,509.5,106.6,502.9,108.9,496.4,111.3,489.9,114,483.5,116.8,477.4,119.2,470.8,121.5,464.1,123.4,457.3,125,450.9,126.1,445.4,126.7,440.1,126.9,435.4,126.7,430.9,126.2,427,125.3,423.5,124.2,417.1,121.2,413.1,119.3,411.5,118.5,410.6,117.6,410.1,116.5,410,115.5,410.2,114.8],
  head: [-8.3,-21.2,-9,-21.5,-9.9,-21.9,-11.8,-23,-13.8,-24.6,-15.3,-26.2,-16.6,-28,-17.7,-30.3,-18.9,-31.9,-20,-33.2,-21.2,-34.1,-22.4,-34.6,-23.6,-34.9,-24.8,-34.6,-29.6,-33.1,-34.4,-31.7,-39.1,-30.2,-43.9,-28.7,-48.7,-27.2,-53.5,-25.8,-58.3,-24.3,-63,-22.8,-67.8,-21.4,-72.6,-19.9,-77.4,-18.4,-82.2,-16.9,-86.9,-15.5,-91.7,-14,-96.5,-12.5,-101.3,-11,-106,-9.6,-110.8,-8.1,-115.6,-6.6,-120.4,-5.1,-125.2,-3.7,-129.9,-2.2,-134.7,-0.7,-139.5,0.8,-144.3,2.2,-149.1,3.7,-153.8,5.2,-158.6,6.7,-163.4,8.2,-166.2,9.1,-169,10.3,-171.6,11.8,-174,13.5,-176.2,15.6,-178,17.6,-179.6,19.9,-180.8,22.4,-181.8,24.9,-182.5,27.8,-182.9,31.1,-182.9,34.3,-182.6,37.5,-182,40.5,-181.2,43.1,-180,45.6,-178.5,47.9,-176.8,50,-174.8,51.9,-172.3,53.6,-169.7,55.1,-166.9,56.2,-163.1,57.3,-160.4,57.8,-157.4,58,-154.4,57.8,-151.7,57.3,-149,56.5,-146.5,55.4,-144.2,54,-142,52.3,-139.8,50.3,-137.8,47.7,-135.9,44.8,-134.2,41.5,-133.4,39.9,-132.5,38.7,-131.1,37.6,-129.4,36.6,-127.3,35.9,-125.1,35.5,-122.8,35.4,-117.9,36.1,-112.9,37,-108,37.8,-103.1,38.8,-98.2,39.8,-93.3,40.9,-88.5,42.2,-84.2,43.4,-79.3,44.7,-74.4,45.8,-69.6,46.9,-64.6,47.8,-59.7,48.6,-54.8,49.3,-51.3,49.6,-50,49.6,-49.1,49.5,-48.5,48.7,-45.8,44.5,-42.8,40.5,-39.6,36.7,-36.4,33.4,-33.1,30.4,-30,28,-26.8,25.9,-23.7,24.3,-20.7,23,-17.6,22.1,-14.7,21.5,-11.7,21.3,-9.4,21.4,-8.4,21.5],
  jack: [695.5,60.7,697.1,61.8,701.7,65.7,706.7,70.7,711.4,75.8,715.9,81.2,719.9,86.4,723.5,91.8,726.8,97.4,729,101.9,730.6,106.1,731.9,110.5,732.5,113.9,732.8,117.9,732.5,121.9,731.6,125.8,731.1,126.6,730.7,126.9,728.8,127.4,726.3,127.4,723.4,126.8,720.1,125.6,717,124,713.6,121.8,709.9,119.2,705.7,115.7,699.2,109.4,695.9,105.7,692.4,101.4,686.3,92.8,680.4,82.9,677.7,77.6,676.9,74.2,676.7,71.7,676.9,69.2,677.4,67.2,678.3,65.4,679.4,63.8,680.9,62.5,683,61.1,685.3,60.1,687.2,59.6,689.7,59.3,692.2,59.5,694.2,60],
  jackIn: [689.7,90.7,705,77,705.9,76.5,706.8,76.3,707.8,76.5,708.2,76.8,712.8,82.1,717.7,88.5,721.5,94.4,724.6,100.7,726.4,105.9,727,110.4,726.9,112.4,726.6,114.4,725.9,116.2,725.1,117.5,723.9,118.4,722.5,118.9,721,119,719,118.7,717.1,118.1,714.8,117.1,710.2,114.1,704.5,109.2,697.9,102.3,690,92.5,689.6,91.6],
  plate: [637.9,-38.1,670.4,-38.7,671.9,-38.5,672.7,-38,673,-37.6,673.1,-36.7,673.5,33.8,672.3,43.8,672.2,44.2,671.9,44.4,652.9,44.5,652.2,44,651.8,43,651.5,36.1,651.3,35.2,650.4,35,638.9,35.1,638,34.8,637.2,34.2,636.4,32.9,636.2,32,636.1,30.5,635.7,-34.5,635.8,-35.5,636.4,-36.9,637,-37.7],
  posts: [-38.6, -20.4, -61.7, -13.2, -85.6, -5.5, -108.5, 1.8, -132.1, 7.6, -155.5, 14.9],
  keys: [-50.2, -36.7, -72.6, -30.2, -96, -22.6, -119, -15.9, -142.4, -8.7, -166.1, -1.2],
  tree: [-66.5, 14.9],
  knobs: [615.6, 54, 636.2, 93.2, 665.4, 127.6],
  switch: [593.1, 96.2],
  screws: [518.1, -45.9, 437.7, -47.4, 588.2, -68.6, 639.9, -52.1, 642.1, 42, 679.9, 136.3, 624.6, 125.8, 574.6, 103.2, 481.1, 110.3, 469.8, 33.9, 421.6, 116.7],
  jackScrews: [684.6, 65.5, 729.1, 123.2],
  jackNut: [702.9, 91.7],
  straps: [328.7, -99.8, 790.1, 0],
  dots: [88.3, 0, 149.1, 0, 203.4, 0, 251.7, 0, 314.4, -13.3, 314.4, 13.3, 367, 0, 397.2, 0, 424.3, 0, 448.6, 0],
};
const stratPoints = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([-flat[i], flat[i + 1]]);
  return out;
};

// A flat part with a profiled edge (a body with rounded edges, a bevelled pickguard...).
// outline: closed polyline of [x, z]. profile(x, z): [inset, y] pairs from the edge of the flat
// top outward and down the side (a repeated pair makes a crease). uv(x, y, z, ring, nx, nz)
// gives the texture coordinates, with (nx, nz) pointing inward.
function edgedSlab(outline, profile, uv, { holes = [], bottom = false } = {}) {
  const pts = outline.map(([x, z]) => new THREE.Vector2(x, z));
  if (THREE.ShapeUtils.area(pts) < 0) pts.reverse();
  const n = pts.length;
  const inward = pts.map((p, i) => {
    const a = pts[(i + n - 1) % n];
    const b = pts[(i + 1) % n];
    const n1 = new THREE.Vector2(a.y - p.y, p.x - a.x).normalize();
    const n2 = new THREE.Vector2(p.y - b.y, b.x - p.x).normalize();
    const m = n1.clone().add(n2).normalize();
    return m.multiplyScalar(1 / Math.max(0.5, m.dot(n1)));
  });
  const prof = pts.map((p) => profile(p.x, p.y));
  const rings = prof[0].length;
  const pos = [];
  const uvs = [];
  const idx = [];
  for (let r = 0; r < rings; r++)
    for (let i = 0; i < n; i++) {
      const [d, y] = prof[i][r];
      const x = pts[i].x + inward[i].x * d;
      const z = pts[i].y + inward[i].y * d;
      pos.push(x, y, z);
      uvs.push(...uv(x, y, z, r, inward[i].x, inward[i].y));
    }
  for (let r = 0; r < rings - 1; r++)
    for (let i = 0; i < n; i++) {
      const a = r * n + i;
      const b = r * n + ((i + 1) % n);
      idx.push(a, b, b + n, a, b + n, a + n);
    }
  const cap = (r, up, loops) => {
    const y = pos[3 * r * n + 1];
    const contour = [];
    for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(pos[3 * (r * n + i)], pos[3 * (r * n + i) + 2]));
    const base = pos.length / 3;
    const holes2 = loops.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
    for (const h of holes2)
      for (const p of h) {
        pos.push(p.x, y, p.y);
        uvs.push(...uv(p.x, y, p.y, r, 0, 0));
      }
    const at = (k) => (k < n ? r * n + k : base + k - n);
    for (const f of THREE.ShapeUtils.triangulateShape(contour, holes2)) {
      let [a, b, c] = f.map(at);
      const ny = (pos[3 * b + 2] - pos[3 * a + 2]) * (pos[3 * c] - pos[3 * a]) - (pos[3 * b] - pos[3 * a]) * (pos[3 * c + 2] - pos[3 * a + 2]);
      if (ny > 0 !== up) [b, c] = [c, b];
      idx.push(a, b, c);
    }
  };
  cap(0, true, holes);
  if (bottom) cap(rings - 1, false, []);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// A grid surface: point(i, j) and uv(i, j) for i <= rows, j <= cols. Faces point toward `out`
// (a direction checked at the middle of the grid).
function gridSurface(rows, cols, point, uv, out) {
  const pos = [];
  const uvs = [];
  const idx = [];
  for (let i = 0; i <= rows; i++)
    for (let j = 0; j <= cols; j++) {
      pos.push(...point(i, j));
      uvs.push(...uv(i, j));
    }
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j;
      const b = a + cols + 1;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const k = Math.floor(rows / 2) * (cols + 1) + Math.floor(cols / 2);
  const nrm = geo.attributes.normal;
  if (nrm.getX(k) * out[0] + nrm.getY(k) * out[1] + nrm.getZ(k) * out[2] < 0) {
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }
  return geo;
}

// Points of a polygon moved inward by d (mm).
function insetPolygon(outline, d) {
  const g = edgedSlab(outline, () => [[d, 0]], () => [0, 0]);
  const p = g.attributes.position;
  const out = [];
  for (let i = 0; i < outline.length; i++) out.push([p.getX(i), p.getZ(i)]);
  return out;
}

// Squared distance to the nearest zero of f along one line (Felzenszwalb & Huttenlocher).
function distance1d(f, n, out, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    while ((s = (f[q] + q * q - f[v[k]] - v[k] * v[k]) / (2 * q - 2 * v[k])) <= z[k]) k--;
    v[++k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  for (let q = 0, j = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    out[q] = (q - v[j]) * (q - v[j]) + f[v[j]];
  }
}
// Euclidean distance (in cells) from every cell of a w x h grid to the nearest cell where seed is true.
function distanceField(seed, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const d = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = seed(i) ? 0 : 1e20;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x];
    distance1d(f, h, out, v, z);
    for (let y = 0; y < h; y++) d[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x];
    distance1d(f, w, out, v, z);
    for (let x = 0; x < w; x++) d[y * w + x] = Math.sqrt(out[x]);
  }
  return d;
}

// The body's three-tone sunburst: coloured by the distance from the edge, so the dark band
// follows the outline, with alder grain showing through the amber.
const BURST = { u0: 326, u1: 792, v0: -168, v1: 168 };
function sunburstTexture(outline) {
  const { u0, u1, v0, v1 } = BURST;
  const cell = 2; // mm
  const GW = (u1 - u0) / cell;
  const GH = (v1 - v0) / cell;
  const small = document.createElement("canvas");
  small.width = GW;
  small.height = GH;
  const sg = small.getContext("2d");
  sg.beginPath();
  outline.forEach(([x, z], i) => (i ? sg.lineTo((u1 + x) / cell, (z - v0) / cell) : sg.moveTo((u1 + x) / cell, (z - v0) / cell)));
  sg.fill();
  const mask = sg.getImageData(0, 0, GW, GH).data;
  const inside = (i) => mask[4 * i + 3] > 127;
  const toEdge = distanceField((i) => !inside(i), GW, GH);
  const fromBody = distanceField(inside, GW, GH);
  const img = sg.createImageData(GW, GH);
  const ramp = [
    [-4, [5, 3, 2]],
    [0, [12, 6, 3]],
    [9, [20, 9, 4]],
    [20, [44, 14, 6]],
    [31, [96, 32, 11]],
    [42, [160, 72, 22]],
    [56, [206, 128, 46]],
    [76, [226, 164, 74]],
    [110, [232, 178, 92]],
  ];
  for (let j = 0; j < GH; j++)
    for (let i = 0; i < GW; i++) {
      const u = u1 - (i + 0.5) * cell;
      const v = v0 + (j + 0.5) * cell;
      const c = j * GW + i;
      let d = inside(c) ? (toEdge[c] - 0.5) * cell : -(fromBody[c] - 0.5) * cell;
      // a slightly uneven spray
      d += 3 * Math.sin(u * 0.031 + 1.3) * Math.sin(v * 0.027 + 0.4) + 2 * Math.sin(u * 0.013 - v * 0.021);
      let k = 1;
      while (k < ramp.length - 1 && ramp[k][0] < d) k++;
      const [da, ca] = ramp[k - 1];
      const [db, cb] = ramp[k];
      const t = Math.max(0, Math.min(1, (d - da) / (db - da)));
      const s = t * t * (3 - 2 * t);
      for (let q = 0; q < 3; q++) img.data[4 * c + q] = ca[q] + (cb[q] - ca[q]) * s;
      img.data[4 * c + 3] = 255;
    }
  sg.putImageData(img, 0, 0);
  return canvasTexture(1024, 740, (c, w, h) => {
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    c.drawImage(small, 0, 0, w, h);
    // alder grain along the body, and the glue line of a two-piece body
    const r = random(71);
    const px = w / (u1 - u0);
    c.globalCompositeOperation = "multiply";
    c.lineCap = "round";
    for (let k = 0; k < 260; k++) {
      const vv = v0 + r() * (v1 - v0);
      const amp = 0.6 + r() * 3.5;
      const len = 90 + r() * 260;
      const ph = r() * 6.3;
      const dark = 150 + Math.floor(r() * 70);
      c.strokeStyle = `rgba(${dark},${Math.floor(dark * 0.62)},${Math.floor(dark * 0.32)},${0.06 + r() * 0.16})`;
      c.lineWidth = (0.4 + r() * 2.2) * px;
      c.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const u = u1 - x / px;
        const y = (vv - v0 + amp * Math.sin((u / len) * 6.28 + ph) + 0.4 * amp * Math.sin(u / 23 + ph)) * px;
        if (x === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.stroke();
    }
    c.strokeStyle = "rgba(150,100,60,0.35)";
    c.lineWidth = 0.5 * px;
    c.beginPath();
    c.moveTo(0, (21 - v0) * px);
    c.lineTo(w, (21.6 - v0) * px);
    c.stroke();
    c.globalCompositeOperation = "source-over";
  });
}

// Cream plastic parts share one texture: the pickguard's top, its three-ply bevel, the knob
// tops and skirts, the pickup cover tops and the nut.
const PLASTIC = {
  guard: { u0: 405, u1: 695, v0: -80, v1: 152, h: 816 },
  stripe: [0, 820, 256, 60],
  nut: [256, 820, 256, 40],
  white: [512, 820, 128, 60],
  dark: [768, 820, 128, 60],
  knobs: [
    [0, 896, 128, 128],
    [128, 896, 128, 128],
  ],
  skirt: [256, 896, 512, 48],
  cover: [256, 944, 512, 80],
};
const atlasUV = (px, py, size = 1024, height = size) => [px / size, 1 - py / height];
function plasticTexture(guardHoles, slot, strings) {
  const P = PLASTIC;
  return canvasTexture(1024, 1024, (c) => {
    const cream = "#f2ecdf";
    c.fillStyle = cream;
    c.fillRect(0, 0, 1024, 1024);
    // pickguard: faint swirl marks, the switch slot and the dark gaps round the pickups
    const { u0, u1, v0, v1, h } = P.guard;
    const k = 1024 / (u1 - u0);
    const gx = (u) => (u1 - u) * k;
    const gy = (v) => ((v - v0) / (v1 - v0)) * h;
    const r = random(29);
    c.lineWidth = 1;
    for (let i = 0; i < 90; i++) {
      c.strokeStyle = `rgba(${r() < 0.5 ? "255,255,255" : "120,110,90"},${0.05 + r() * 0.08})`;
      c.beginPath();
      c.arc(r() * 1024, r() * h, 20 + r() * 260, r() * 6.3, r() * 6.3 + 0.3 + r());
      c.stroke();
    }
    c.fillStyle = "#1b1813";
    for (const loop of guardHoles) {
      c.beginPath();
      loop.forEach(([x, z], i) => (i ? c.lineTo(gx(-x), gy(z)) : c.moveTo(gx(-x), gy(z))));
      c.closePath();
      c.fill();
    }
    c.save();
    c.translate(gx(slot.u), gy(slot.v));
    c.rotate(Math.atan2(slot.dv, -slot.du));
    c.beginPath();
    c.roundRect(-11.5 * k, -1.7 * k, 23 * k, 3.4 * k, 1.7 * k);
    c.fill();
    c.restore();
    // three-ply edge: white, black, white
    const [sx, sy, sw, sh] = P.stripe;
    c.fillStyle = "#151515";
    c.fillRect(sx, sy + sh * (0.8 / 2.3), sw, sh * (0.4 / 2.3));
    c.fillStyle = "#f0ebde";
    c.fillRect(...P.white);
    c.fillStyle = "#141210";
    c.fillRect(...P.dark);
    // nut (bone) with its six slots
    const [nx, ny, nw, nh] = P.nut;
    c.fillStyle = "#efe6cf";
    c.fillRect(nx, ny, nw, nh);
    c.fillStyle = "rgba(90,75,50,0.55)";
    for (const { v, r: sr } of strings) c.fillRect(nx + ((21.4 - v) / 42.8) * nw - sr * 6, ny, sr * 12, nh);
    // knob tops: a rim, and the word
    ["VOLUME", "TONE"].forEach((word, i) => {
      const [kx, ky, kw] = P.knobs[i];
      const cx = kx + kw / 2;
      const cy = ky + kw / 2;
      c.fillStyle = cream;
      c.fillRect(kx, ky, kw, kw);
      c.strokeStyle = "rgba(110,95,70,0.45)";
      c.lineWidth = 2;
      c.beginPath();
      c.arc(cx, cy, 52, 0, 6.3);
      c.stroke();
      c.fillStyle = "rgba(60,52,40,0.85)";
      c.font = "bold 17px Helvetica, Arial, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(word, cx, cy);
    });
    // knob skirts: the numbers 1 to 10
    const [kx, ky, kw, kh] = P.skirt;
    c.fillStyle = "rgba(40,36,30,0.9)";
    c.font = "bold 26px Helvetica, Arial, sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    for (let i = 1; i <= 10; i++) {
      c.save();
      c.translate(kx + ((i - 0.5) / 11.5) * kw, ky + kh * 0.5);
      c.scale(0.55, 1);
      c.fillText(String(i), 0, 0);
      c.restore();
    }
    // pickup cover top: the dark gaps round the six pole pieces
    const [cx0, cy0, cw, ch] = P.cover;
    const L = 70.7;
    const W = 18.3;
    c.fillStyle = "#0e0c0a";
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      c.ellipse(cx0 + ((-26.25 + 10.5 * i + L / 2) / L) * cw, cy0 + ch / 2, (2.9 / L) * cw, (2.9 / W) * ch, 0, 0, 6.3);
      c.fill();
    }
  });
}

// Maple: the headstock face (with its decal) above, the back of the neck below.
const MAPLE = { head: { x0: -2, x1: 186, z0: -42, z1: 62, h: 384 }, neck: { u0: -20, u1: 470, y: 384, h: 128 } };
function mapleTexture() {
  return canvasTexture(1024, 512, (c) => {
    c.fillStyle = "#d4a05a";
    c.fillRect(0, 0, 1024, 512);
    const r = random(53);
    // fine, straight grain along the neck
    c.globalCompositeOperation = "multiply";
    for (let k = 0; k < 520; k++) {
      const y = r() * 512;
      const a = 0.04 + r() * 0.12;
      c.strokeStyle = `rgba(${170 + r() * 40},${120 + r() * 30},${70 + r() * 20},${a})`;
      c.lineWidth = 0.6 + r() * 2.2;
      c.beginPath();
      const ph = r() * 6.3;
      for (let x = 0; x <= 1024; x += 16) {
        const yy = y + 1.5 * Math.sin(x / 170 + ph) + 0.6 * Math.sin(x / 41 + ph * 2);
        if (x === 0) c.moveTo(x, yy);
        else c.lineTo(x, yy);
      }
      c.stroke();
    }
    // a few darker mineral streaks
    for (let k = 0; k < 10; k++) {
      c.strokeStyle = `rgba(150,105,60,${0.15 + r() * 0.15})`;
      c.lineWidth = 1 + r() * 2;
      const y = r() * 512;
      const x = r() * 900;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + 40 + r() * 120, y + (r() - 0.5) * 3);
      c.stroke();
    }
    c.globalCompositeOperation = "source-over";
    // the headstock decal: gold script outlined in black, model name and patent numbers
    const { x0, x1, z0, z1, h } = MAPLE.head;
    const sx = 1024 / (x1 - x0);
    const sy = h / (z1 - z0);
    c.save();
    c.setTransform(sx, 0, 0, sy, (-x0) * sx, -z0 * sy);
    c.translate(51, 31.5);
    c.rotate(-0.04);
    c.font = "italic bold 15px 'Snell Roundhand', 'Brush Script MT', 'Segoe Script', cursive";
    c.textBaseline = "alphabetic";
    c.lineJoin = "round";
    c.lineWidth = 1.1;
    c.strokeStyle = "#16110c";
    c.strokeText("Fender", 0, 0);
    c.fillStyle = "#c9a24c";
    c.fillText("Fender", 0, 0);
    c.font = "bold 3.1px Helvetica, Arial, sans-serif";
    c.fillStyle = "#16110c";
    c.fillText("STRATOCASTER", 25, 4.4);
    c.font = "1.5px Helvetica, Arial, sans-serif";
    c.fillText("WITH SYNCHRONIZED TREMOLO", 25.4, 6.6);
    c.fillText("PAT. 2,573,254   2,741,146", 4, 6.6);
    c.restore();
  });
}

// Rosewood: four strips of the fretboard, each ending under a fret, with the clay dots.
const ROSE = { cuts: [-1.75, 133.7, 262.7, 375.6, 468] };
function rosewoodTexture(dots) {
  const cuts = ROSE.cuts;
  return canvasTexture(1024, 1024, (c) => {
    c.fillStyle = "#3d2618";
    c.fillRect(0, 0, 1024, 1024);
    const r = random(97);
    const lines = [];
    for (let k = 0; k < 170; k++) lines.push({ v: -32 + r() * 64, a: 0.2 + r() * 1.6, len: 50 + r() * 220, ph: r() * 6.3, w: 0.15 + r() * 0.9, dark: r() < 0.7, alpha: 0.18 + r() * 0.45 });
    const pores = [];
    for (let k = 0; k < 5200; k++) pores.push([cuts[0] + r() * (cuts[4] - cuts[0]), -31 + r() * 62, 0.4 + r() * 1.4, r()]);
    for (let j = 0; j < 4; j++) {
      const a = cuts[j];
      const b = cuts[j + 1];
      const kx = 1024 / (b - a);
      const ky = 256 / 64;
      const X = (u) => (u - a) * kx;
      const Y = (v) => 256 * j + (v + 32) * ky;
      c.save();
      c.beginPath();
      c.rect(0, 256 * j, 1024, 256);
      c.clip();
      for (const l of lines) {
        c.strokeStyle = l.dark ? `rgba(18,9,5,${l.alpha})` : `rgba(110,70,42,${l.alpha * 0.6})`;
        c.lineWidth = l.w * ky;
        c.beginPath();
        for (let x = 0; x <= 1024; x += 12) {
          const u = a + x / kx;
          const y = Y(l.v + l.a * Math.sin((u / l.len) * 6.28 + l.ph));
          if (x === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
      }
      for (const [u, v, len, t] of pores) {
        if (u < a - 2 || u > b + 2) continue;
        c.fillStyle = t < 0.8 ? "rgba(12,6,3,0.55)" : "rgba(120,80,50,0.35)";
        c.fillRect(X(u), Y(v), len * kx, 0.22 * ky);
      }
      for (const [u, v] of dots) {
        if (u < a || u > b) continue;
        const g = c.createRadialGradient(X(u), Y(v), 0, X(u), Y(v), 3.2 * ky);
        g.addColorStop(0, "#efe7d2");
        g.addColorStop(0.8, "#e2d6b8");
        g.addColorStop(0.93, "#b8a988");
        g.addColorStop(1, "rgba(60,40,25,1)");
        c.fillStyle = g;
        c.beginPath();
        c.ellipse(X(u), Y(v), 3.2 * kx, 3.2 * ky, 0, 0, 6.3);
        c.fill();
      }
      c.restore();
    }
  });
}

function guitar() {
  const T = 44.5; // body thickness
  const TOP = T + 2.3; // top of the pickguard
  const YM = 47; // top of the maple neck, and the headstock face
  const R = 241.3; // 9.5" fretboard radius
  const SCALE = 648; // 25.5" scale
  const g = new THREE.Group();
  const K = 0.93;
  g.scale.setScalar(K / 1000);
  g.position.x = -0.2035 + (786.1 * K) / 1000;
  const rnd = random(11);

  // geometry is gathered per material and merged: one draw call each
  const parts = { body: [], plastic: [], metal: [], satin: [], maple: [], rosewood: [], plain: [], wound: [] };
  const put = (key, geo, color = 0xd3d4d7) => {
    if (!geo.index) geo.setIndex([...Array(geo.attributes.position.count).keys()]);
    for (const name of Object.keys(geo.attributes)) if (!["position", "normal", "uv"].includes(name)) geo.deleteAttribute(name);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const count = geo.attributes.position.count;
    if (!geo.attributes.uv) geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    if (key === "metal" || key === "satin") {
      const col = new THREE.Color(color);
      const a = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) a.set([col.r, col.g, col.b], 3 * i);
      geo.setAttribute("color", new THREE.BufferAttribute(a, 3));
    }
    geo.clearGroups();
    parts[key].push(geo);
    return geo;
  };
  const setUV = (geo, fn) => {
    const p = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, ...fn(p.getX(i), p.getY(i), p.getZ(i), nrm.getY(i), uv.getX(i), uv.getY(i)));
    return geo;
  };
  const moved = (geo, x, y, z, ry = 0, rx = 0, rz = 0) =>
    geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, "YXZ")), new THREE.Vector3(1, 1, 1)));
  const turned = (profile, seg) => new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  const along = (geo, a, b) => {
    // stand a +y geometry on point a, pointing at b
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    return geo.translate(a.x, a.y, a.z);
  };
  const rodG = (a, b, r, seg = 6) => along(new THREE.CylinderGeometry(r, r, a.distanceTo(b), seg, 1, true).translate(0, a.distanceTo(b) / 2, 0), a, b);
  const P = (u, y, v) => new THREE.Vector3(-u, y, v);
  // an oval-head screw with a cross slot
  const screw = (u, v, y, r = 2.9, color) => {
    const ang = rnd() * Math.PI;
    put("metal", moved(turned([[0, 0], [r, 0], [r * 0.95, 0.4], [r * 0.75, 0.9], [r * 0.4, 1.2], [0, 1.28]], 9), -u, y, v), color);
    for (const a of [ang, ang + Math.PI / 2]) put("metal", moved(new THREE.BoxGeometry(r * 1.25, 0.5, 0.55), -u, y + 1.12, v, a), 0x1c1c1c);
  };

  // --- strings: where they run (needed by the body, the bridge and the headstock) ---
  const boardHalf = (u) => (42.8 + 0.0299 * Math.max(0, u)) / 2;
  const sag = (x) => R - Math.sqrt(R * R - x * x);
  const boardTop = (u, v) => YM + 5 + sag(boardHalf(u)) - sag(v);
  const posts = [];
  for (let i = 0; i < STRAT.posts.length; i += 2) posts.push([STRAT.posts[i], STRAT.posts[i + 1]]);
  // slightly thicker than real for the plain strings, so they do not break up into dashes
  const strings = [0.6, 0.5, 0.4, 0.31, 0.28, 0.26].map((r, k) => {
    const vn = -17.5 + 7 * k;
    const vb = -26.25 + 10.5 * k;
    const us = SCALE + [3.6, 2.6, 1.9, 3.0, 1.4, 0][k];
    const action = 2.4 - 0.08 * k;
    const yn = boardTop(0, vn) + 1.15 + 0.55;
    const v12 = vn + ((vb - vn) * 324) / us;
    const y12 = boardTop(324, v12) + 1.15 + action;
    const ys = yn + ((y12 - yn) * us) / 324;
    const vAt = (u) => vn + ((vb - vn) * u) / us;
    const yAt = (u) => yn + ((ys - yn) * u) / us;
    return { r, k, vn, vb, us, yn, ys, vAt, yAt, wound: k < 3, v: vn };
  });
  const stringY = (u) => strings.reduce((s, t) => s + t.yAt(u), 0) / 6;

  // --- body: alder under a sunburst and a thick gloss coat -------------------------
  const bodyLine = stratPoints(STRAT.body);
  const burst = sunburstTexture(bodyLine);
  const { u0: bu0, u1: bu1, v0: bv0, v1: bv1 } = BURST;
  const burstUV = (x, z) => [(bu1 + x) / (bu1 - bu0), 1 - (z - bv0) / (bv1 - bv0)];
  const smooth = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  // the forearm contour: a long, shallow slope on the bass side of the lower bout
  const contour = (u, v) => smooth(-95, -128, v) * smooth(560, 640, u) * (1 - smooth(705, 772, u));
  const bodyProfile = (x, z) => {
    const c = contour(-x, z);
    const W = 8 + 50 * c;
    const H = 8 + 6 * c;
    const p = [];
    for (let k = 0; k <= 6; k++) {
      const a = ((k / 6) * Math.PI) / 2;
      p.push([W * (1 - Math.sin(a)), T - H * (1 - Math.cos(a))]);
    }
    for (let k = 0; k <= 3; k++) {
      const a = ((k / 3) * Math.PI) / 2;
      p.push([8 * (1 - Math.cos(a)), 8 - 8 * Math.sin(a)]);
    }
    return p;
  };
  const jackLine = stratPoints(STRAT.jack);
  const jackHole = insetPolygon(jackLine, 2.5);
  put(
    "body",
    edgedSlab(
      bodyLine,
      bodyProfile,
      (x, y, z, ring, nx, nz) => {
        // the sides take the darkest colour, just outside the outline
        const out = ring >= 6 ? 10 : 0;
        return burstUV(x - nx * out, z - nz * out);
      },
      { holes: [jackHole], bottom: true }
    )
  );

  // --- pickguard: three-ply, white-black-white, with a bevelled edge ------------------
  const guardLine = stratPoints(STRAT.guard);
  const PG = PLASTIC.guard;
  const guardUV = (x, z) => atlasUV(((PG.u1 + x) / (PG.u1 - PG.u0)) * 1024, ((z - PG.v0) / (PG.v1 - PG.v0)) * PG.h);
  const stripeUV = (y) => atlasUV(PLASTIC.stripe[0] + 128, PLASTIC.stripe[1] + ((TOP - y) / 2.3) * PLASTIC.stripe[3]);
  put(
    "plastic",
    edgedSlab(
      guardLine,
      () => [[1.4, TOP], [1.4, TOP], [0, T + 0.9], [0, T + 0.9], [0, T]],
      (x, y, z, ring) => (ring === 0 ? guardUV(x, z) : stripeUV(y))
    )
  );
  const cell = (rect) => atlasUV(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2);
  const white = cell(PLASTIC.white);

  // --- pickups: three single coils, the bridge one slanted --------------------------
  // the cover's outline: 70.7 x 18.3 mm, its ends almost round
  const coverLine = [];
  for (let k = 0; k < 4; k++)
    for (let s = 0; s <= 6; s++) {
      const a = ((k + s / 6) * Math.PI) / 2;
      coverLine.push([(k === 0 || k === 3 ? 0.55 : -0.55) + 8.6 * Math.cos(a), (k < 2 ? 26.75 : -26.75) + 8.6 * Math.sin(a)]);
    }
  const gapLine = insetPolygon(coverLine, -0.7);
  const guardHoles = [];
  const pickups = [
    [489.9, 0],
    [549.7, 0],
    [605.6, -0.183],
  ];
  for (const [u, ang] of pickups) {
    const h = stringY(u) - 3.6 - TOP;
    const geo = edgedSlab(
      coverLine,
      () => [[7, h], [4.5, h - 0.15], [2.3, h - 0.5], [0.95, h - 1.1], [0.3, h - 1.9], [0, h - 2.8], [0, -0.5]],
      (x, y, z, ring) => (ring <= 2 ? atlasUV(PLASTIC.cover[0] + ((z + 35.35) / 70.7) * PLASTIC.cover[2], PLASTIC.cover[1] + ((x + 9.15) / 18.3) * PLASTIC.cover[3]) : white)
    );
    put("plastic", moved(geo, -u, TOP, 0, ang));
    const rot = new THREE.Matrix4().makeRotationY(ang);
    const hole = gapLine.map(([x, z]) => {
      const p = new THREE.Vector3(x, 0, z).applyMatrix4(rot);
      return [p.x - u, p.z];
    });
    guardHoles.push(hole);
    // six staggered pole pieces, low E to high E
    [0.3, 0.8, 1.4, 1.6, 0.5, 0.3].forEach((s, j) => {
      const p = new THREE.Vector3(0, 0, -26.25 + 10.5 * j).applyMatrix4(rot);
      put("satin", moved(turned([[0, h - 2], [2.4, h - 2], [2.4, h + s - 0.35], [2.05, h + s], [0, h + s + 0.08]], 12), p.x - u, TOP, p.z), 0xc4c3c0);
    });
    // height screws at both ends
    for (const e of [-39.4, 39.4]) {
      const p = new THREE.Vector3(0, 0, e).applyMatrix4(rot);
      screw(u - p.x, p.z, TOP, 2.5);
    }
  }

  // --- knobs: volume, tone, tone ---------------------------------------------------
  const knobAt = [];
  for (let i = 0; i < STRAT.knobs.length; i += 2) knobAt.push([STRAT.knobs[i], STRAT.knobs[i + 1]]);
  knobAt.forEach(([u, v], i) => {
    const geo = turned([[12.0, 0], [12.3, 1.0], [12.2, 3.9], [11.6, 4.7], [10.3, 5.5], [9.9, 6.2], [9.25, 14.6], [9.0, 15.7], [8.4, 16.35], [7.4, 16.6], [0, 16.6]], 48);
    const p = geo.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const y = p.getY(k);
      if (y < 6.1 || y > 14.7) continue;
      // fine ribs round the side
      const f = 1 + 0.028 * Math.cos(24 * Math.atan2(p.getZ(k), p.getX(k)));
      p.setXYZ(k, p.getX(k) * f, y, p.getZ(k) * f);
    }
    geo.computeVertexNormals();
    const top = PLASTIC.knobs[i === 0 ? 0 : 1];
    const spin = rnd() * 0.6 - 0.3;
    setUV(geo, (x, y, z, ny, lu) => {
      if (y > 16.5) {
        const a = Math.atan2(z, x) + spin;
        const rr = Math.hypot(x, z) / 8.6;
        return atlasUV(top[0] + 64 + Math.cos(a) * rr * 60, top[1] + 64 + Math.sin(a) * rr * 60);
      }
      if (y > 0.9 && y < 4.8) return atlasUV(PLASTIC.skirt[0] + lu * PLASTIC.skirt[2], PLASTIC.skirt[1] + ((4.8 - y) / 3.9) * PLASTIC.skirt[3]);
      return white;
    });
    put("plastic", moved(geo, -u, TOP, v));
  });

  // --- five-way switch: tip on a lever in its slot -----------------------------------
  const slot = { u: STRAT.switch[0], v: STRAT.switch[1], du: 0.734, dv: 0.68 };
  {
    const tip = turned([[0, 0], [3.0, 0], [3.25, 4], [3.2, 7.4], [2.7, 9.5], [1.5, 10.5], [0, 10.7]], 16).scale(1, 1, 0.62);
    put("plastic", setUV(moved(tip, -slot.u, TOP + 3, slot.v, Math.atan2(-slot.du, slot.dv)), () => white));
    put("metal", moved(new THREE.BoxGeometry(1.2, 4, 3), -slot.u, TOP + 1, slot.v, Math.atan2(-slot.du, slot.dv)), 0x2a2a2a);
  }
  const plastics = plasticTexture(guardHoles, slot, strings);

  // pickguard screws, and the two holding the switch
  for (let i = 0; i < STRAT.screws.length; i += 2) screw(STRAT.screws[i], STRAT.screws[i + 1], TOP);
  for (const s of [-1, 1]) screw(slot.u + s * 21 * slot.du, slot.v + s * 21 * slot.dv, TOP, 2.4);

  // --- jack: the football-shaped cup on the lower bout -----------------------------
  {
    const flange = edgedSlab(jackLine, () => [[1.0, T + 1.3], [0.35, T + 1.1], [0, T + 0.7], [0, T - 0.6]], () => [0, 0], { holes: [stratPoints(STRAT.jackIn)] });
    put("metal", flange);
    const inner = stratPoints(STRAT.jackIn);
    const c = inner.reduce((s, [x, z]) => [s[0] + x / inner.length, s[1] + z / inner.length], [0, 0]);
    const steps = [
      [1, T + 1.3],
      [0.93, T + 0.4],
      [0.8, T - 3.8],
      [0.62, T - 8],
    ];
    const ringAt = (j, i) => {
      const [s, y] = steps[j];
      const [x, z] = inner[i % inner.length];
      return [c[0] + (x - c[0]) * s, y, c[1] + (z - c[1]) * s];
    };
    put("metal", gridSurface(3, inner.length, ringAt, () => [0, 0], [0, 1, 0]));
    const bottomRing = inner.map((_, i) => ringAt(3, i));
    put("metal", edgedSlab(bottomRing.map(([x, , z]) => [x, z]), () => [[0, T - 8]], () => [0, 0]));
    const ju = STRAT.jackNut[0];
    const jv = STRAT.jackNut[1];
    const base = P(ju, T - 8, jv);
    const axis = P(ju, T - 8 + Math.cos(0.45) * 10, jv + Math.sin(0.45) * 10);
    const seat = (geo, y0, color) => put("metal", along(geo.translate(0, y0, 0), base, axis), color);
    seat(new THREE.CylinderGeometry(6.2, 6.2, 0.7, 20), 0.35);
    seat(new THREE.CylinderGeometry(7.1, 7.1, 2.6, 6), 2.0, 0xcfd0d2);
    seat(new THREE.CylinderGeometry(4.7, 4.7, 2.2, 16), 4.4, 0xc9c9c9);
    seat(new THREE.CylinderGeometry(3.25, 3.25, 0.2, 16), 5.52, 0x050505);
    for (let i = 0; i < STRAT.jackScrews.length; i += 2) screw(STRAT.jackScrews[i], STRAT.jackScrews[i + 1], T + 1.2, 2.3);
  }

  // --- tremolo bridge: plate, six bent-steel saddles, screws, springs and the arm --------
  {
    const plateTop = T + 2.6;
    put("metal", edgedSlab(stratPoints(STRAT.plate), () => [[0.6, plateTop], [0.15, plateTop - 0.35], [0, plateTop - 0.8], [0, T + 0.4]], () => [0, 0]));
    put("metal", moved(new THREE.BoxGeometry(1.3, 6.2, 71), -672.6, plateTop + 2.9, -1.5));
    // the saddle, side view: a strip bent over at the front, the string crossing its crest
    const side = [[3.2, 0], [3.0, 2.5], [2.0, 4.2], [0.6, 5.0], [-0.5, 5.2], [-12, 5.2], [-14, 4.9], [-15.2, 4.0], [-15.8, 2.5], [-16, 0.8], [-14.9, 0.8], [-14.7, 2.3], [-14.2, 3.4], [-13.4, 4.0], [-12, 4.1], [-0.5, 4.1], [1.4, 3.4], [2.0, 2.2], [2.1, 0]];
    const shape = new THREE.Shape(side.map(([x, y]) => new THREE.Vector2(x, y * 1.25)));
    for (const s of strings) {
      const base = s.ys - s.r - 6.5;
      const saddle = new THREE.ExtrudeGeometry(shape, { depth: 10.1, bevelEnabled: false, curveSegments: 1 });
      put("metal", moved(saddle, -s.us, base, s.vb - 5.05));
      // two height screws poking through, the intonation screw and its spring
      for (const e of [-2.6, 2.6]) put("satin", moved(new THREE.CylinderGeometry(1.25, 1.25, base + 7.3 - plateTop, 6), -(s.us + 4.2), (base + 7.3 + plateTop) / 2, s.vb + e), 0xa4a4a2);
      put("metal", rodG(P(s.us + 15.4, base + 2.4, s.vb), P(673.5, base + 1.6, s.vb), 1.15, 6), 0xaeaeae);
      put("satin", rodG(P(s.us + 16.5, base + 2.3, s.vb), P(671.9, base + 1.8, s.vb), 2.05, 7), 0x9a9a98);
      put("metal", moved(turned([[0, 0], [2.2, 0], [2.1, 0.9], [1.2, 1.5], [0, 1.6]], 8), -673.3, base + 1.6, s.vb, 0, 0, Math.PI / 2));
      screw(639.5, s.vb, plateTop - 0.3, 3.3);
    }
    // the arm, swung over the body, with its white tip
    const arm = new THREE.CatmullRomCurve3([P(667.8, plateTop - 1, 36), P(667.8, plateTop + 8, 36), P(665.2, plateTop + 12.5, 37.3), P(654, plateTop + 15.5, 42.5), P(583.5, plateTop + 20.5, 77), P(560.5, plateTop + 22, 80.1)]);
    put("metal", new THREE.TubeGeometry(arm, 40, 2.0, 7));
    const tip = turned([[0, -1], [2.3, -1], [2.6, 0], [3.8, 3], [4.6, 10], [4.8, 25], [4.4, 34], [3.2, 37.5], [0, 38.6]], 14);
    put("plastic", setUV(along(tip, P(560.5, plateTop + 22, 80.1), P(521.8, plateTop + 25, 82.2)), () => white));
  }

  // --- strap buttons, on the horn and at the end ------------------------------------
  for (let i = 0; i < STRAT.straps.length; i += 2) {
    const u = STRAT.straps[i];
    const v = STRAT.straps[i + 1];
    let best = 0;
    bodyLine.forEach(([x, z], k) => {
      if (Math.hypot(-x - u, z - v) < Math.hypot(-bodyLine[best][0] - u, bodyLine[best][1] - v)) best = k;
    });
    const a = bodyLine[(best + bodyLine.length - 1) % bodyLine.length];
    const b = bodyLine[(best + 1) % bodyLine.length];
    let out = new THREE.Vector3(b[1] - a[1], 0, a[0] - b[0]).normalize();
    const [x, z] = bodyLine[best];
    // outward: away from the middle of the body
    if (out.x * (x + 560) + out.z * z < 0) out.negate();
    const base = new THREE.Vector3(x, T / 2, z);
    put("metal", along(turned([[0, -1], [6.4, -1], [6.4, 0.6], [3.4, 0.9], [3.2, 6.4], [5.8, 7.1], [6.5, 8.5], [6.2, 10.1], [4.4, 11.1], [0, 11.4]], 16), base, base.clone().add(out)));
  }

  // --- neck: maple, a rounded C shape, with a rosewood fretboard ------------------------
  const MN = MAPLE.neck;
  const neckStations = [-16, -1.75, 60, 160, 260, 360, 400, 461];
  const neckDepth = (u) => (u < 0 ? 15 + u * 0.05 : u < 380 ? 15 + (1.8 * u) / 324 : 18.9);
  put(
    "maple",
    gridSurface(
      neckStations.length - 1,
      14,
      (i, j) => {
        const u = neckStations[i];
        const a = (Math.PI * j) / 14;
        const c = Math.cos(a);
        const s = Math.sin(a);
        return [-u, YM - neckDepth(u) * Math.pow(s, 0.77), boardHalf(u) * Math.sign(c) * Math.pow(Math.abs(c), 0.77)];
      },
      (i, j) => atlasUV(((neckStations[i] - MN.u0) / (MN.u1 - MN.u0)) * 1024, MN.y + (j / 14) * MN.h, 1024, 512),
      [0, -1, 0]
    )
  );
  // fretboard: radiused top in four strips, square sides, a rounded end at the heel
  const cuts = ROSE.cuts;
  const heelEnd = (v) => 397.3 + Math.sqrt(69.7 * 69.7 - v * v);
  const roseUV = (j, u, v) => atlasUV(((u - cuts[j]) / (cuts[j + 1] - cuts[j])) * 1024, 256 * j + (v + 32) * 4);
  for (let j = 0; j < 4; j++) {
    const a = cuts[j];
    const b = cuts[j + 1];
    const uAt = (i, v) => (j === 3 && i === 2 ? heelEnd(v) : a + ((b - a) * i) / 2);
    const vAt = (i, k) => {
      const half = boardHalf(Math.min(uAt(i, 0), 461));
      return half - (2 * half * k) / 12;
    };
    put(
      "rosewood",
      gridSurface(
        2,
        12,
        (i, k) => {
          const v = vAt(i, k);
          const u = uAt(i, v);
          return [-u, boardTop(u, v), v];
        },
        (i, k) => {
          const v = vAt(i, k);
          return roseUV(j, uAt(i, v), v);
        },
        [0, 1, 0]
      )
    );
    for (const side of [1, -1])
      put(
        "rosewood",
        gridSurface(
          2,
          1,
          (i, k) => {
            const u = j === 3 && i === 2 ? 461 : a + ((b - a) * i) / 2;
            const half = boardHalf(u);
            return [-u, k ? YM + 5 : YM - 0.2, side * half];
          },
          (i) => roseUV(j, j === 3 && i === 2 ? 461 : a + ((b - a) * i) / 2, side * 31),
          [0, 0, side]
        )
      );
  }
  put(
    "rosewood",
    gridSurface(
      12,
      1,
      (i, k) => {
        const half = boardHalf(461);
        const v = half - (2 * half * i) / 12;
        const u = heelEnd(v);
        return [-u, k ? boardTop(u, v) : T + 1, v];
      },
      (i, k) => roseUV(3, 466 - k * 4, 0),
      [-1, 0, 0]
    )
  );
  // frets: nickel crowns following the radius, bevelled at the ends
  for (let f = 1; f <= 21; f++) {
    const u = SCALE * (1 - Math.pow(2, -f / 12));
    const half = boardHalf(u) - 0.25;
    put(
      "metal",
      gridSurface(
        10,
        6,
        (i, j) => {
          const v = half - (2 * half * i) / 10;
          const a = (Math.PI * j) / 6;
          const end = Math.min(1, (half - Math.abs(v)) / 1.2);
          const hgt = 1.1 * (0.25 + 0.75 * Math.sqrt(end));
          return [-(u + 1.1 * Math.cos(a)), boardTop(u, v) - 0.05 + hgt * Math.sin(a), v];
        },
        () => [0, 0],
        [0, 1, 0]
      ),
      0xdcd6ca
    );
  }
  // nut: bone, its top following the radius
  {
    const nut = new THREE.BoxGeometry(3.5, 1, 42.8, 1, 1, 10);
    const p = nut.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const v = p.getZ(k);
      p.setY(k, p.getY(k) > 0 ? boardTop(0, v) + 1.9 : YM);
    }
    const [nx, ny, nw, nh] = PLASTIC.nut;
    setUV(nut, (x, y, z, nrmY) => (nrmY > 0.5 ? atlasUV(nx + ((21.4 - z) / 42.8) * nw, ny + ((x + 1.75) / 3.5) * nh) : atlasUV(nx + 10, ny + nh / 2)));
    put("plastic", nut);
  }

  // --- headstock: the big Strat shape, six tuners in line, one string tree -------------
  const MH = MAPLE.head;
  const headLine = stratPoints(STRAT.head);
  headLine.push([1, 21.4], [1, -21.2]);
  put(
    "maple",
    edgedSlab(
      headLine,
      () => [[1.7, YM], [1.0, YM - 0.25], [0.45, YM - 0.7], [0.1, YM - 1.25], [0, YM - 1.7], [0, YM - 12.4], [0.5, YM - 13.4], [1.6, YM - 14]],
      (x, y, z) => atlasUV(((x - MH.x0) / (MH.x1 - MH.x0)) * 1024, ((z - MH.z0) / (MH.z1 - MH.z0)) * MH.h, 1024, 512),
      { bottom: true }
    )
  );
  const keys = [];
  for (let i = 0; i < STRAT.keys.length; i += 2) keys.push([STRAT.keys[i], STRAT.keys[i + 1]]);
  const lineDir = new THREE.Vector2(posts[5][0] - posts[0][0], posts[5][1] - posts[0][1]).normalize();
  const perp = new THREE.Vector2(lineDir.y, -lineDir.x); // toward the bass edge
  if (perp.y > 0) perp.negate();
  const back = YM - 14;
  posts.forEach(([u, v], k) => {
    // bushing and post, its slot across the top
    put("metal", moved(turned([[0, 0], [4.5, 0], [4.5, 0.45], [3.9, 1.1], [3.3, 1.35], [0, 1.35]], 18), -u, YM, v), 0xd6d2c8);
    put("metal", moved(turned([[0, 0], [3.05, 0], [3.05, 10.9], [2.7, 11.5], [0, 11.7]], 14), -u, YM, v), 0xd6d2c8);
    put("metal", moved(new THREE.BoxGeometry(0.9, 0.6, 6.3), -u, YM + 11.45, v, rnd() * 3), 0x1d1d1d);
    // gear housing under the headstock, the key shaft and an oval button
    const c = new THREE.Vector2(u, v).addScaledVector(lineDir, 2.5).addScaledVector(perp, 2);
    put("metal", moved(new THREE.BoxGeometry(13, 9.5, 17), -c.x, back - 4.75, c.y, Math.atan2(-perp.x, perp.y)), 0xcfcbc1);
    const from = new THREE.Vector2(u, v).addScaledVector(lineDir, 6.4).addScaledVector(perp, 9);
    const [ku, kv] = keys[k];
    const d = new THREE.Vector2(-(ku - from.x), kv - from.y).normalize(); // in x, z
    const yk = back - 4.5;
    put("metal", rodG(P(from.x, yk, from.y), P(ku, yk, kv), 1.6, 8), 0xd6d2c8);
    put("metal", rodG(new THREE.Vector3(-ku - d.x * 7.8, yk, kv - d.y * 7.8), new THREE.Vector3(-ku - d.x * 6, yk, kv - d.y * 6), 2.7, 12), 0xd6d2c8);
    put("metal", moved(new THREE.SphereGeometry(1, 16, 10).scale(6.8, 2.4, 5.4), -ku, yk, kv, Math.atan2(-d.y, d.x)), 0xd6d2c8);
  });
  // butterfly string tree over the B and high E strings
  const [tu, tv] = STRAT.tree;
  put("satin", moved(new THREE.CylinderGeometry(1.9, 1.9, 3.5, 10), -tu, YM + 1.75, tv), 0xd0d0d2);
  put("satin", moved(new THREE.CylinderGeometry(1, 1, 11.5, 8).scale(1.8, 0.45, 1).rotateX(Math.PI / 2), -tu, YM + 3.95, tv), 0xd8d8da);
  screw(tu, tv, YM + 4.2, 1.9);

  // --- strings: saddle -> nut -> (string tree) -> wound round the post -------------------
  strings.forEach((s) => {
    const key = s.wound ? "wound" : "plain";
    const [pu, pv] = posts[s.k];
    const ySaddle = s.ys;
    const wrapTop = YM + [9, 8, 7, 6, 4.6, 4.2][s.k];
    const path = [P(s.us + 13.5, ySaddle - 4, s.vb), P(s.us + 11, ySaddle, s.vb), P(s.us, ySaddle, s.vb), P(0, s.yn, s.vn)];
    if (s.k >= 4) path.push(P(tu, YM + 3.5 - s.r, s.vn + ((pv + 3.05 - s.vn) * tu) / pu));
    path.push(P(pu, wrapTop, pv + 3.05 + s.r));
    for (let i = 0; i < path.length - 1; i++) {
      // normals bent upward: the string shades evenly across its width, so a string a pixel
      // wide stays a continuous line instead of breaking into dashes of highlight
      const geo = rodG(path[i], path[i + 1], s.r, 6);
      const nrm = geo.attributes.normal;
      for (let k = 0; k < nrm.count; k++) nrm.setXYZ(k, ...new THREE.Vector3(nrm.getX(k) * 0.45, nrm.getY(k) * 0.45 + 0.8, nrm.getZ(k) * 0.45).normalize().toArray());
      put(key, geo);
    }
    // two and a bit turns round the post, going down
    const turns = 2.3;
    const pitch = 2 * s.r + 0.15;
    const helix = new THREE.Curve();
    helix.getPoint = (t, target = new THREE.Vector3()) => {
      const a = Math.PI / 2 + t * turns * Math.PI * 2;
      return target.set(-(pu + Math.cos(a) * (3.05 + s.r)), wrapTop - t * turns * pitch, pv + Math.sin(a) * (3.05 + s.r));
    };
    put(key, new THREE.TubeGeometry(helix, 26, s.r, 5));
  });

  // --- materials and the merged meshes -------------------------------------------------------
  const mats = {
    body: new THREE.MeshPhysicalMaterial({ map: burst, roughness: 0.45, specularIntensity: 0.2, clearcoat: 0.6, clearcoatRoughness: 0.06 }),
    plastic: new THREE.MeshPhysicalMaterial({ map: plastics, roughness: 0.36, clearcoat: 0.4, clearcoatRoughness: 0.18 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 0.27 }),
    maple: new THREE.MeshPhysicalMaterial({ map: mapleTexture(), roughness: 0.45, clearcoat: 0.8, clearcoatRoughness: 0.12 }),
    rosewood: new THREE.MeshStandardMaterial({ map: rosewoodTexture(STRAT.dots.reduce((a, x, i) => (i % 2 ? a : [...a, [x, STRAT.dots[i + 1]]]), [])), roughness: 0.62 }),
    satin: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 0.4 }),
    plain: new THREE.MeshStandardMaterial({ color: 0xf0f0ee, metalness: 1, roughness: 0.4 }),
    wound: new THREE.MeshStandardMaterial({ color: 0xcdc2ae, metalness: 1, roughness: 0.48 }),
  };
  for (const [key, list] of Object.entries(parts)) {
    const mesh = new THREE.Mesh(mergeGeometries(list), mats[key]);
    list.forEach((geo) => geo.dispose());
    g.add(mesh);
  }
  shade(g);
  // the strings are far thinner than a shadow-map texel: they would only speckle
  for (const m of g.children) if (m.material === mats.plain || m.material === mats.wound) m.castShadow = m.receiveShadow = false;
  return g;
}

// --- a pillar candle with a live, flickering flame -----------------------------------------------
function glowTexture() {
  return canvasTexture(128, 128, (c) => {
    const grad = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,220,160,1)");
    grad.addColorStop(0.25, "rgba(255,170,80,0.55)");
    grad.addColorStop(1, "rgba(255,120,40,0)");
    c.fillStyle = grad;
    c.fillRect(0, 0, 128, 128);
  });
}

function candle() {
  const g = new THREE.Group();
  g.add(lathe([[0, 0], [0.046, 0], [0.05, 0.004], [0.052, 0.009], [0.049, 0.0095], [0.044, 0.005], [0, 0.004]], new THREE.MeshStandardMaterial({ color: 0x3a332d, roughness: 0.35, metalness: 0.7 }), 64));
  // warm glow through the wax near the flame
  const waxGlow = canvasTexture(4, 256, (c, w, h) => {
    const grad = c.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, "#000");
    grad.addColorStop(0.65, "#000");
    grad.addColorStop(0.92, "#7a3a10");
    grad.addColorStop(1, "#ff9a4a");
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
  });
  const wax = new THREE.MeshStandardMaterial({ color: 0xf0e4c9, roughness: 0.5, emissive: 0xffffff, emissiveMap: waxGlow, emissiveIntensity: 0.6 });
  const body = lathe([[0, 0.004], [0.033, 0.004], [0.0338, 0.03], [0.0334, 0.068], [0.0312, 0.0722], [0.0262, 0.0698], [0.012, 0.0668], [0, 0.0665]], wax, 72);
  // an uneven, melted rim
  const p = body.geometry.attributes.position;
  const r = random(5);
  const bumps = Array.from({ length: 7 }, () => [r() * Math.PI * 2, 0.0015 + r() * 0.003]);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 0.06) continue;
    const a = Math.atan2(p.getZ(i), p.getX(i));
    let dy = 0;
    for (const [ba, bh] of bumps) {
      const d = ((a - ba + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      dy += bh * Math.exp(-d * d * 9);
    }
    p.setY(i, y - dy * ((y - 0.06) / 0.0122));
  }
  body.geometry.computeVertexNormals();
  g.add(body);
  for (let k = 0; k < 4; k++) {
    const drip = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 12, 10), wax);
    const a = r() * Math.PI * 2;
    drip.position.set(Math.cos(a) * 0.0335, 0.06 - r() * 0.012, Math.sin(a) * 0.0335);
    drip.scale.set(0.8, 2.2 + r() * 1.5, 0.8);
    g.add(drip);
  }
  const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.0007, 0.0008, 0.009, 8), new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 1 }));
  wick.position.y = 0.0705;
  wick.rotation.z = 0.12;
  g.add(wick);
  shade(g);

  const flameMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position;
        float h = clamp(p.y / 0.032, 0.0, 1.0);
        p.x += (sin(uTime * 7.1 + p.y * 140.0) * 0.0012 + sin(uTime * 13.7) * 0.0006) * h * h;
        p.z += cos(uTime * 9.3 + p.y * 110.0) * 0.0009 * h * h;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv;
      void main() {
        float v = vUv.y;
        vec3 core = vec3(1.0, 0.93, 0.75);
        vec3 outer = vec3(1.0, 0.5, 0.1);
        vec3 c = mix(outer, core, smoothstep(0.12, 0.45, v) * (1.0 - smoothstep(0.55, 1.0, v)));
        c = mix(vec3(0.25, 0.35, 1.0), c, smoothstep(0.0, 0.2, v));
        float a = smoothstep(0.0, 0.08, v) * (1.0 - smoothstep(0.7, 1.0, v));
        gl_FragColor = vec4(c * 1.4 * a, a);
      }`,
  });
  const flame = lathe([[0, 0], [0.0034, 0.003], [0.0046, 0.0085], [0.0041, 0.0145], [0.0028, 0.0215], [0.0012, 0.0275], [0, 0.032]], flameMat, 24);
  flame.position.y = 0.0712;
  flame.castShadow = flame.receiveShadow = false;
  g.add(flame);
  const glowMap = glowTexture();
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xffb46a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  glow.scale.setScalar(0.06);
  glow.position.y = 0.084;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowMap, color: 0xff8a3a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.22 }));
  halo.scale.setScalar(0.2);
  halo.position.y = 0.08;
  const light = new THREE.PointLight(0xff9a45, 0.07, 1.2, 2);
  light.position.y = 0.085;
  g.add(glow, halo, light);
  return { group: g, flame, glow, halo, light };
}

// A guitar pick.
function pick(color) {
  const s = new THREE.Shape();
  s.moveTo(0, 0.0165);
  s.quadraticCurveTo(0.0085, 0.0145, 0.0128, 0.002);
  s.quadraticCurveTo(0.0145, -0.008, 0, -0.0125);
  s.quadraticCurveTo(-0.0145, -0.008, -0.0128, 0.002);
  s.quadraticCurveTo(-0.0085, 0.0145, 0, 0.0165);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.0006, bevelEnabled: true, bevelThickness: 0.0002, bevelSize: 0.0003, bevelSegments: 2 });
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.0002;
  return shade(m);
}

function place(obj, x, z, yawDeg) {
  const holder = new THREE.Group();
  holder.add(obj);
  holder.position.set(x, 0, z);
  holder.rotation.y = (yawDeg * Math.PI) / 180;
  scene.add(holder);
  return holder;
}

// Props sit in the gaps between consecutive sheets and in the corridor between
// the two rows, so every move passes over something.
place(guitar(), -1.25, 0.0, -3);
place(microphone(), 0.6, -0.025, 8);
scene.add(cable([[0.545, -0.017], [0.48, 0.0], [0.4, 0.04], [0.33, 0.07], [0.3, 0.15], [0.28, 0.25], [0.31, 0.34], [0.29, 0.45], [0.33, 0.6], [0.3, 0.85]]));
place(ashtray(), 0.47, -0.27, 0);
place(openGrinder(), -0.045, -0.215, 0);
place(grinderLid(), -0.055, -0.33, 40);
place(
  herb(40, 13, (r) => {
    const a = r() * Math.PI * 2;
    const rad = 0.036 + r() * 0.03;
    return new THREE.Vector3(Math.cos(a) * rad, 0.0006, Math.sin(a) * rad);
  }),
  -0.045,
  -0.215,
  0
);
place(ps3Controller(), -0.225, 0.245, 78);
const flameLight = candle();
place(flameLight.group, 0.12, -0.005, 0);
place(pick(0xe0702a), 0.24, 0.42, 28);
place(pick(0x1d1d1f), -0.55, 0.055, -50);
const loose = cigarette(0.063, false);
loose.position.y = 0.0039;
place(loose, -0.575, -0.36, 100);

// Photographed props from Poly Haven (CC0), loaded at their real size.
function loadModel(url, setup) {
  gltf.load(url, (g) => {
    const root = shade(g.scene);
    setup(root);
    // rest it on the table
    const box = new THREE.Box3().setFromObject(root);
    root.position.y -= box.min.y;
    scene.add(root);
    renderer.shadowMap.needsUpdate = true;
  });
}
loadModel("assets/models/vintage_lighter/vintage_lighter_1k.gltf", (root) => {
  root.rotation.y = (35 * Math.PI) / 180;
  root.position.set(-0.56, 0, -0.2);
});

// The candle flame flickers; its light breathes with it.
function flicker(t) {
  const f = 1 + 0.1 * Math.sin(t * 13.1) + 0.06 * Math.sin(t * 29.7 + 1.3) + 0.04 * Math.sin(t * 47.3 + 0.4);
  flameLight.flame.material.uniforms.uTime.value = t;
  flameLight.flame.scale.set(1, 1 + 0.07 * Math.sin(t * 17.3), 1);
  flameLight.light.intensity = 0.07 * f;
  flameLight.glow.material.opacity = 0.85 * f;
  flameLight.halo.material.opacity = 0.22 * f;
}

// --- camera ---------------------------------------------------------------------------
const cam = { x: 0, z: 0, d: 2, yaw: 0, tilt: 0 };
const aspect = () => window.innerWidth / window.innerHeight;
const tanV = Math.tan(VFOV / 2);
const fitDistance = (w, h) => Math.max(h / FIT_MARGIN / 2 / tanV, w / FIT_MARGIN / 2 / (tanV * aspect()));
const spanDistance = (span) => Math.max(span / 2 / (tanV * aspect()), (span * 0.6) / 2 / tanV);
const OVERVIEW_X = -0.2;
const overviewDistance = () => Math.min(3.6, spanDistance(2.4));
const focusState = (s) => ({ x: s.x, z: s.z, d: fitDistance(s.w, s.h), yaw: s.rot, tilt: 0 });

// The camera is never perfectly still, like someone holding it: a slow drift of a
// couple of millimetres (more when it is further away), a slight turn and breath.
const up = new THREE.Vector3();
const target = new THREE.Vector3();
function applyCamera(now) {
  const t = now / 1000;
  const k = cam.d / 0.44;
  const x = cam.x + k * (0.0011 * Math.sin(t * 0.31) + 0.0006 * Math.sin(t * 0.83 + 1.2));
  const z = cam.z + k * (0.0011 * Math.sin(t * 0.27 + 0.5) + 0.0005 * Math.sin(t * 0.71 + 2.1));
  const yaw = cam.yaw + 0.0022 * Math.sin(t * 0.23 + 0.3) + 0.001 * Math.sin(t * 0.61);
  const d = cam.d * (1 + 0.0025 * Math.sin(t * 0.19 + 0.8));
  up.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  const back = d * Math.sin(cam.tilt);
  camera.position.set(x - up.x * back, d * Math.cos(cam.tilt), z - up.z * back);
  camera.up.copy(up);
  target.set(x, 0, z);
  camera.lookAt(target);
}

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

let flight = null;
let landed = -1;
let running = false;
const tweens = [];

function tween(obj, key, to, ms, done) {
  for (let k = tweens.length - 1; k >= 0; k--) if (tweens[k].obj === obj && tweens[k].key === key) tweens.splice(k, 1);
  tweens.push({ obj, key, from: obj[key], to, t0: performance.now(), ms, done });
}

function flyTo(i, ms) {
  const s = sheets[i];
  const from = { ...cam };
  const to = s.spread ? spreadPose(s) : focusState(s);
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  // a dolly move low over the table rather than a flight: it only rises a little
  const peak = Math.max(from.d, to.d) * 1.15 + dist * 0.35;
  flight = {
    i,
    from,
    to,
    peak,
    tilt: MAX_TILT * Math.min(1, dist / 0.3),
    t0: performance.now(),
    ms: ms || Math.min(4800, 2600 + dist * 1300),
  };
  depart();
}

// Leaving a sheet: the cover overlay cannot follow the camera, so it fades out;
// a video keeps playing until the camera has landed somewhere else.
function depart() {
  if (landed === -1) return;
  const s = sheets[landed];
  landed = -1;
  if (!s.videoTexture && !s.spread) hideCover();
}

function land(i) {
  landed = i;
  const s = sheets[i];
  const slide = slides[i];
  setShown(slide);
  if (s.videoTexture) {
    s.fade++;
    if (!s.live) {
      s.live = true;
      s.u.uVideo.value = s.videoTexture;
      slide.start();
      slide.onPainted(() => {
        if (landed === i) tween(s.u.uVideoMix, "value", 1, 600);
      });
    } else {
      tween(s.u.uVideoMix, "value", 1, 300);
    }
  } else if (s.spread) {
    // nothing to start: the camera tours the spread while it is here
  } else {
    showCover();
    slide.start();
  }
  // Sheets left behind go back to their finished drawing.
  for (const o of sheets) {
    if (o === s || !o.live) continue;
    const token = ++o.fade;
    tween(o.u.uVideoMix, "value", 0, 900, () => {
      if (o.fade !== token) return;
      o.live = false;
      o.u.uVideo.value = o.poster;
      slides[o.i].stop();
    });
  }
}

const coverEl = document.getElementById("cover");
let coverTimer;
function showCover() {
  clearTimeout(coverTimer);
  coverEl.classList.add("active");
  placeCover();
  requestAnimationFrame(() => coverEl.classList.add("show"));
}
function hideCover() {
  coverEl.classList.remove("show");
  clearTimeout(coverTimer);
  coverTimer = setTimeout(() => coverEl.classList.remove("active"), 400);
}

// Keep the animated cover glued to the printed card: map its 1000px box onto
// the card's projected corners.
const corner = new THREE.Vector3();
function project(s, lx, lz) {
  corner.set(lx, 0, lz).applyAxisAngle(THREE.Object3D.DEFAULT_UP, s.rot);
  corner.set(corner.x + s.x, 0.001, corner.z + s.z).project(camera);
  return [((corner.x + 1) / 2) * window.innerWidth, ((1 - corner.y) / 2) * window.innerHeight];
}
function placeCover() {
  if (!coverEl.classList.contains("active")) return;
  const s = sheets[0];
  const tl = project(s, -s.w / 2, -s.h / 2);
  const tr = project(s, s.w / 2, -s.h / 2);
  const bl = project(s, -s.w / 2, s.h / 2);
  const k = 1 / 1000;
  coverEl.style.transform = `matrix(${(tr[0] - tl[0]) * k}, ${(tr[1] - tl[1]) * k}, ${(bl[0] - tl[0]) * k}, ${(bl[1] - tl[1]) * k}, ${tl[0]}, ${tl[1]})`;
}


// Keep it smooth on any screen: if frames keep taking too long, render at a lower
// resolution.
let perfStart = 0;
let perfFrames = 0;
let slowSamples = 0;
function adaptResolution(now) {
  if (!ready) return;
  if (!perfStart) {
    perfStart = now;
    perfFrames = 0;
    return;
  }
  perfFrames++;
  if (now - perfStart < 1500) return;
  const ms = (now - perfStart) / perfFrames;
  perfStart = now;
  perfFrames = 0;
  slowSamples = ms > 19 ? slowSamples + 1 : 0;
  // the film look is soft anyway, so it may go a little below the screen's pixels
  if (slowSamples >= 2 && ratio > 0.7) {
    slowSamples = 0;
    ratio = Math.max(0.7, ratio - 0.15);
    renderer.setPixelRatio(ratio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
}

let spreadClock = 0;
function frame(now) {
  adaptResolution(now);
  flicker(now / 1000);
  updateSpread(now);
  const dt = spreadClock ? Math.min(0.1, (now - spreadClock) / 1000) : 0;
  spreadClock = now;
  if (!flight && landed !== -1 && sheets[landed].spread) {
    const s = sheets[landed];
    s.time += dt * getSpeed();
    Object.assign(cam, spreadPose(s));
  }
  if (flight) {
    const t = Math.min(1, (now - flight.t0) / flight.ms);
    const e = ease(t);
    const bump = Math.sin(Math.PI * t) ** 2;
    const f = flight.from;
    const to = flight.to;
    cam.x = lerp(f.x, to.x, e);
    cam.z = lerp(f.z, to.z, e);
    cam.yaw = lerp(f.yaw, to.yaw, e);
    cam.d = lerp(f.d, to.d, e) + (flight.peak - lerp(f.d, to.d, 0.5)) * bump;
    cam.tilt = lerp(f.tilt, to.tilt, e) + flight.tilt * bump;
    if (t >= 1) {
      const i = flight.i;
      flight = null;
      land(i);
    }
  }
  applyCamera(now);

  for (let k = tweens.length - 1; k >= 0; k--) {
    const tw = tweens[k];
    const t = Math.min(1, (now - tw.t0) / tw.ms);
    tw.obj[tw.key] = lerp(tw.from, tw.to, t * t * (3 - 2 * t));
    if (t >= 1) {
      tweens.splice(k, 1);
      if (tw.done) tw.done();
    }
  }

  // A sheet shows its exact colours only when the camera sits right on it.
  let focus = 0;
  for (const s of sheets) {
    const fit = fitDistance(s.w, s.h);
    const near = 1 - smooth(fit * 1.01, fit * 1.35, cam.d);
    const centred = 1 - smooth(0.004, 0.05, Math.hypot(cam.x - s.x, cam.z - s.z));
    s.u.uFocus.value = near * centred;
    focus = Math.max(focus, s.u.uFocus.value);
  }
  placeCover();
  renderFilm(now);
}

// Focus follows the point the camera looks at, a beat late, so moves end on a rack
// focus; the depth that stays sharp grows with the distance.
let filmClock = 0;
const focusPoint = new THREE.Vector3();
function renderFilm(now) {
  const dt = filmClock ? Math.min(0.1, (now - filmClock) / 1000) : 0;
  filmClock = now;
  focusPoint.lerp(target, Math.min(1, dt * 3));
  dof.target.copy(focusPoint);
  // looking across the table (the Polaroid tour) the sharp zone is thin, like a macro shot
  dof.cocMaterial.worldFocusRange = cam.tilt > 0.15 ? 0.02 : 0.03 + 0.09 * cam.d;
  composer.render(dt);
}

// One render loop at a time, even when table mode is left and re-entered.
let loopId = 0;
function startLoop() {
  running = true;
  perfStart = 0;
  const id = ++loopId;
  const tick = (now) => {
    if (id !== loopId || !running) return;
    frame(now);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = aspect();
  camera.updateProjectionMatrix();
  if (!flight && landed !== -1) cam.d = fitDistance(sheets[landed].w, sheets[landed].h);
}
window.addEventListener("resize", resize);
resize();

let ready = false;
const whenReady = [];
// Once everything is loaded, compile every shader and upload every texture before
// the first frame that needs them, so the fly-in never stutters.
manager.onLoad = () => {
  renderer.shadowMap.needsUpdate = true;
  scene.traverse((o) => {
    if (!o.material) return;
    for (const m of [].concat(o.material)) {
      for (const key of ["map", "normalMap", "roughnessMap", "aoMap", "alphaMap", "emissiveMap"]) if (m[key]) renderer.initTexture(m[key]);
    }
  });
  for (const s of sheets) {
    if (s.poster) renderer.initTexture(s.poster);
    if (s.spread) s.spread.forEach((c) => c.frames.forEach((t) => renderer.initTexture(t)));
  }
  const go = () => {
    if (ready) return;
    ready = true;
    whenReady.splice(0).forEach((fn) => fn());
  };
  // ...and wait for the first song's video to be playable too.
  const firstVideo = () => {
    loading(0.9);
    const v = slides[1].el;
    if (v.readyState >= 3) return go();
    v.addEventListener("canplay", go, { once: true });
    setTimeout(go, 10000);
  };
  renderer.compileAsync(scene, camera).then(firstVideo, firstVideo);
};
setTimeout(() => manager.onLoad(), 15000);

// ?debug exposes the camera so a prop can be inspected up close from the console.
if (new URLSearchParams(location.search).has("debug")) window.__table = { cam, scene, renderer };

attachTable({
  // Start rendering; if nothing has been shown yet, begin with a slow fly-in.
  enter(i) {
    // When everything is in, the loading screen fills up and fades into the fly-in.
    const begin = () =>
      finishLoading(() => {
        startLoop();
        if (landed === -1 && !flight) {
          Object.assign(cam, { x: OVERVIEW_X, z: 0.01, d: overviewDistance(), yaw: 0, tilt: 0 });
          flyTo(i, 5200);
        }
      });
    if (ready) begin();
    else whenReady.push(begin);
  },
  jumpTo(i) {
    startLoop();
    flight = null;
    Object.assign(cam, focusState(sheets[i]));
    land(i);
  },
  flyTo,
  // Leave table mode: stop every video and hide the cover overlay.
  release() {
    running = false;
    flight = null;
    landed = -1;
    tweens.length = 0;
    for (const s of sheets) {
      s.fade++;
      s.u.uVideoMix.value = 0;
      s.u.uVideo.value = s.poster;
      if (s.live) slides[s.i].stop();
      s.live = false;
    }
    clearTimeout(coverTimer);
    coverEl.classList.remove("show", "active");
    coverEl.style.transform = "";
  },
});
