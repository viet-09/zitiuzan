import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  DirectionalLight,
  Euler,
  Group,
  HemisphereLight,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_URLS = Object.freeze({
  fox: './assets/pets/fox-mascot.glb',
  rabbit: './assets/pets/rabbit-mascot.glb',
});

const REACTION_DURATION = Object.freeze({
  pat: 0.76,
  tease: 0.78,
  highfive: 0.82,
  complete: 1.34,
  'tier-up': 1.46,
});

function normalizedPetType(value) {
  return value === 'rabbit' ? 'rabbit' : 'fox';
}

function smoothingAlpha(rate, delta) {
  return 1 - Math.exp(-rate * delta);
}

function disposeObject(root) {
  const geometries = new Set();
  const materials = new Set();
  root?.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    list.filter(Boolean).forEach((item) => materials.add(item));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function fitModel(model, targetHeight = 3.15) {
  const initial = new Box3().setFromObject(model);
  const size = initial.getSize(new Vector3());
  const scale = targetHeight / Math.max(size.y, 0.001);
  model.scale.setScalar(scale);

  const fitted = new Box3().setFromObject(model);
  const center = fitted.getCenter(new Vector3());
  model.position.x -= center.x;
  model.position.y -= fitted.min.y;
  model.position.z -= center.z;
}

function addLighting(scene) {
  const ambient = new AmbientLight(0xfff0e3, 0.72);
  ambient.name = 'soft ambient fill';
  scene.add(ambient);

  const hemisphere = new HemisphereLight(0xfff7ec, 0x74584e, 1.45);
  hemisphere.name = 'warm sky and ground light';
  scene.add(hemisphere);

  const directional = new DirectionalLight(0xffdfbd, 3.35);
  directional.name = 'soft key light';
  directional.position.set(-3.2, 5.4, 4.6);
  directional.castShadow = true;
  directional.shadow.mapSize.set(512, 512);
  directional.shadow.camera.near = 0.1;
  directional.shadow.camera.far = 14;
  directional.shadow.camera.left = -3;
  directional.shadow.camera.right = 3;
  directional.shadow.camera.top = 4;
  directional.shadow.camera.bottom = -1;
  directional.shadow.bias = -0.00035;
  directional.shadow.normalBias = 0.025;
  directional.shadow.radius = 4;
  scene.add(directional);
  scene.add(directional.target);
  directional.target.position.set(0, 1.35, 0);
}

function setIdlePose(elapsed, targetPosition, targetEuler, targetScale) {
  const breath = Math.sin(elapsed * 1.72);
  const sway = Math.sin(elapsed * 0.94);
  targetPosition.set(sway * 0.018, 0.025 + breath * 0.032, 0);
  targetEuler.set(breath * -0.012, sway * 0.055, sway * -0.018);
  targetScale.set(1 + breath * 0.006, 1 + breath * 0.012, 1 + breath * 0.006);
}

function setReactionPose(reaction, targetPosition, targetEuler, targetScale) {
  const progress = Math.min(1, reaction.elapsed / reaction.duration);
  const envelope = Math.sin(Math.PI * progress);
  const wave = Math.sin(Math.PI * 2 * progress);

  if (reaction.kind === 'pat') {
    targetPosition.set(0.025 * envelope, -0.075 * envelope, 0.12 * envelope);
    targetEuler.set(0.16 * envelope, -0.14 * envelope, -0.045 * envelope);
    targetScale.set(1.025, 1 - 0.035 * envelope, 1.025);
    return progress;
  }
  if (reaction.kind === 'tease') {
    targetPosition.set(wave * 0.13, envelope * 0.04, envelope * 0.2);
    targetEuler.set(-0.05 * envelope, wave * -0.34, wave * 0.075);
    targetScale.setScalar(1 + envelope * 0.025);
    return progress;
  }
  if (reaction.kind === 'highfive') {
    targetPosition.set(-0.035 * envelope, envelope * 0.15, envelope * 0.31);
    targetEuler.set(-0.19 * envelope, -0.2 * envelope, -0.055 * envelope);
    targetScale.setScalar(1 + envelope * 0.045);
    return progress;
  }

  const turnStrength = reaction.kind === 'tier-up' ? 0.62 : 0.42;
  targetPosition.set(0, Math.abs(wave) * 0.23, envelope * 0.24);
  targetEuler.set(-0.12 * envelope, wave * turnStrength, wave * 0.045);
  targetScale.setScalar(1 + envelope * (reaction.kind === 'tier-up' ? 0.06 : 0.04));
  return progress;
}

/**
 * Mount one GLB mascot into a transparent, responsive Three.js canvas.
 * The returned controller never replaces its canvas during interactions.
 */
export function mountPetScene(host, { petType = 'fox', onReady, onError } = {}) {
  if (!(host instanceof HTMLElement)) return null;

  const type = normalizedPetType(petType);
  const canvas = document.createElement('canvas');
  canvas.className = 'pet-webgl-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.petType = type;
  host.replaceChildren(canvas);
  host.dataset.sceneState = 'loading';
  host.dataset.renderer = 'three-webgl';
  host.dataset.motion = 'idle';

  let renderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
  } catch (error) {
    host.dataset.sceneState = 'fallback';
    host.dataset.renderer = 'png-fallback';
    onError?.(error);
    return { react() {}, destroy() { canvas.remove(); } };
  }

  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(28, 1, 0.1, 30);
  camera.position.set(0, 1.58, 7.25);
  camera.lookAt(0, 1.58, 0);
  addLighting(scene);

  const ground = new Group();
  ground.name = 'soft ground shadow';
  // Keep the actual receiver simple and fully transparent except for its shadow.
  const plane = new Mesh(
    new PlaneGeometry(5, 5),
    new ShadowMaterial({ color: 0x3b2924, opacity: 0.19, transparent: true, depthWrite: false }),
  );
  plane.name = 'ground shadow receiver';
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.015;
  plane.receiveShadow = true;
  ground.add(plane);
  scene.add(ground);

  const rig = new Group();
  rig.name = 'pet motion rig';
  scene.add(rig);

  const timer = new Timer();
  timer.connect(document);
  const targetPosition = new Vector3();
  const targetScale = new Vector3(1, 1, 1);
  const targetEuler = new Euler();
  const targetQuaternion = new Quaternion();
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = reducedMotionQuery.matches;
  let reaction = null;
  let model = null;
  let destroyed = false;
  let animationFrame = 0;

  function resize() {
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  function updateMotion(delta, elapsed) {
    if (reducedMotion) {
      targetPosition.set(0, 0, 0);
      targetEuler.set(0, 0, 0);
      targetScale.set(1, 1, 1);
      host.dataset.motion = 'reduced';
    } else if (reaction) {
      reaction.elapsed += delta;
      const progress = setReactionPose(reaction, targetPosition, targetEuler, targetScale);
      if (progress >= 1) {
        reaction = null;
        host.dataset.motion = 'idle';
      }
    } else {
      setIdlePose(elapsed, targetPosition, targetEuler, targetScale);
      host.dataset.motion = 'idle';
    }

    targetQuaternion.setFromEuler(targetEuler);
    const alpha = smoothingAlpha(reaction ? 15 : 8, delta);
    rig.position.lerp(targetPosition, alpha);
    rig.scale.lerp(targetScale, alpha);
    rig.quaternion.slerp(targetQuaternion, alpha);
  }

  function renderFrame(timestamp) {
    if (destroyed) return;
    timer.update(timestamp);
    const delta = Math.min(timer.getDelta(), 0.05);
    updateMotion(delta, timer.getElapsed());
    renderer.render(scene, camera);
    animationFrame = requestAnimationFrame(renderFrame);
  }

  function setReducedMotion(event) {
    reducedMotion = event.matches;
    reaction = null;
    host.dataset.motion = reducedMotion ? 'reduced' : 'idle';
  }

  function contextLost(event) {
    event.preventDefault();
    host.dataset.sceneState = 'fallback';
    host.classList.remove('is-three-ready');
    onError?.(new Error('WebGL context lost'));
  }

  function contextRestored() {
    if (!model || destroyed) return;
    host.dataset.sceneState = 'ready';
    host.classList.add('is-three-ready');
    onReady?.();
  }

  reducedMotionQuery.addEventListener('change', setReducedMotion);
  canvas.addEventListener('webglcontextlost', contextLost);
  canvas.addEventListener('webglcontextrestored', contextRestored);
  animationFrame = requestAnimationFrame(renderFrame);

  new GLTFLoader().load(MODEL_URLS[type], (gltf) => {
    if (destroyed) {
      disposeObject(gltf.scene);
      return;
    }
    model = gltf.scene;
    model.name = `${type} GLB mascot`;
    model.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      object.frustumCulled = false;
    });
    fitModel(model);
    rig.add(model);
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    host.dataset.sceneState = 'ready';
    host.classList.add('is-three-ready');
    onReady?.();
  }, undefined, (error) => {
    if (destroyed) return;
    host.dataset.sceneState = 'fallback';
    host.dataset.renderer = 'png-fallback';
    onError?.(error);
  });

  return {
    react(kind) {
      if (reducedMotion) return;
      const duration = REACTION_DURATION[kind];
      if (!duration) return;
      reaction = { kind, duration, elapsed: 0 };
      host.dataset.motion = kind;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      reducedMotionQuery.removeEventListener('change', setReducedMotion);
      canvas.removeEventListener('webglcontextlost', contextLost);
      canvas.removeEventListener('webglcontextrestored', contextRestored);
      timer.dispose();
      disposeObject(model);
      ground.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
      renderer.dispose();
      canvas.remove();
    },
  };
}
