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
  [0.1, -0.8, -3], // 8-usxnc: the TV at the back of the table, against the wall
];
const SHEET_W = 0.3;
const SHEET_H = 0.225;
const COVER_SIZE = 0.25;
const WOOD_SIZE = 1.55; // metres covered by one tile of the wood photo
// The table runs 5 m across and from the wall (behind the TV) to 2 m in front.
const TABLE_W = 5;
const TABLE_BACK = -1.1;
const TABLE_FRONT = 2;
const WALL_Z = -1.13;
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
const gltf = new GLTFLoader(manager);
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
  t.repeat.set(TABLE_W / WOOD_SIZE, (TABLE_FRONT - TABLE_BACK) / WOOD_SIZE);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const woodArm = tableTexture("assets/table/wood_arm_1k.jpg"); // AO, roughness, metalness
const tableTop = new THREE.Mesh(
  new THREE.PlaneGeometry(TABLE_W, TABLE_FRONT - TABLE_BACK),
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
tableTop.position.z = (TABLE_BACK + TABLE_FRONT) / 2;
tableTop.receiveShadow = true;
scene.add(tableTop);

// --- the wall the table is pushed against: old stained wallpaper (Poly Haven, CC0) ---
// Only seen when the camera looks across the table, at the TV. The desk lamp spills
// onto it from above, and the TV throws its shadow there.
{
  const tex = (url, srgb) => {
    const t = textures.load(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(TABLE_W / 2.5, 2.6 / 2.5); // one tile is 2.5 m of wall
    t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(TABLE_W, 2.6),
    new THREE.MeshStandardMaterial({ map: tex("assets/wall/wallpaper_diff_1k.jpg", true), normalMap: tex("assets/wall/wallpaper_nor_1k.jpg"), color: 0xd6d6c6, roughness: 0.92 })
  );
  wall.position.set(0, 0.8, WALL_Z);
  wall.receiveShadow = true;
  scene.add(wall);
  const spill = new THREE.SpotLight(0xffd8a8, 3, 3, 0.6, 1, 2);
  spill.position.copy(lamp.position);
  spill.target.position.set(0.1, 0.35, WALL_Z);
  spill.castShadow = true;
  spill.shadow.mapSize.set(1024, 1024);
  spill.shadow.camera.near = 0.3;
  spill.shadow.camera.far = 2.5;
  spill.shadow.bias = -0.0004;
  spill.shadow.normalBias = 0.01;
  spill.shadow.radius = 3;
  scene.add(spill, spill.target);
}

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
  return { x: p.x, y: 0, z: p.z, yaw: p.yaw, d: p.frame / 2 / Math.tan(VFOV / 2), tilt: SPREAD.tilt };
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

// "8-usxnc": an old cathode-ray TV standing at the back of the table (Poly Haven's
// Television_01, CC0) with the cat video on its glass. The glass is lit from inside by
// the picture index.html's tvSlide describes: scanlines, darker corners, and the
// switch-off where it collapses into a bright line, then a dot. A faint cool light
// from the screen falls on the table in front of it.
// The glass: where it is in the model's texture (u0, u1, v0, v1) and in the set's own
// space (x0, x1, y0, y1, then the least z of the front). It is 4:3, like the picture,
// which is drawn a little larger, overscanned like on a real set.
const TV_GLASS_UV = [0.03, 0.362, 0.7, 0.96];
const TV_GLASS = [-0.27, 0.14, 0.1, 0.42, 0.16];
const TV_PICTURE = { centre: [-0.0654, 0.2592], half: [0.197, 0.149] };
const TV_AIM = new THREE.Vector3(-0.015, 0.25, 0.2); // what the camera looks at, in the set's own space
const TV_TILT = (82 * Math.PI) / 180; // looking at it from in front, a touch from above
const TV_LIGHT = 0.35;
function television(i) {
  const [x, z, deg] = LAYOUT[i];
  const rot = (deg * Math.PI) / 180;
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  black.needsUpdate = true;
  const u = {
    uVideo: { value: black },
    uVideoMix: { value: 0 },
    uFocus: { value: 0 },
    uCrt: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  const videoTexture = new THREE.VideoTexture(slides[i].video);
  videoTexture.minFilter = THREE.LinearFilter;
  videoTexture.generateMipmaps = false;
  const holder = new THREE.Group();
  holder.position.set(x, 0, z);
  holder.rotation.y = rot;
  scene.add(holder);
  // a spot from the glass out over the table: it lights what is in front of the set but
  // never the glass itself, so it leaves no highlight there
  const light = new THREE.SpotLight(0xc4d6ff, 0, 1.8, 1.05, 1, 2);
  light.position.set(TV_PICTURE.centre[0], TV_PICTURE.centre[1], 0.215);
  light.target.position.set(TV_PICTURE.centre[0], -0.25, 1.0);
  holder.add(light, light.target);
  const [u0, u1, v0, v1] = TV_GLASS_UV;
  const [x0, x1, y0, y1, zMin] = TV_GLASS;
  gltf.load("assets/models/tv/Television_01_1k.gltf", (g) => {
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material.onBeforeCompile = (shader) => {
        shader.uniforms.uTvVideo = u.uVideo;
        shader.uniforms.uCrt = u.uCrt;
        shader.vertexShader = "varying vec3 vTvLocal;\n" + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvTvLocal = position;");
        shader.fragmentShader =
          "uniform sampler2D uTvVideo;\nuniform vec4 uCrt;\nvarying vec3 vTvLocal;\n" +
          "vec3 tvToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }\n" +
          // the picture at a point of the glass (uCrt: sx, sy, glow, dot; see crtShape)
          "vec3 tvPicture(vec2 local) {\n" +
          `\tvec2 q = (local - vec2(${TV_PICTURE.centre[0]}, ${TV_PICTURE.centre[1]})) / vec2(${TV_PICTURE.half[0]}, ${TV_PICTURE.half[1]});\n` +
          "\tq *= 1.0 + 0.03 * dot(q, q);\n" + // a slight bulge, like the tube's
          "\tvec2 p = q / max(uCrt.xy, vec2(1e-4));\n" +
          "\tvec2 edge = (1.0 - abs(p)) / max(fwidth(p), vec2(1e-5));\n" +
          "\tfloat inside = clamp(edge.x, 0.0, 1.0) * clamp(edge.y, 0.0, 1.0) * step(1e-3, uCrt.x);\n" +
          "\tvec3 c = pow(tvToLinear(texture2D(uTvVideo, clamp(p * 0.5 + 0.5, 0.0, 1.0)).rgb), vec3(1.12));\n" +
          // 240 scanlines, evened out where they would be too fine to show
          "\tfloat line = p.y * 120.0;\n" +
          "\tc *= mix(0.72 + 0.28 * cos(line * 6.2832), 0.86, smoothstep(0.2, 0.45, fwidth(line)));\n" +
          "\tc *= 1.15 - 0.4 * dot(q * vec2(0.8, 0.95), q * vec2(0.8, 0.95));\n" +
          // the beam: washed out to white and brighter as the picture collapses
          "\tc = mix(c, vec3(0.85, 0.92, 1.0), uCrt.z) * (1.0 + 4.0 * uCrt.z);\n" +
          "\tvec3 col = c * inside;\n" +
          "\tfloat away = length(max(abs(q) - uCrt.xy, 0.0));\n" +
          "\tcol += vec3(0.6, 0.75, 1.0) * uCrt.z * 0.9 * exp(-away * 28.0) * step(1e-3, uCrt.x);\n" +
          // the last spot of light
          "\tfloat r = length(q * vec2(1.333, 1.0));\n" +
          "\tcol += vec3(0.85, 0.92, 1.0) * uCrt.w * (7.0 * exp(-r * r / 0.0003) + 0.7 * exp(-r * 16.0));\n" +
          "\treturn col;\n}\n" +
          shader.fragmentShader
            .replace(
              "#include <map_fragment>",
              "#include <map_fragment>\n" +
                `\tfloat tvGlass = step(${u0}, vMapUv.x) * step(vMapUv.x, ${u1}) * step(${v0}, vMapUv.y) * step(vMapUv.y, ${v1})` +
                ` * step(${x0}, vTvLocal.x) * step(vTvLocal.x, ${x1}) * step(${y0}, vTvLocal.y) * step(vTvLocal.y, ${y1}) * step(${zMin}, vTvLocal.z);\n` +
                "\tdiffuseColor.rgb *= 1.0 - 0.75 * tvGlass;"
            )
            .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n\tif (tvGlass > 0.5) totalEmissiveRadiance += tvPicture(vTvLocal.xy);");
      };
    });
    holder.add(shade(g.scene));
    renderer.shadowMap.needsUpdate = true;
  });
  // framed close: the screen fills most of the picture, the knobs just in (the set is 0.6 x 0.46 m)
  return { i, tv: true, w: 0.52, h: 0.42, x, z, rot, u, poster: black, videoTexture, light, live: false, fade: 0 };
}

// Camera state looking at the TV.
function tvPose(s) {
  const p = TV_AIM.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, s.rot);
  return { x: s.x + p.x, y: p.y, z: s.z + p.z, yaw: s.rot, tilt: TV_TILT, d: fitDistance(s.w, s.h) };
}

