import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'assets', 'pets');
const yAxis = new Vector3(0, 1, 0);
const sphereGeometry = new SphereGeometry(1, 24, 18);

// GLTFExporter uses FileReader in browsers. This small Node adapter keeps the
// exact same exporter path for deterministic binary GLB generation.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = result;
        this.onloadend?.({ target: this });
      });
    }

    readAsDataURL(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = `data:${blob.type};base64,${Buffer.from(result).toString('base64')}`;
        this.onloadend?.({ target: this });
      });
    }
  };
}

function material(name, color, roughness = 0.72, metalness = 0) {
  const value = new MeshStandardMaterial({ color: new Color(color), roughness, metalness });
  value.name = name;
  return value;
}

function mesh(parent, geometry, surface, { name, position, scale = [1, 1, 1], rotation = [0, 0, 0] }) {
  const item = new Mesh(geometry, surface);
  item.name = name;
  item.position.set(...position);
  item.scale.set(...scale);
  item.rotation.set(...rotation);
  item.castShadow = true;
  item.receiveShadow = true;
  parent.add(item);
  return item;
}

function ellipsoid(parent, surface, options) {
  return mesh(parent, sphereGeometry, surface, options);
}

function capsule(parent, surface, options, radius = 0.14, length = 0.45) {
  return mesh(parent, new CapsuleGeometry(radius, length, 8, 16), surface, options);
}

function capsuleBetween(parent, surface, name, start, end, radius) {
  const from = new Vector3(...start);
  const to = new Vector3(...end);
  const direction = to.clone().sub(from);
  const length = Math.max(0.02, direction.length() - radius * 2);
  const item = new Mesh(new CapsuleGeometry(radius, length, 8, 16), surface);
  item.name = name;
  item.position.copy(from).add(to).multiplyScalar(0.5);
  item.quaternion.setFromUnitVectors(yAxis, direction.normalize());
  item.castShadow = true;
  item.receiveShadow = true;
  parent.add(item);
  return item;
}

function addEye(parent, palette, x, y, z, name) {
  ellipsoid(parent, palette.eyeWhite, {
    name: `${name} eye white`, position: [x, y, z], scale: [0.16, 0.205, 0.105], rotation: [-0.06, 0, 0],
  });
  ellipsoid(parent, palette.iris, {
    name: `${name} iris`, position: [x, y - 0.005, z + 0.09], scale: [0.092, 0.13, 0.052],
  });
  ellipsoid(parent, palette.pupil, {
    name: `${name} pupil`, position: [x, y - 0.008, z + 0.127], scale: [0.052, 0.082, 0.032],
  });
  ellipsoid(parent, palette.eyeWhite, {
    name: `${name} eye glint`, position: [x - 0.025, y + 0.052, z + 0.158], scale: [0.022, 0.029, 0.014],
  });
}

function addShoe(parent, palette, x, color, name) {
  ellipsoid(parent, color, {
    name: `${name} shoe`, position: [x, 0.17, 0.12], scale: [0.265, 0.16, 0.39], rotation: [0.04, 0, 0],
  });
  ellipsoid(parent, palette.sole, {
    name: `${name} sole`, position: [x, 0.09, 0.14], scale: [0.28, 0.055, 0.405],
  });
  for (const offset of [-0.06, 0, 0.06]) {
    capsule(parent, palette.lace, {
      name: `${name} lace`, position: [x + offset * 0.22, 0.285, 0.39], scale: [0.34, 0.12, 0.12], rotation: [0, 0, Math.PI / 2],
    }, 0.025, 0.13);
  }
}

function addHoodieDetails(parent, palette, color) {
  ellipsoid(parent, color, {
    name: 'hood', position: [0, 1.72, -0.07], scale: [0.49, 0.28, 0.34], rotation: [0.18, 0, 0],
  });
  ellipsoid(parent, color, {
    name: 'front pocket', position: [0, 1.15, 0.36], scale: [0.33, 0.19, 0.07],
  });
  capsule(parent, palette.lace, {
    name: 'left hoodie cord', position: [-0.105, 1.53, 0.39], scale: [0.45, 1, 0.45], rotation: [0, 0, 0.06],
  }, 0.022, 0.28);
  capsule(parent, palette.lace, {
    name: 'right hoodie cord', position: [0.105, 1.53, 0.39], scale: [0.45, 1, 0.45], rotation: [0, 0, -0.06],
  }, 0.022, 0.28);
  ellipsoid(parent, palette.lace, { name: 'left cord tip', position: [-0.098, 1.36, 0.4], scale: [0.035, 0.045, 0.03] });
  ellipsoid(parent, palette.lace, { name: 'right cord tip', position: [0.098, 1.36, 0.4], scale: [0.035, 0.045, 0.03] });
}