// The picture follows the slide's phase; so does the light it throws.
function updateTv(now) {
  for (const s of sheets) {
    if (!s.tv) continue;
    const c = slides[s.i].crt;
    s.u.uCrt.value.set(c.sx, c.sy, c.glow, c.dot);
    const flicker = 1 + 0.04 * Math.sin(now * 0.031) + 0.03 * Math.sin(now * 0.0127);
    s.light.intensity = TV_LIGHT * flicker * (Math.min(1, c.sx * c.sy) + 0.6 * c.glow + 0.25 * c.dot);
  }
}

const sheets = SETLIST.map((name, i) => {
  if (slides[i].spread) return polaroidSpread(i);
  if (slides[i].tv) return television(i);
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
  // as laid out by "body.table #cover": composition at 12% instead of the printed 25%,
  // a 300px QR, a 12px gap and an 18px label, 3.5% from the bottom
  const lift = 0.13 * 1600;
  const qrSize = 300;
  const labelSize = 18;
  const labelBottom = 1000 - 35;
  const qrTop = labelBottom - labelSize - 12 - qrSize;
  const copy = svg.cloneNode(true);
  copy.setAttribute("width", String(qrSize * k));
  copy.setAttribute("height", String(qrSize * k));
  const base = new Image();
  base.src = "public/cover.png";
  const qr = new Image();
  qr.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy));
  Promise.all([base.decode(), qr.decode()])
    .then(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 1600;
      const g = c.getContext("2d");
      g.fillStyle = "#f5f1e3";
      g.fillRect(0, 0, 1600, 1600);
      g.drawImage(base, 0, -lift, 1600, 1600);
      g.drawImage(qr, (500 - qrSize / 2) * k, qrTop * k, qrSize * k, qrSize * k);
      g.fillStyle = "#1b1107";
      g.font = `600 ${labelSize * k}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "bottom";
      if ("letterSpacing" in g) g.letterSpacing = `${labelSize * 0.14 * k}px`;
      g.fillText("ascolta su spotify", 800, labelBottom * k);
      const tex = new THREE.CanvasTexture(c);
      tex.anisotropy = aniso;
      card.mesh.material.map = tex;
      card.u.uVideo.value = tex;
      card.poster = tex;
    })
    .catch(() => {});
})();

// --- props --------------------------------------------------------------------------
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

// --- the microphone -------------------------------------------------------------------
// A black dynamic vocal mic in the SM58 style, with a female XLR plug, lying on the
// table. It is built along +y in millimetres: 0 is the tail, the head is at the top
// and the plug at negative heights.
const MIC_HANDLE = 115; // tail to grille ring; the handle texture's v runs along it
const MIC_HEAD = 135.5; // centre of the ball grille

// A lathe from a millimetre profile whose v coordinate follows the height (v = y / vLength),
// so a texture keeps its proportions along the body; u goes round from +z towards +x.
function micLathe(points, segments, vLength = 1) {
  const g = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(mm(r), mm(y))), segments);
  const p = g.attributes.position;
  for (let k = 0; k < p.count; k++) g.attributes.uv.setY(k, p.getY(k) / mm(vLength));
  return g;
}

// A slightly flattened ball: an ellipse below the equator down to the rim (radius `rim`
// at `drop` below the centre), a slightly squarer cap above it.
function micBall(R, top, drop, rim, n) {
  const t0 = Math.acos(rim / R);
  const pts = [];
  for (let k = 0; k <= 5; k++) {
    const t = t0 * (1 - k / 5);
    pts.push([R * Math.cos(t), (-drop * Math.sin(t)) / Math.sin(t0)]);
  }
  for (let k = 1; k <= n; k++) {
    const t = ((k / n) * Math.PI) / 2;
    pts.push([k === n ? 0 : R * Math.cos(t) ** 0.95, top * Math.sin(t) ** 0.95]);
  }
  return pts;
}

// Lying down, the mic rests on its grille and on the plug: tilt the axis until the
// lowest points on either side of the balance point both touch the table.
function micRestingPose(profile, balance) {
  const height = (phi, [r, y]) => y * Math.sin(phi) - r * Math.cos(phi);
  const lowest = (phi, head) =>
    profile.filter(([, y]) => (y > balance) === head).reduce((a, p) => (height(phi, p) < height(phi, a) ? p : a));
  let lo = 0;
  let hi = 0.4;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (height(mid, lowest(mid, false)) > height(mid, lowest(mid, true))) lo = mid;
    else hi = mid;
  }
  // where each support touches, along the table (the radius points straight down there)
  const touch = ([r, y]) => mm(y * Math.cos(lo) + r * Math.sin(lo));
  return { tilt: lo, lift: mm(-height(lo, lowest(lo, true))), tail: touch(lowest(lo, false)), head: touch(lowest(lo, true)) };
}

// Fine blotchy grain round mid grey (± amount), for bump and roughness maps.
function micGrain(seed, ru, rv, amount = 50) {
  const r = random(seed);
  const tile = document.createElement("canvas");
  tile.width = tile.height = 128;
  const tg = tile.getContext("2d");
  const img = tg.createImageData(128, 128);
  for (let k = 0; k < img.data.length; k += 4) {
    img.data[k] = img.data[k + 1] = img.data[k + 2] = 128 + (r() - 0.5) * 2 * amount;
    img.data[k + 3] = 255;
  }
  tg.putImageData(img, 0, 0);
  const t = canvasTexture(256, 256, (g) => g.drawImage(tile, 0, 0, 256, 256), false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(ru, rv);
  return t;
}

// Matte black paint for the handle, with a small print along it below the head, on
// the side facing the angle `at` round the axis (it reads from the tail to the head).
function micPrint(at) {
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = "#0a0a0c";
    g.fillRect(0, 0, w, h);
    g.translate(((((at / (Math.PI * 2)) % 1) + 1) % 1) * w, (1 - 84 / MIC_HANDLE) * h);
    g.rotate(-Math.PI / 2);
    g.fillStyle = "#bdbab3";
    g.font = '600 11px "Helvetica Neue", Arial, sans-serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    if ("letterSpacing" in g) g.letterSpacing = "2px";
    g.fillText("DYNAMIC", 0, 0);
  });
}

// The plug's latch: a raised pill-shaped push button on the shell, at angle `at`.
function xlrLatch(at) {
  const s = new THREE.Shape();
  const hw = mm(2.5);
  const hl = mm(5);
  s.absarc(0, hl - hw, hw, 0, Math.PI, false);
  s.absarc(0, -hl + hw, hw, Math.PI, Math.PI * 2, false);
  const g = new THREE.ExtrudeGeometry(s, { depth: mm(0.7), bevelEnabled: true, bevelThickness: mm(0.25), bevelSize: mm(0.3), bevelSegments: 2, curveSegments: 6 });
  g.translate(0, mm(-8.5), mm(9.4));
  g.rotateY(at);
  return g;
}

// Black woven wire mesh for the ball grille, drawn in the shader. The weave lies on a
// cube projected onto the ball (equal-angle cubed sphere), so cells keep about the same
// size everywhere and nothing pinches at the pole. Up close the holes are cut out and
// the foam shows through; once a cell is only a few pixels wide they fill in with the
// averaged colour, as a fine mesh looks from afar, instead of shimmering.
function wireMesh(radius) {
  const cells = 32; // per cube face: about 1.25 mm a cell
  const m = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.36, metalness: 0, envMapIntensity: 0.6 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uCells = { value: cells };
    shader.uniforms.uPitch = { value: ((Math.PI / 2) * radius) / cells };
    const varyings = "varying vec3 vGrP;\nvarying vec3 vGrN;\nvarying vec3 vGrX;\nvarying vec3 vGrY;\nvarying vec3 vGrZ;\n";
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\n" + varyings)
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n\tvGrP = position;\n\tvGrN = objectNormal;\n\tvGrX = normalMatrix[0];\n\tvGrY = normalMatrix[1];\n\tvGrZ = normalMatrix[2];"
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
${varyings}uniform float uCells;
uniform float uPitch;
const float GR_WIRE = 0.15; // wire radius, in cells
const float GR_BEND = 0.14; // how far a wire rises and dips over and under the others
// share of [x - w/2, x + w/2] covered by wires centred on the integers
float grPulse(float x, float w) {
  w = max(w, 1e-3);
  vec2 e = vec2(x - 0.5 * w, x + 0.5 * w);
  vec2 f = fract(e);
  vec2 i = floor(e) * (2.0 * GR_WIRE) + min(f, vec2(GR_WIRE)) + max(f - 1.0 + GR_WIRE, 0.0);
  return (i.y - i.x) / w;
}`
      )
      .replace(
        "#include <alphatest_fragment>",
        `#include <alphatest_fragment>
  // which cube face, and where on its grid (u, v in cells)
  vec3 grD = normalize(vGrP);
  vec3 grA = abs(grD);
  vec3 grF = vec3(0.0, sign(grD.y), 0.0);
  vec3 grU = vec3(1.0, 0.0, 0.0);
  vec3 grV = vec3(0.0, 0.0, 1.0);
  if (grA.x > grA.y && grA.x >= grA.z) { grF = vec3(sign(grD.x), 0.0, 0.0); grU = vec3(0.0, 1.0, 0.0); }
  else if (grA.z > grA.y && grA.z > grA.x) { grF = vec3(0.0, 0.0, sign(grD.z)); grV = vec3(0.0, 1.0, 0.0); }
  float grDF = dot(grD, grF);
  vec2 grG = vec2(atan(dot(grD, grU) / grDF), atan(dot(grD, grV) / grDF)) * (uCells / 1.5707963);
  // pixel footprint in cells, from the position (continuous across the cube's edges)
  float grW = max(length(dFdx(vGrP)), length(dFdy(vGrP))) / uPitch;
  float grCu = grPulse(grG.y, grW);
  float grCv = grPulse(grG.x, grW);
  float grCov = grCu + grCv - grCu * grCv;
  float grFill = smoothstep(0.12, 0.26, grW);
  if (grCov < 0.5 * (1.0 - grFill)) discard;
  // the weave: each wire passes over one crossing wire and under the next
  vec2 grI = floor(grG + 0.5);
  vec2 grS = 1.0 - 2.0 * mod(grI, 2.0);
  vec2 grO = (grG - grI) / GR_WIRE;
  float grHu = grS.y * cos(PI * grG.x);
  float grHv = -grS.x * cos(PI * grG.y);
  bool grOnU = abs(grO.y) < 1.0 && (abs(grO.x) >= 1.0 || grHu >= grHv);
  bool grOnV = !grOnU && abs(grO.x) < 1.0;
  vec2 grT = vec2(0.0);
  float grAO = 1.0;
  if (grOnU) {
    float o = clamp(grO.y, -0.9, 0.9);
    grT = vec2(GR_BEND * PI * grS.y * sin(PI * grG.x), o / sqrt(1.0 - o * o));
    grAO = (0.3 + 0.4 * (0.5 + 0.5 * grHu)) * (0.7 + 0.3 * sqrt(1.0 - o * o));
  } else if (grOnV) {
    float o = clamp(grO.x, -0.9, 0.9);
    grT = vec2(o / sqrt(1.0 - o * o), -GR_BEND * PI * grS.x * sin(PI * grG.y));
    grAO = (0.3 + 0.4 * (0.5 + 0.5 * grHv)) * (0.7 + 0.3 * sqrt(1.0 - o * o));
  }
  float grK = mix(grOnU || grOnV ? 1.0 : 0.0, grCov, grFill);
  grAO = mix(grAO, 0.7, grFill) * mix(0.35, 1.0, grK); // holes stay darker while the filtered pattern still shows
  diffuseColor.rgb = mix(vec3(0.003), diffuseColor.rgb, grK);`
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = mix(0.9, roughnessFactor, grK);")
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
  vec3 grN = normalize(vGrN);
  vec3 grTu = normalize(grU - dot(grU, grN) * grN);
  vec3 grTv = normalize(grV - dot(grV, grN) * grN);
  vec3 grB = mix(grN, normalize(grTu * grT.x + grTv * grT.y + grN), 1.0 - grFill);
  normal = normalize(grB.x * vGrX + grB.y * vGrY + grB.z * vGrZ);`
      )
      .replace("#include <opaque_fragment>", "outgoingLight *= grAO;\n\t#include <opaque_fragment>");
  };
  return m;
}

// A soft contact shadow under the lying mic, darkest where the plug and grille touch.
// Spots are [x, z, rx, rz, opacity] in the mic's frame, in metres.
function micShadow(spots) {
  const L = 0.3;
  const W = 0.08;
  const X0 = -0.1;
  const tex = canvasTexture(256, 64, (g, w, h) => {
    for (const [x, z, rx, rz, a] of spots) {
      g.save();
      g.translate(((x - X0) / L) * w, (z / W + 0.5) * h);
      g.scale((rx / L) * w, (rz / W) * h);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      grad.addColorStop(0, `rgba(0,0,0,${a})`);
      grad.addColorStop(0.45, `rgba(0,0,0,${a * 0.45})`);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(-1, -1, 2, 2);
      g.restore();
    }
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(L, W), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(X0 + L / 2, 0.0003, 0);
  return m;
}

// The mic itself: matte black handle, chrome ring, black ball grille over dark foam,
// and the plug with its latch and strain relief.
function microphone() {
  // [radius, height] profiles, each running towards +y along its outer surface so the
  // lathe faces point outwards; the band's lip closes the gap under the grille
  const HANDLE = [[9.9, 7], [9.9, 0.4], [10.3, 0], [11.2, 0], [11.7, 0.5], [11.85, 1.4], [11.85, 12.4], [11.6, 12.8], [11.6, 13.3], [11.9, 13.7], [12, 24], [12.4, 42], [13.1, 60], [14.1, 74], [15.5, 85], [17.3, 94], [19.4, 101.5], [21.3, 107], [22.4, 110.5], [22.9, 112.6], [22.5, 113.2]];
  const RING = [[22.4, 112.9], [23.25, 113.1], [23.45, 113.6], [23.45, 114.5], [23.25, 115], [22.6, 115.2]];
  const BAND = [[23, 114.9], [23.65, 115.1], [23.85, 115.6], [23.85, 119.6], [23.55, 120.6], [22.9, 121.1], [19.5, 121]];
  const PLUG = [[8.7, -31.6], [9.5, -31.3], [9.85, -30.6], [9.85, -22.6], [9.5, -22.1], [9.5, -21.1], [9.75, -20.6], [9.75, -0.9], [9.45, -0.4], [9.45, 6]];
  const BOOT = [[3.45, -60.4], [4.2, -59.9], [4.75, -57.5], [5.4, -56.6], [5.2, -55.6], [5.95, -54.6], [5.75, -53.5], [6.5, -52.5], [6.25, -51.3], [6.95, -50.3], [6.75, -49.2], [7.4, -45], [8, -40], [8.45, -35], [8.6, -31.5], [8.3, -29]];
  const front = -Math.PI / 3; // the print and the latch face up, a little towards the room
  const paint = new THREE.MeshStandardMaterial({
    map: micPrint(front),
    roughness: 0.68,
    roughnessMap: micGrain(5, 5, 6, 20),
    bumpMap: micGrain(9, 7, 8),
    bumpScale: 0.06,
    envMapIntensity: 0.5,
  });
  const blackMetal = new THREE.MeshStandardMaterial({ color: 0x161618, roughness: 0.3, metalness: 0.85, envMapIntensity: 0.6 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xbdbdc2, roughness: 0.26, metalness: 1, envMapIntensity: 0.9 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.62, envMapIntensity: 0.5 });
  const foamMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 1, bumpMap: micGrain(13, 6, 3), bumpScale: 1, envMapIntensity: 0.5 });

  const body = new THREE.Group();
  body.add(
    new THREE.Mesh(micLathe(HANDLE, 64, MIC_HANDLE), paint),
    new THREE.Mesh(mergeGeometries([micLathe(RING, 64).toNonIndexed(), xlrLatch(front)]), chrome),
    new THREE.Mesh(mergeGeometries([micLathe(BAND, 64), micLathe(PLUG, 48)]), blackMetal),
    new THREE.Mesh(micLathe(BOOT, 40), rubber)
  );
  const ball = micBall(25.6, 24.9, 14.4, 22, 26);
  const grille = new THREE.Mesh(micLathe(ball, 72), wireMesh(mm(25.6)));
  const foam = new THREE.Mesh(micLathe(micBall(23.9, 23.2, 14.8, 20.4, 12), 40), foamMat);
  grille.position.y = foam.position.y = mm(MIC_HEAD);
  body.add(grille, foam);

  const pose = micRestingPose([...HANDLE, ...RING, ...BAND, ...PLUG, ...BOOT, ...ball.map(([r, y]) => [r, y + MIC_HEAD])], 70);
  body.rotation.z = -Math.PI / 2 + pose.tilt;
  body.position.y = pose.lift;

  const group = new THREE.Group();
  group.add(body);
  shade(group);
  grille.castShadow = false; // the foam inside casts the head's shadow
  group.add(
    micShadow([
      [(pose.tail + pose.head) / 2, 0, (pose.head - pose.tail) / 2 + 0.02, 0.017, 0.32],
      [pose.head, 0, 0.026, 0.021, 0.55],
      [pose.tail, 0, 0.013, 0.01, 0.5],
    ])
  );
  return group;
}

// The mic's cable: points are [x, z] on the table, or [x, z, y] where it is lifted.
function cable(points) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, z, y = 0.0034]) => new THREE.Vector3(x, y, z)));
  const m = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 240, 0.0034, 10, false),
    new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.62, envMapIntensity: 0.5 })
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
// The shell is a smooth mesh modelled offline (tools/make_ds3.py -> assets/models/ds3) with a
// height map of its top, used to sit every button and print on the curved plastic. The parts
// that share a material are merged, so the whole pad costs six draw calls.

// Tileable blurred noise in 0..1, for the plastic's micro texture and its smudges.
function tileNoise(size, blur, seed) {
  const r = random(seed);
  const h = Float32Array.from({ length: size * size }, () => r());
  const tmp = new Float32Array(h.length);
  const wrap = (v) => (v + size) % size;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = -blur; k <= blur; k++) s += h[y * size + wrap(x + k)];
        tmp[y * size + x] = s;
      }
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let k = -blur; k <= blur; k++) s += tmp[wrap(y + k) * size + x];
        h[y * size + x] = s;
      }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of h) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return h.map((v) => (v - lo) / (hi - lo));
}

// A tiling texture filled pixel by pixel: fill(x, y) returns [r, g, b] in 0..255.
function pixelTexture(w, h, fill) {
  const t = canvasTexture(
    w,
    h,
    (c) => {
      const img = c.createImageData(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          [img.data[o], img.data[o + 1], img.data[o + 2]] = fill(x, y);
          img.data[o + 3] = 255;
        }
      c.putImageData(img, 0, 0);
    },
    false
  );
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Normal map of a height field given as h(x, y), slopes scaled by strength.
function normalTexture(w, h, height, strength) {
  return pixelTexture(w, h, (x, y) => {
    const nx = (height(x - 1, y) - height(x + 1, y)) * strength;
    const ny = (height(x, y + 1) - height(x, y - 1)) * strength;
    const l = Math.hypot(nx, ny, 1);
    return [128 + (127 * nx) / l, 128 + (127 * ny) / l, 128 + 127 / l];
  });
}

// The cells of the two decal atlases, in pixels of a 512 x 512 canvas.
const PAD_PRINTS = {
  select: [0, 0, 256, 64],
  start: [256, 0, 256, 64],
  name: [0, 64, 512, 64],
  leds: [0, 128, 512, 128],
  logo: [0, 256, 256, 256],
};
const PAD_LEDS = [64, 192, 320, 448]; // centres of the four LED windows in the "leds" cell
const PAD_SYMBOLS = [
  // triangle, circle, cross, square: colour, offset from the cluster centre (mm), outline
  ["#3ad7a5", 0, -12, (c) => { c.moveTo(128, 54); c.lineTo(194, 168); c.lineTo(62, 168); c.closePath(); }],
  ["#ff4f55", 12, 0, (c) => c.arc(128, 128, 61, 0, Math.PI * 2)],
  ["#6f9dff", 0, 12, (c) => { c.moveTo(78, 78); c.lineTo(178, 178); c.moveTo(178, 78); c.lineTo(78, 178); }],
  ["#f585d4", -12, 0, (c) => c.rect(80, 80, 96, 96)],
];

function padPrintTextures() {
  const prints = canvasTexture(512, 512, (c) => {
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillStyle = "rgba(228,228,232,0.95)";
    c.font = "600 36px Helvetica, Arial, sans-serif";
    c.fillText("SELECT", 128, 32);
    c.fillText("START", 384, 32);
    // on the back edge, over the USB port
    c.font = "700 30px Helvetica, Arial, sans-serif";
    c.letterSpacing = "4px";
    c.fillText("DUALSHOCK 3", 256, 82);
    c.font = "600 19px Helvetica, Arial, sans-serif";
    c.letterSpacing = "6px";
    c.fillStyle = "rgba(200,200,206,0.9)";
    c.fillText("SIXAXIS", 256, 113);
    c.letterSpacing = "0px";
    // the four player LEDs on the back edge, numbered on the top; the first one lit
    PAD_LEDS.forEach((x, k) => {
      const y = 128 + 38;
      if (k === 0) {
        const halo = c.createRadialGradient(x, y, 6, x, y, 36);
        halo.addColorStop(0, "rgba(255,70,40,0.5)");
        halo.addColorStop(1, "rgba(255,40,20,0)");
        c.fillStyle = halo;
        c.fillRect(x - 38, y - 38, 76, 76);
      }
      c.fillStyle = k === 0 ? "#ff5236" : "#2b0d0a";
      c.strokeStyle = k === 0 ? "#ffb39f" : "rgba(120,60,55,0.7)";
      c.lineWidth = 3;
      c.lineJoin = "round";
      c.fillRect(x - 26, y - 11, 52, 22);
      c.strokeRect(x - 26, y - 11, 52, 22);
      c.fillStyle = "rgba(225,225,230,0.95)";
      c.font = "600 40px Helvetica, Arial, sans-serif";
      c.fillText(String(k + 1), x, 128 + 96);
    });
    // the PlayStation logo: an upright P standing on an S that lies flat
    c.save();
    c.translate(0, 256);
    c.fillStyle = "#b9bac0";
    c.font = "900 136px 'Arial Black', Arial, sans-serif";
    c.textBaseline = "alphabetic";
    c.save();
    c.translate(108, 176);
    c.transform(0.78, 0, 0, 1.02, 0, 0);
    c.fillText("P", 0, 0);
    c.restore();
    // the S lies in front of the P's foot, edged in black where they cross
    c.save();
    c.translate(122, 200);
    c.transform(1.05, 0, -0.8, 0.38, 0, 0);
    c.strokeStyle = "#000";
    c.lineWidth = 14;
    c.lineJoin = "round";
    c.globalCompositeOperation = "destination-out";
    c.strokeText("S", 0, 0);
    c.globalCompositeOperation = "source-over";
    c.fillText("S", 0, 0);
    c.restore();
    c.restore();
  });
  // only the lit LED glows
  const glow = canvasTexture(128, 128, (c) => {
    c.fillStyle = "#000";
    c.fillRect(0, 0, 128, 128);
    c.scale(0.25, 0.25);
    const x = PAD_LEDS[0];
    const y = 128 + 38;
    const g = c.createRadialGradient(x, y, 4, x, y, 34);
    g.addColorStop(0, "#ff4a2a");
    g.addColorStop(0.4, "#a01806");
    g.addColorStop(1, "#000");
    c.fillStyle = g;
    c.fillRect(x - 36, y - 36, 72, 72);
    c.fillStyle = "#ff6a48";
    c.fillRect(x - 24, y - 9, 48, 18);
  });
  // the face buttons: smoky dark caps with their coloured symbols, one per quarter
  const symbols = canvasTexture(512, 512, (c) => {
    PAD_SYMBOLS.forEach(([color, , , path], k) => {
      c.save();
      c.translate((k % 2) * 256, Math.floor(k / 2) * 256);
      const g = c.createRadialGradient(118, 112, 10, 128, 128, 132);
      g.addColorStop(0, "#0d0d10");
      g.addColorStop(0.7, "#141418");
      g.addColorStop(1, "#202026");
      c.fillStyle = g;
      c.fillRect(0, 0, 256, 256);
      c.strokeStyle = color;
      c.lineWidth = 16;
      c.lineJoin = "round";
      c.lineCap = "round";
      c.shadowColor = color;
      c.shadowBlur = 5;
      c.beginPath();
      path(c);
      c.stroke();
      c.restore();
    });
  });
  return { prints, glow, symbols };
}

// Remap a geometry's 0..1 uvs into a cell [x, y, w, h] of a 512 px atlas.
function atlasCell(geo, [x, y, w, h]) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (x + uv.getX(i) * w) / 512, 1 - (y + h - uv.getY(i) * h) / 512);
  return geo;
}

// Keep position, normal and uv only, unindexed, so parts can be merged.
function mergeable(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  g.clearGroups();
  return g;
}

// Dims the room's reflections on a material by k (three ignores envMapIntensity under
// scene.environment) and applies any further shader edit.
function padShader(material, name, k, edit = () => {}) {
  material.onBeforeCompile = (shader) => {
    edit(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <lights_fragment_maps>",
      `#include <lights_fragment_maps>
      #if defined( RE_IndirectSpecular ) && defined( USE_ENVMAP )
        iblIrradiance *= ${k.toFixed(3)};
        radiance *= ${k.toFixed(3)};
        clearcoatRadiance *= ${k.toFixed(3)};
      #endif`
    );
  };
  material.customProgramCacheKey = () => `ds3-${name}-${k}`;
  return material;
}