function buildFox() {
  const palette = {
    fur: material('fox fur', '#dc632c', 0.82),
    furDark: material('fox dark fur', '#6f2f20', 0.84),
    cream: material('fox cream fur', '#f3dec5', 0.88),
    hoodie: material('vermillion hoodie', '#c7352f', 0.68),
    hoodieDark: material('hoodie seam', '#94261f', 0.72),
    shorts: material('charcoal shorts', '#30343a', 0.78),
    shoe: material('brown shoe', '#563629', 0.56),
    sole: material('warm sole', '#d9c6ad', 0.76),
    lace: material('warm lace', '#f1e7d9', 0.72),
    eyeWhite: material('eye white', '#fff9ed', 0.28),
    iris: material('amber iris', '#7b3b16', 0.24),
    pupil: material('pupil', '#171311', 0.2),
    nose: material('nose', '#2a211f', 0.3),
    pawPad: material('paw pads', '#49302a', 0.5),
  };

  const mascot = new Group();
  mascot.name = 'FoxMascot';
  mascot.userData.species = 'fox';

  // Tail is behind the body so its warm silhouette reads without hiding controls.
  const tail = new Group();
  tail.name = 'FoxTail';
  ellipsoid(tail, palette.fur, { name: 'tail base', position: [0.5, 1.02, -0.28], scale: [0.34, 0.24, 0.26], rotation: [0, 0, -0.35] });
  ellipsoid(tail, palette.fur, { name: 'tail middle', position: [0.78, 1.12, -0.29], scale: [0.43, 0.3, 0.29], rotation: [0, 0, -0.12] });
  ellipsoid(tail, palette.cream, { name: 'tail tip', position: [1.08, 1.23, -0.27], scale: [0.34, 0.25, 0.25], rotation: [0, 0, 0.2] });
  mascot.add(tail);

  addShoe(mascot, palette, -0.25, palette.shoe, 'left');
  addShoe(mascot, palette, 0.25, palette.shoe, 'right');
  capsule(mascot, palette.fur, { name: 'left leg', position: [-0.24, 0.47, 0], scale: [1, 1, 1] }, 0.13, 0.35);
  capsule(mascot, palette.fur, { name: 'right leg', position: [0.24, 0.47, 0], scale: [1, 1, 1] }, 0.13, 0.35);
  ellipsoid(mascot, palette.shorts, { name: 'shorts waist', position: [0, 0.82, 0], scale: [0.47, 0.27, 0.32] });
  ellipsoid(mascot, palette.shorts, { name: 'left shorts leg', position: [-0.22, 0.7, 0.02], scale: [0.25, 0.25, 0.3] });
  ellipsoid(mascot, palette.shorts, { name: 'right shorts leg', position: [0.22, 0.7, 0.02], scale: [0.25, 0.25, 0.3] });

  ellipsoid(mascot, palette.hoodie, { name: 'hoodie body', position: [0, 1.29, 0], scale: [0.5, 0.63, 0.37] });
  addHoodieDetails(mascot, palette, palette.hoodie);
  capsuleBetween(mascot, palette.hoodie, 'raised upper sleeve', [-0.39, 1.55, 0], [-0.61, 1.78, 0.04], 0.145);
  capsuleBetween(mascot, palette.hoodie, 'raised lower sleeve', [-0.61, 1.78, 0.04], [-0.57, 2.02, 0.11], 0.14);
  ellipsoid(mascot, palette.fur, { name: 'raised paw', position: [-0.56, 2.13, 0.14], scale: [0.16, 0.18, 0.12], rotation: [0.15, 0, -0.2] });
  ellipsoid(mascot, palette.pawPad, { name: 'raised paw pad', position: [-0.56, 2.14, 0.25], scale: [0.075, 0.09, 0.025] });
  capsuleBetween(mascot, palette.hoodie, 'resting sleeve', [0.4, 1.52, 0], [0.48, 1.18, 0.24], 0.15);
  ellipsoid(mascot, palette.fur, { name: 'resting paw', position: [0.45, 1.09, 0.28], scale: [0.15, 0.15, 0.12] });

  ellipsoid(mascot, palette.fur, { name: 'head', position: [0, 2.22, 0.06], scale: [0.69, 0.61, 0.56] });
  mesh(mascot, new ConeGeometry(0.34, 0.78, 4), palette.furDark, {
    name: 'left ear', position: [-0.38, 2.78, 0.01], scale: [0.85, 1, 0.72], rotation: [0.05, 0, 0.05],
  });
  mesh(mascot, new ConeGeometry(0.34, 0.78, 4), palette.furDark, {
    name: 'right ear', position: [0.38, 2.78, 0.01], scale: [0.85, 1, 0.72], rotation: [0.05, 0, -0.05],
  });
  mesh(mascot, new ConeGeometry(0.22, 0.55, 4), palette.cream, {
    name: 'left inner ear', position: [-0.38, 2.75, 0.21], scale: [0.74, 1, 0.45], rotation: [0.05, 0, 0.05],
  });
  mesh(mascot, new ConeGeometry(0.22, 0.55, 4), palette.cream, {
    name: 'right inner ear', position: [0.38, 2.75, 0.21], scale: [0.74, 1, 0.45], rotation: [0.05, 0, -0.05],
  });
  ellipsoid(mascot, palette.cream, { name: 'left cheek', position: [-0.25, 2.08, 0.45], scale: [0.34, 0.22, 0.18] });
  ellipsoid(mascot, palette.cream, { name: 'right cheek', position: [0.25, 2.08, 0.45], scale: [0.34, 0.22, 0.18] });
  addEye(mascot, palette, -0.23, 2.34, 0.49, 'left');
  addEye(mascot, palette, 0.23, 2.34, 0.49, 'right');
  ellipsoid(mascot, palette.nose, { name: 'nose', position: [0, 2.12, 0.68], scale: [0.12, 0.085, 0.075] });
  mesh(mascot, new TorusGeometry(0.11, 0.018, 8, 18, Math.PI), palette.nose, {
    name: 'smile', position: [0, 2.01, 0.65], scale: [1, 0.65, 1], rotation: [0, 0, Math.PI],
  });

  return mascot;
}

function buildRabbit() {
  const palette = {
    fur: material('rabbit fur', '#f4eee8', 0.9),
    blush: material('rabbit blush', '#f2a9b1', 0.78),
    innerEar: material('inner ear', '#e7a1aa', 0.82),
    hoodie: material('lavender hoodie', '#8872c7', 0.7),
    shorts: material('pink shorts', '#dc7f9b', 0.74),
    shoe: material('pink shoe', '#d97a9b', 0.62),
    sole: material('cream sole', '#ece0d5', 0.78),
    lace: material('white lace', '#f7efe8', 0.76),
    eyeWhite: material('eye white', '#fff9f1', 0.26),
    iris: material('violet iris', '#553766', 0.24),
    pupil: material('pupil', '#171218', 0.2),
    nose: material('pink nose', '#c9687d', 0.45),
    pawPad: material('pink paw pads', '#e594a6', 0.62),
  };

  const mascot = new Group();
  mascot.name = 'RabbitMascot';
  mascot.userData.species = 'rabbit';

  ellipsoid(mascot, palette.fur, { name: 'tail', position: [0.48, 1.03, -0.3], scale: [0.23, 0.23, 0.23] });
  addShoe(mascot, palette, -0.25, palette.shoe, 'left');
  addShoe(mascot, palette, 0.25, palette.shoe, 'right');
  capsule(mascot, palette.fur, { name: 'left leg', position: [-0.23, 0.48, 0] }, 0.13, 0.38);
  capsule(mascot, palette.fur, { name: 'right leg', position: [0.23, 0.48, 0] }, 0.13, 0.38);
  ellipsoid(mascot, palette.shorts, { name: 'shorts waist', position: [0, 0.83, 0], scale: [0.46, 0.27, 0.32] });
  ellipsoid(mascot, palette.shorts, { name: 'left shorts leg', position: [-0.22, 0.71, 0.02], scale: [0.25, 0.25, 0.3] });
  ellipsoid(mascot, palette.shorts, { name: 'right shorts leg', position: [0.22, 0.71, 0.02], scale: [0.25, 0.25, 0.3] });

  ellipsoid(mascot, palette.hoodie, { name: 'hoodie body', position: [0, 1.31, 0], scale: [0.5, 0.62, 0.37] });
  addHoodieDetails(mascot, palette, palette.hoodie);
  capsuleBetween(mascot, palette.hoodie, 'raised upper sleeve', [-0.39, 1.56, 0], [-0.62, 1.82, 0.04], 0.145);
  capsuleBetween(mascot, palette.hoodie, 'raised lower sleeve', [-0.62, 1.82, 0.04], [-0.57, 2.07, 0.12], 0.14);
  ellipsoid(mascot, palette.fur, { name: 'raised paw', position: [-0.56, 2.18, 0.15], scale: [0.16, 0.18, 0.12], rotation: [0.15, 0, -0.2] });
  ellipsoid(mascot, palette.pawPad, { name: 'raised paw pad', position: [-0.56, 2.19, 0.26], scale: [0.075, 0.09, 0.025] });
  capsuleBetween(mascot, palette.hoodie, 'resting sleeve', [0.4, 1.54, 0], [0.49, 1.2, 0.23], 0.15);
  ellipsoid(mascot, palette.fur, { name: 'resting paw', position: [0.46, 1.1, 0.27], scale: [0.15, 0.15, 0.12] });

  ellipsoid(mascot, palette.fur, { name: 'head', position: [0, 2.24, 0.06], scale: [0.66, 0.59, 0.55] });
  capsule(mascot, palette.fur, {
    name: 'left ear', position: [-0.26, 2.96, 0], scale: [0.78, 1.1, 0.62], rotation: [0.06, 0, 0.12],
  }, 0.18, 0.78);
  capsule(mascot, palette.fur, {
    name: 'right ear', position: [0.28, 2.98, 0], scale: [0.78, 1.12, 0.62], rotation: [0.06, 0, -0.12],
  }, 0.18, 0.78);
  capsule(mascot, palette.innerEar, {
    name: 'left inner ear', position: [-0.26, 2.98, 0.14], scale: [0.5, 0.9, 0.28], rotation: [0.06, 0, 0.12],
  }, 0.14, 0.7);
  capsule(mascot, palette.innerEar, {
    name: 'right inner ear', position: [0.28, 3, 0.14], scale: [0.5, 0.92, 0.28], rotation: [0.06, 0, -0.12],
  }, 0.14, 0.7);
  addEye(mascot, palette, -0.22, 2.35, 0.49, 'left');
  addEye(mascot, palette, 0.22, 2.35, 0.49, 'right');
  ellipsoid(mascot, palette.blush, { name: 'left blush', position: [-0.42, 2.13, 0.48], scale: [0.13, 0.065, 0.035] });
  ellipsoid(mascot, palette.blush, { name: 'right blush', position: [0.42, 2.13, 0.48], scale: [0.13, 0.065, 0.035] });
  ellipsoid(mascot, palette.fur, { name: 'muzzle', position: [0, 2.08, 0.53], scale: [0.28, 0.18, 0.15] });
  ellipsoid(mascot, palette.nose, { name: 'nose', position: [0, 2.15, 0.68], scale: [0.085, 0.065, 0.055] });
  mesh(mascot, new TorusGeometry(0.1, 0.017, 8, 18, Math.PI), palette.pupil, {
    name: 'smile', position: [0, 2.02, 0.65], scale: [1, 0.65, 1], rotation: [0, 0, Math.PI],
  });

  return mascot;
}

async function writeModel(type, mascot) {
  const scene = new Scene();
  scene.name = `${type} mascot scene`;
  scene.add(mascot);
  const exporter = new GLTFExporter();
  const binary = await exporter.parseAsync(scene, { binary: true, onlyVisible: true });
  const outputPath = path.join(outputDir, `${type}-mascot.glb`);
  fs.writeFileSync(outputPath, Buffer.from(binary));
  console.log(`Built ${path.relative(root, outputPath)} (${binary.byteLength} bytes)`);
}

fs.mkdirSync(outputDir, { recursive: true });
await writeModel('fox', buildFox());
await writeModel('rabbit', buildRabbit());