function ps3Controller() {
  const group = new THREE.Group();

  // Glossy black ABS: a soft sheen under a clear coat with a faint orange peel and a few smudges.
  const peelHeight = tileNoise(256, 5, 31);
  const peel = normalTexture(256, 256, (x, y) => peelHeight[((y + 256) % 256) * 256 + ((x + 256) % 256)], 5);
  const smudgeHeight = tileNoise(128, 9, 77);
  const smudge = pixelTexture(128, 128, (x, y) => {
    const v = 255 * (0.42 + 0.58 * smudgeHeight[y * 128 + x] ** 1.6);
    return [v, v, v];
  });
  smudge.repeat.set(0.45, 0.45);
  const shellMat = new THREE.MeshPhysicalMaterial({
    color: 0x040405,
    roughness: 0.45,
    specularIntensity: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
    clearcoatRoughnessMap: smudge,
    clearcoatNormalMap: peel,
    clearcoatNormalScale: new THREE.Vector2(0.03, 0.03),
  });
  // The parting line between the two halves, from a height stored with the shell's vertices;
  // the micro texture fades out on steep sides, where its flat uvs would streak.
  padShader(shellMat, "shell", 0.6, (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec4 seam;\nvarying float vSeam;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSeam = (seam.r - 0.5) * 12.0;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vSeam;")
      .replace(
        "#include <clearcoat_normal_fragment_maps>",
        `#include <clearcoat_normal_fragment_maps>
        float padFlat = smoothstep(0.45, 0.85, dot(nonPerturbedNormal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)));
        clearcoatNormal = normalize(mix(nonPerturbedNormal, clearcoatNormal, padFlat));`
      )
      .replace(
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\nmaterial.clearcoatRoughness = mix(max(clearcoatRoughness * 0.75, 0.0525) + geometryRoughness, material.clearcoatRoughness, padFlat);"
      )
      .replace(
        "#include <opaque_fragment>",
        "float seamW = fwidth(vSeam);\noutgoingLight *= 1.0 - 0.7 * (1.0 - smoothstep(0.12, 0.12 + seamW + 0.04, abs(vSeam)));\n#include <opaque_fragment>"
      );
  });
  const keyMat = padShader(new THREE.MeshPhysicalMaterial({ color: 0x09090b, roughness: 0.3, specularIntensity: 0.4, clearcoat: 1, clearcoatRoughness: 0.05 }), "keys", 0.65);
  const { prints, glow, symbols } = padPrintTextures();
  const capMat = padShader(
    new THREE.MeshPhysicalMaterial({ map: symbols, emissiveMap: symbols, emissive: 0xffffff, emissiveIntensity: 0.14, roughness: 0.25, specularIntensity: 0.5, clearcoat: 1, clearcoatRoughness: 0.04 }),
    "caps",
    0.65
  );
  // rubber stick caps: fine ridges round the rim
  const STICK = [[11.6, -1.5], [11.4, 0.2], [10.4, 1.3], [8.2, 2.2], [5.2, 2.8], [3.6, 3.2], [3.5, 6.4], [5, 6.9], [9, 7.1], [10.1, 7.5], [10.45, 8.4], [10.45, 9.7], [10.2, 10.6], [9.6, 11.15], [8.8, 11.3], [8, 11.1], [6.6, 10.55], [4.4, 10.15], [2, 10], [0, 9.98]];
  const ridged = (v) => v > 9.5 / (STICK.length - 1) && v < 14.5 / (STICK.length - 1);
  const knurl = normalTexture(16, 64, (x, y) => (ridged(1 - (y + 0.5) / 64) ? Math.cos((x / 16) * Math.PI * 2) : 0), 0.9);
  knurl.repeat.set(72, 1);
  const rubberMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.62, normalMap: knurl });
  const matteMat = new THREE.MeshStandardMaterial({ color: 0x020202, roughness: 0.9 });
  const printMat = new THREE.MeshStandardMaterial({
    map: prints,
    emissiveMap: glow,
    emissive: 0xffffff,
    emissiveIntensity: 3,
    roughness: 0.45,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

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
    const sg = shell.geometry;
    if (sg.attributes.color) {
      sg.setAttribute("seam", sg.attributes.color);
      sg.deleteAttribute("color");
    }
    // flat uvs from above for the micro texture, one tile every 4 cm
    const sp = sg.attributes.position;
    const suv = new Float32Array(sp.count * 2);
    for (let i = 0; i < sp.count; i++) {
      suv[2 * i] = sp.getX(i) / 0.04;
      suv[2 * i + 1] = sp.getZ(i) / 0.04;
    }
    sg.setAttribute("uv", new THREE.BufferAttribute(suv, 2));
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
    const surface = (x, z) => {
      const e = 0.8;
      const normal = new THREE.Vector3(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
      return { point: new THREE.Vector3(mm(x), mm(heightAt(x, z)), mm(z)), normal };
    };
    // the back face of the shell (mm) at x: where the plan outline is
    const backZ = (x) => {
      let z = info.z0;
      while (heightAt(x, z) < 3 && z < 0) z += 0.5;
      let lo = z - 0.5;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + z) / 2;
        if (heightAt(x, mid) < 3) lo = mid;
        else z = mid;
      }
      return z;
    };

    // Every part is modelled in mm round its own origin and baked into one of these.
    const parts = { keys: [], caps: [], rubber: [], matte: [], prints: [] };
    const upY = new THREE.Vector3(0, 1, 0);
    const toMM = new THREE.Vector3(0.001, 0.001, 0.001);
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    // rigid: stands on the plastic at (x, z), tilted with it
    const put = (bucket, geo, x, z, { lift = 0, spin = 0, tilt = 0 } = {}) => {
      const { point, normal } = surface(x, z);
      const q = new THREE.Quaternion().setFromUnitVectors(upY, normal).multiply(new THREE.Quaternion().setFromEuler(euler.set(tilt, spin, 0)));
      parts[bucket].push(mergeable(geo).applyMatrix4(new THREE.Matrix4().compose(point.addScaledVector(normal, mm(lift)), q, toMM)));
    };
    // flat, in the xz plane: follows the plastic at (x, z)
    const conform = (bucket, geo, x, z, { lift = 0.05, spin = 0 } = {}) => {
      const g = mergeable(geo);
      const pos = g.attributes.position;
      const nor = g.attributes.normal;
      const c = Math.cos(spin);
      const s = Math.sin(spin);
      for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i);
        const lz = pos.getZ(i);
        const { point, normal } = surface(x + lx * c + lz * s, z - lx * s + lz * c);
        point.addScaledVector(normal, mm(lift));
        pos.setXYZ(i, point.x, point.y, point.z);
        nor.setXYZ(i, normal.x, normal.y, normal.z);
      }
      parts[bucket].push(g);
    };
    const raw = (bucket, geo, x, y, z) => parts[bucket].push(mergeable(geo).applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(mm(x), mm(y), mm(z)), new THREE.Quaternion(), toMM)));
    const flat = (geo) => geo.rotateX(-Math.PI / 2);
    const extrude = (shape, depth, bevel, segments = 3) =>
      flat(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelSegments: segments, curveSegments: 4 }));
    const outline = (points) => {
      const s = new THREE.Shape();
      points.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
      s.closePath();
      return s;
    };

    // D-pad: four separate keys in a dish, pointed towards the centre, each with a raised arrow
    const D = [-46, -5];
    const keyShape = (g) => {
      const s = new THREE.Shape();
      s.moveTo(0, -5.6 - 1.414 * g);
      s.lineTo(4.1 + g, -1.5 - 0.414 * g);
      s.lineTo(4.1 + g, 4.6);
      s.quadraticCurveTo(4.1 + g, 6.0 + g, 2.7, 6.1 + g);
      s.quadraticCurveTo(0, 6.35 + g, -2.7, 6.1 + g);
      s.quadraticCurveTo(-4.1 - g, 6.0 + g, -4.1 - g, 4.6);
      s.lineTo(-4.1 - g, -1.5 - 0.414 * g);
      s.closePath();
      return s;
    };
    const arrowGeo = extrude(outline([[0, 4.9], [1.9, 2.1], [-1.9, 2.1]]), 0.22, 0.15, 1).translate(0, 2.33, 0);
    const keyGeo = mergeGeometries([mergeable(extrude(keyShape(0), 1.9, 0.5)), mergeable(arrowGeo)]);
    const keyGap = flat(new THREE.ShapeGeometry(keyShape(0.85), 4));
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const x = D[0] + Math.sin(a) * 8.2;
      const z = D[1] - Math.cos(a) * 8.2;
      put("keys", keyGeo, x, z, { lift: -0.85, spin: -a, tilt: 0.07 });
      conform("matte", keyGap, x, z, { spin: -a, lift: 0.15 });
    }

    // face buttons: smoky caps with the symbols under the gloss, each in its own hole
    const F = [46, -5];
    const capProfile = [[5.25, -1.2], [5.25, 1.9], [5.15, 2.6], [4.8, 3.1], [3.7, 3.45], [1.9, 3.6], [0, 3.62]].map(([r, y]) => new THREE.Vector2(r, y));
    PAD_SYMBOLS.forEach(([, dx, dz], k) => {
      const cap = new THREE.LatheGeometry(capProfile, 32);
      const pos = cap.attributes.position;
      const uv = cap.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, ((k % 2) + 0.5 + pos.getX(i) / 11.2) / 2, (1 - Math.floor(k / 2) + 0.5 - pos.getZ(i) / 11.2) / 2);
      put("caps", cap, F[0] + dx, F[1] + dz, { lift: -0.3 });
      conform("matte", flat(new THREE.CircleGeometry(6.05, 32)), F[0] + dx, F[1] + dz, { lift: 0.08 });
    });

    // analog sticks: concave rubber tops with a ridged rim, on a dome in a hole of the shell
    const stickGeo = new THREE.LatheGeometry(STICK.map(([r, y]) => new THREE.Vector2(r, y)), 44);
    for (const sx of [-1, 1]) {
      put("rubber", stickGeo, sx * 23, 17, { spin: sx * 0.4 });
      conform("matte", flat(new THREE.CircleGeometry(12.4, 40)), sx * 23, 17, { lift: 0.06 });
    }

    // PS button with its logo
    const psGeo = new THREE.LatheGeometry([[5.6, -1.2], [5.6, 0.75], [5.4, 1.2], [4.4, 1.45], [0, 1.55]].map(([r, y]) => new THREE.Vector2(r, y)), 36);
    put("keys", psGeo, 0, 9);
    put("prints", atlasCell(flat(new THREE.CircleGeometry(4.6, 24)), PAD_PRINTS.logo).translate(0, 1.6, 0), 0, 9);
    conform("matte", flat(new THREE.CircleGeometry(6.5, 32)), 0, 9, { lift: 0.06 });

    // SELECT (a small bar) and START (a triangle), labels printed above them
    const selectShape = (g) => outline([[-3.6 - g, -1.7 - g], [3.6 + g, -1.7 - g], [3.6 + g, 1.7 + g], [-3.6 - g, 1.7 + g]]);
    const startShape = (g) => outline([[-3.0 - g, -3.0 - 1.6 * g], [3.7 + 2 * g, 0], [-3.0 - g, 3.0 + 1.6 * g]]);
    for (const [x, shape, cell] of [[-13, selectShape, PAD_PRINTS.select], [13, startShape, PAD_PRINTS.start]]) {
      put("keys", extrude(shape(0), 0.6, 0.45, 2), x, -9, { lift: -0.15 });
      conform("matte", flat(new THREE.ShapeGeometry(shape(0.6))), x, -9, { lift: 0.08 });
      conform("prints", atlasCell(flat(new THREE.PlaneGeometry(12.8, 3.2, 4, 1)), cell), x, -14.2, { lift: 0.06 });
    }

    // player LEDs on the back edge with their numbers; the name and USB port on the back face
    const back = backZ(0);
    conform("prints", atlasCell(flat(new THREE.PlaneGeometry(24, 6, 12, 8)), PAD_PRINTS.leds), 0, back + 4.4, { lift: 0.06 });
    const name = atlasCell(new THREE.PlaneGeometry(26, 3.25, 10, 1), PAD_PRINTS.name).rotateY(Math.PI);
    const np = name.attributes.position;
    for (let i = 0; i < np.count; i++) np.setZ(i, backZ(np.getX(i)) - 0.06 - back);
    raw("prints", name, 0, 16, back);
    raw("matte", new THREE.BoxGeometry(7.4, 3.3, 1.2), 0, 10.6, back + 0.45);

    // L1/R1 and the L2/R2 triggers under them: a rounded section swept along the back edge,
    // sinking into the shell at both ends
    const sweep = (x0, x1, section, steps = 14) => {
      const pos = [];
      const index = [];
      const m = section.length;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x0 + (x1 - x0) * t;
        const z = backZ(x);
        const slope = (backZ(x + 2) - backZ(x - 2)) / 4;
        const l = Math.hypot(slope, 1);
        const end = Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 6)));
        const vc = (section[0][1] + section[m - 1][1]) / 2;
        for (const [u, v] of section) pos.push(mm(x + (slope / l) * u * end), mm(vc + (v - vc) * (0.55 + 0.45 * end)), mm(z - (u * end) / l));
        if (i) for (let j = 0; j < m - 1; j++) {
          const p = (i - 1) * m + j;
          const q = i * m + j;
          index.push(p, p + 1, q + 1, p, q + 1, q);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
      geo.setIndex(index);
      geo.computeVertexNormals();
      parts.keys.push(mergeable(geo));
    };
    const arc = (cu, cv, r, a0, a1, n = 4) => Array.from({ length: n + 1 }, (_, k) => [cu + r * Math.cos(a0 + ((a1 - a0) * k) / n), cv + r * Math.sin(a0 + ((a1 - a0) * k) / n)]);
    const L1 = [[-4, 13.6], ...arc(1.4, 15.8, 2.2, -Math.PI / 2, 0), ...arc(1.4, 17.4, 2.2, 0, Math.PI / 2), [-4, 19.6]];
    const L2 = [[-4, 2.8], ...arc(4.2, 6.6, 3.8, -Math.PI / 2, 0), ...arc(4.6, 9.2, 3.4, 0, Math.PI / 2), [-4, 12.6]];
    for (const s of [-1, 1]) {
      sweep(Math.min(s * 31, s * 64), Math.max(s * 31, s * 64), L1);
      sweep(Math.min(s * 34, s * 61), Math.max(s * 34, s * 61), L2);
    }

    const merged = (bucket, material) => {
      const mesh = new THREE.Mesh(mergeGeometries(parts[bucket]), material);
      group.add(mesh);
      return mesh;
    };
    merged("keys", keyMat);
    merged("caps", capMat);
    merged("rubber", rubberMat);
    const decals = [merged("matte", matteMat), merged("prints", printMat)];
    shade(group);
    for (const m of decals) m.castShadow = false;
    renderer.shadowMap.needsUpdate = true;
  });
  group.scale.setScalar(1.02);
  return group;
}

// --- an electric guitar in the Stratocaster style, lying on its back --------------------------
function guitar() {
  const g = new THREE.Group();
  const nickel = new THREE.MeshStandardMaterial({ color: 0xdedfe2, roughness: 0.22, metalness: 1 });
  const cream = new THREE.MeshPhysicalMaterial({ color: 0xf1ede2, roughness: 0.35, clearcoat: 0.6 });
  const maple = new THREE.MeshPhysicalMaterial({ color: 0xb98a52, roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.25 });
  const rosewood = new THREE.MeshStandardMaterial({ color: 0x3a2216, roughness: 0.6 });
  const shapeOf = (pts) => {
    const v = pts.map(([x, y]) => new THREE.Vector2(mm(x), mm(y)));
    const s = new THREE.Shape();
    s.moveTo(v[0].x, v[0].y);
    s.splineThru([...v.slice(1), v[0]]);
    return s;
  };
  const flat = (shape, depth, bevel, material, y) => {
    const m = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 48 }),
      material
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = y + bevel;
    g.add(m);
    return m;
  };

  // body, three-tone sunburst under a gloss coat
  const sunburst = canvasTexture(1024, 830, (c, w, h) => {
    c.save();
    c.translate(w * 0.47, h * 0.5);
    c.scale(1, h / w);
    const grad = c.createRadialGradient(0, 0, 0, 0, 0, w * 0.52);
    grad.addColorStop(0, "#e7a444");
    grad.addColorStop(0.42, "#c96a1c");
    grad.addColorStop(0.66, "#7a2410");
    grad.addColorStop(0.82, "#260c05");
    grad.addColorStop(1, "#060302");
    c.fillStyle = grad;
    c.fillRect(-w, -w, 2 * w, 2 * w);
    c.restore();
  });
  sunburst.repeat.set(1 / 0.42, 1 / 0.34);
  sunburst.offset.set(0.5, 0.5);
  const bodyTop = new THREE.MeshPhysicalMaterial({ map: sunburst, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 });
  const bodyEdge = new THREE.MeshPhysicalMaterial({ color: 0x080403, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 });
  const body = shapeOf([[-200, 0], [-192, 70], [-160, 125], [-105, 155], [-45, 150], [5, 128], [40, 118], [85, 125], [130, 128], [170, 112], [195, 90], [205, 70], [195, 55], [160, 45], [132, 30], [132, -30], [150, -40], [170, -55], [180, -70], [170, -88], [140, -108], [95, -118], [50, -115], [10, -128], [-40, -150], [-105, -160], [-160, -128], [-192, -72]]);
  const bodyMesh = flat(body, mm(33), mm(6), [bodyTop, bodyEdge], 0);
  const top = mm(45);

  // pickguard, pickups, bridge, knobs
  flat(shapeOf([[-112, -55], [-95, -92], [-40, -104], [30, -96], [95, -70], [138, -36], [148, 0], [138, 36], [95, 58], [30, 72], [-40, 70], [-95, 48], [-116, 10]]), mm(2.4), 0, cream, top);
  const coilShape = new THREE.Shape();
  coilShape.absarc(0, mm(33), mm(9), 0, Math.PI, false);
  coilShape.absarc(0, mm(-33), mm(9), Math.PI, Math.PI * 2, false);
  const strings = [-26.25, -15.75, -5.25, 5.25, 15.75, 26.25];
  for (const [x, angle] of [[65, 0], [4, 0], [-54, -0.14]]) {
    const coil = new THREE.Mesh(new THREE.ExtrudeGeometry(coilShape, { depth: mm(5), bevelEnabled: true, bevelThickness: mm(1.2), bevelSize: mm(1.2), bevelSegments: 3 }), cream);
    coil.rotation.set(-Math.PI / 2, 0, angle);
    coil.position.set(mm(x), top + mm(3.6), 0);
    g.add(coil);
    for (const sy of strings) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(mm(2.3), mm(2.3), mm(1), 16), nickel);
      const yy = sy * 1.05;
      pole.position.set(mm(x) - Math.sin(angle) * mm(yy), top + mm(10.2), -Math.cos(angle) * mm(yy));
      g.add(pole);
    }
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(mm(42), mm(2.5), mm(72)), nickel);
  bridge.position.set(mm(-102), top + mm(3.8), 0);
  g.add(bridge);
  for (const sy of strings) {
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(mm(9), mm(7), mm(9)), nickel);
    saddle.position.set(mm(-95), top + mm(8), -mm(sy));
    g.add(saddle);
  }
  for (const [x, y] of [[-5, -82], [-45, -88], [-85, -84]]) {
    const knob = lathe([[0, 0], [mm(10.5), 0], [mm(10), mm(13)], [mm(8.5), mm(15)], [0, mm(15.5)]], cream, 36);
    knob.position.set(mm(x), top + mm(2.4), -mm(y));
    g.add(knob);
  }
  const jack = lathe([[0, 0], [mm(14), 0], [mm(14), mm(1.5)], [mm(5), mm(1.5)], [mm(5), mm(-4)], [0, mm(-4)]], nickel, 36);
  jack.position.set(mm(-150), top, -mm(-105));
  g.add(jack);

  // neck: maple with a rosewood board, 21 frets, 648 mm scale
  const nut = -95 + 648;
  const neck = shapeOf([[70, -28], [nut, -21], [nut, 21], [70, 28], [62, 0]]);
  flat(neck, mm(17), mm(2), maple, top - mm(16));
  flat(shapeOf([[88, -27.5], [nut, -21], [nut, 21], [88, 27.5]]), mm(4), 0, rosewood, top + mm(3));
  const boardTop = top + mm(7);
  const widthAt = (x) => mm(42 + ((nut - x) / (nut - 88)) * 13.5);
  const fretX = (n) => nut - 648 * (1 - Math.pow(2, -n / 12));
  for (let n = 1; n <= 21; n++) {
    const fret = new THREE.Mesh(new THREE.BoxGeometry(mm(2), mm(1.2), widthAt(fretX(n))), nickel);
    fret.position.set(mm(fretX(n)), boardTop + mm(0.5), 0);
    g.add(fret);
  }
  const dotMat = new THREE.MeshStandardMaterial({ color: 0xefeee8, roughness: 0.4 });
  // single inlays, and a pair at the 12th fret
  for (const [n, side] of [[3, 0], [5, 0], [7, 0], [9, 0], [12, 1], [12, -1], [15, 0], [17, 0], [19, 0], [21, 0]]) {
    const dot = new THREE.Mesh(new THREE.CylinderGeometry(mm(3), mm(3), mm(0.4), 20), dotMat);
    dot.position.set(mm((fretX(n) + fretX(n - 1)) / 2), boardTop + mm(0.1), side * mm(11));
    g.add(dot);
  }
  const nutBone = new THREE.Mesh(new THREE.BoxGeometry(mm(3.5), mm(4), mm(43)), cream);
  nutBone.position.set(mm(nut), boardTop + mm(1), 0);
  g.add(nutBone);

  // headstock with six tuners on one side
  const head = shapeOf([[0, 21], [0, -21], [26, -22], [92, -24], [136, -27], [158, -24], [162, -10], [152, 5], [128, 16], [86, 27], [52, 36], [26, 35], [10, 26]].map(([x, y]) => [x + nut, -y]));
  flat(head, mm(12), mm(1.5), maple, top - mm(14));
  const headTop = top - mm(14) + mm(15);
  const posts = [];
  for (let k = 0; k < 6; k++) {
    const px = nut + 26 + k * 21;
    const py = 21 + k * 1.2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(mm(3.2), mm(3.6), mm(11), 20), nickel);
    post.position.set(mm(px), headTop + mm(5.5), mm(py));
    g.add(post);
    const keyMesh = new THREE.Mesh(new THREE.BoxGeometry(mm(9), mm(4), mm(16)), nickel);
    keyMesh.position.set(mm(px), headTop + mm(2), mm(py + 21));
    g.add(keyMesh);
    posts.push(new THREE.Vector3(mm(px), headTop + mm(9), mm(py)));
  }

  // strings: saddle -> nut -> tuner post
  const stringMat = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.3, metalness: 1 });
  strings.forEach((sy, k) => {
    const r = mm(0.22 + k * 0.08);
    const atSaddle = new THREE.Vector3(mm(-95), top + mm(11.8), -mm(sy));
    const atNut = new THREE.Vector3(mm(nut), boardTop + mm(3.2), -mm(sy * (21 / 26.25) * 0.84));
    g.add(rod(atSaddle, atNut, r, stringMat), rod(atNut, posts[5 - k], r, stringMat));
  });
  bodyMesh.castShadow = true;
  return shade(g);
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
scene.add(cable([[0.5487, -0.0178, 0.0078], [0.5405, -0.0166, 0.007], [0.527, -0.0147, 0.0052], [0.505, -0.0105], [0.48, 0.0], [0.4, 0.04], [0.33, 0.07], [0.3, 0.15], [0.28, 0.25], [0.31, 0.34], [0.29, 0.45], [0.33, 0.6], [0.3, 0.85]]));
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

// A few dandelions picked and left on the table between sheets 0 and 1: three stems
// with their flower heads, cut out of Poly Haven's dandelion_01 scan (CC0) and laid
// on their side. The GLB only carries the geometry; the scan's textures load here.
{
  const tex = (name, srgb) => {
    const t = textures.load(`assets/models/flowers/dandelion_01_${name}_1k.jpg`);
    t.flipY = false; // glTF UVs
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return t;
  };
  const arm = tex("arm");
  const petals = new THREE.MeshStandardMaterial({ map: tex("diff", true), normalMap: tex("nor_gl"), roughnessMap: arm, aoMap: arm, side: THREE.DoubleSide });
  // stem base x, z and the direction the stem points, in degrees
  const lay = [[-0.585, -0.3, 96], [-0.548, -0.27, 78], [-0.61, -0.235, 112]];
  gltf.load("assets/models/flowers/dandelions.glb", (g) => {
    const stems = [];
    g.scene.traverse((o) => o.isMesh && stems.push(o));
    stems.slice(0, lay.length).forEach((o, k) => {
      const [x, z, deg] = lay[k];
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals(); // the GLB has none
      const flower = new THREE.Mesh(o.geometry, petals);
      flower.rotation.z = -Math.PI / 2; // lying down: the stem runs along +x
      flower.updateMatrixWorld(true);
      flower.position.y = -new THREE.Box3().setFromObject(flower).min.y + 0.0004;
      place(shade(flower), x, z, deg);
    });
    renderer.shadowMap.needsUpdate = true;
  });
}

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
// x, z: the point looked at, y: its height (0 = the table top), d: the distance to it,
// yaw: the turn about the vertical, tilt: from straight down (0) towards level.
const cam = { x: 0, y: 0, z: 0, d: 2, yaw: 0, tilt: 0 };
const aspect = () => window.innerWidth / window.innerHeight;
const tanV = Math.tan(VFOV / 2);
const fitDistance = (w, h) => Math.max(h / FIT_MARGIN / 2 / tanV, w / FIT_MARGIN / 2 / (tanV * aspect()));
const spanDistance = (span) => Math.max(span / 2 / (tanV * aspect()), (span * 0.6) / 2 / tanV);
const OVERVIEW_X = -0.2;
const overviewDistance = () => Math.min(3.6, spanDistance(2.4));
const focusState = (s) => ({ x: s.x, y: 0, z: s.z, d: fitDistance(s.w, s.h), yaw: s.rot, tilt: 0 });
const poseFor = (s) => (s.spread ? spreadPose(s) : s.tv ? tvPose(s) : focusState(s));

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
  camera.position.set(x - up.x * back, cam.y + d * Math.cos(cam.tilt), z - up.z * back);
  // looking across rather than down, the top of the picture turns from the far side
  // of the table to the ceiling
  camera.up.set(up.x * Math.cos(cam.tilt), Math.sin(cam.tilt), up.z * Math.cos(cam.tilt));
  target.set(x, cam.y, z);
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
  const to = poseFor(s);
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
  } else if (s.tv) {
    if (!s.live) {
      s.live = true;
      s.u.uVideo.value = s.videoTexture;
      slide.start(); // it switches on
    }
  } else {
    showCover();
    slide.start();
  }
  // Sheets left behind go back to their finished drawing.
  for (const o of sheets) {
    if (o === s || !o.live) continue;
    if (o.tv) {
      // out of sight by now: just switch it off
      o.live = false;
      slides[o.i].stop();
      o.u.uVideo.value = o.poster;
      continue;
    }
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
  updateTv(now);
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
    cam.y = lerp(f.y, to.y, e);
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
    if (s.tv) continue;
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
  // looking across the table (the Polaroid tour) the sharp zone is thin, like a macro shot;
  // facing the TV it takes in the whole set
  dof.cocMaterial.worldFocusRange = cam.tilt > 0.15 ? lerp(0.02, 0.3, smooth(0.5, 1.3, cam.tilt)) : 0.03 + 0.09 * cam.d;
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
  if (!flight && landed !== -1 && !sheets[landed].spread) Object.assign(cam, poseFor(sheets[landed]));
}
window.addEventListener("resize", resize);
resize();

let ready = false;
const whenReady = [];
// Once everything is loaded, compile every shader and upload every texture before
// the first frame that needs them, so the fly-in never stutters.
// Textures go to the GPU one per frame, so the loading screen never freezes.
let preparing = false;
manager.onLoad = async () => {
  if (preparing) return;
  preparing = true;
  renderer.shadowMap.needsUpdate = true;
  const all = new Set();
  scene.traverse((o) => {
    if (!o.material) return;
    for (const m of [].concat(o.material)) {
      for (const key of ["map", "normalMap", "roughnessMap", "aoMap", "alphaMap", "emissiveMap"]) if (m[key]) all.add(m[key]);
    }
  });
  for (const s of sheets) {
    if (s.poster) all.add(s.poster);
    if (s.spread) s.spread.forEach((c) => c.frames.forEach((t) => all.add(t)));
  }
  let done = 0;
  for (const tex of all) {
    renderer.initTexture(tex);
    loading(0.82 + (0.07 * ++done) / all.size);
    await new Promise((r) => requestAnimationFrame(r));
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
          Object.assign(cam, { x: OVERVIEW_X, y: 0, z: 0.01, d: overviewDistance(), yaw: 0, tilt: 0 });
          flyTo(i, 5200);
        }
      });
    if (ready) begin();
    else whenReady.push(begin);
  },
  jumpTo(i) {
    startLoop();
    flight = null;
    Object.assign(cam, poseFor(sheets[i]));
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
