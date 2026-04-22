import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Constants ──────────────────────────────────────────────────────────────
const GRID = 8;
const FLOOR_H = 3;
const BASE_SIZE = 10;

const MATS = {
  concrete: {
    label: 'Concrete', color: 0x9a9a9a, emissive: 0x111111,
    albedo: 0.30, thermalMass: 0.9, breathability: 0.1, roughness: 0.75,
    constructCost: 1200, maintainCost: 15
  },
  wood: {
    label: 'Wood', color: 0x8B6914, emissive: 0x0a0800,
    albedo: 0.45, thermalMass: 0.5, breathability: 0.7, roughness: 0.85,
    constructCost: 900, maintainCost: 25
  },
  plaster: {
    label: 'White Plaster', color: 0xe8e0c8, emissive: 0x080806,
    albedo: 0.65, thermalMass: 0.3, breathability: 0.4, roughness: 0.92,
    constructCost: 800, maintainCost: 12
  }
};

// ── App State ──────────────────────────────────────────────────────────────
let buildings = {};
let mode = 'add';
let currentMat = 'concrete';
let currentFloors = 3;
let streetWidth = 6;
let viewMode = 'normal';
let selected = null;

// ── Renderer / Scene / Camera ──────────────────────────────────────────────
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc8d8ec);
scene.fog = new THREE.FogExp2(0xc8d8ec, 0.004);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
camera.position.set(55, 65, 85);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.minDistance = 12;
controls.maxDistance = 160;

// ── Lighting ───────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xd0e0f0, 1.4));

const sun = new THREE.DirectionalLight(0xfff8ee, 2.0);
sun.position.set(45, 90, 35);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 220;
sun.shadow.camera.left = sun.shadow.camera.bottom = -90;
sun.shadow.camera.right = sun.shadow.camera.top = 90;
sun.shadow.bias = -0.0005;
scene.add(sun);

const fill = new THREE.DirectionalLight(0x88aacc, 0.6);
fill.position.set(-35, 25, -45);
scene.add(fill);

// ── Ground ─────────────────────────────────────────────────────────────────
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(250, 250),
  new THREE.MeshLambertMaterial({ color: 0x7ea87e })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Street surface
const streets = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshLambertMaterial({ color: 0xb0b8c4 })
);
streets.rotation.x = -Math.PI / 2;
streets.position.y = 0.01;
streets.receiveShadow = true;
scene.add(streets);

scene.add(new THREE.GridHelper(160, 20, 0x8899aa, 0x99aabb));

// ── Hit plane (raycasting onto ground) ────────────────────────────────────
const hitPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300),
  new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
);
hitPlane.rotation.x = -Math.PI / 2;
scene.add(hitPlane);

// ── Ghost preview ──────────────────────────────────────────────────────────
const ghostMat = new THREE.MeshBasicMaterial({
  color: 0x55cc88, transparent: true, opacity: 0.22, wireframe: false
});
const ghostEdgeMat = new THREE.LineBasicMaterial({ color: 0x55ff99, transparent: true, opacity: 0.6 });
const ghostGroup = new THREE.Group();
scene.add(ghostGroup);
ghostGroup.visible = false;

// ── Raycaster ──────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2(-999, -999);

// ── Grid helpers ───────────────────────────────────────────────────────────
function cellSpacing() { return BASE_SIZE + streetWidth; }

function cellToWorld(cx, cz) {
  const sp = cellSpacing();
  const off = ((GRID - 1) * sp) / 2;
  return new THREE.Vector3(cx * sp - off, 0, cz * sp - off);
}

function worldToCell(wx, wz) {
  const sp = cellSpacing();
  const off = ((GRID - 1) * sp) / 2;
  return {
    cx: Math.round((wx + off) / sp),
    cz: Math.round((wz + off) / sp)
  };
}

function cellKey(cx, cz) { return `${cx},${cz}`; }
function inBounds(cx, cz) { return cx >= 0 && cx < GRID && cz >= 0 && cz < GRID; }

// ── Metrics ────────────────────────────────────────────────────────────────
function computeMetrics(cx, cz, floors, mat) {
  const def = MATS[mat];
  const h = floors * FLOOR_H;
  const hw = h / Math.max(1, streetWidth);

  // Sky View Factor: decreases with taller canyons
  const svf = Math.max(0.05, 1 - 0.55 * Math.min(hw, 2.5));

  // Count occupied neighbours
  let neighbors = 0, nbrH = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const nb = buildings[cellKey(cx + dx, cz + dz)];
      if (nb) { neighbors++; nbrH += nb.floors * FLOOR_H; }
    }
  }
  const density = neighbors / 8;

  // Surface temperature
  const albedoHeat = (1 - def.albedo) * 15;
  const uhiEffect = density * 7 * (1 - def.albedo);
  const svfCool = svf * 4;
  const surfaceTemp = 28 + albedoHeat + uhiEffect - svfCool;

  // Wind speed (canyon + density attenuation)
  const canyonEffect = hw > 0.5 ? Math.max(0.25, 1 - (hw - 0.5) * 0.38) : 1;
  const densEffect = Math.max(0.18, 1 - density * 0.72);
  const wind = 3.5 * canyonEffect * densEffect;

  // Mean Radiant Temperature component
  const mrt = surfaceTemp + (1 - svf) * (1 - def.albedo) * 18;

  // PET (Physiological Equivalent Temperature)
  const pet = surfaceTemp * 0.7 + mrt * 0.3 - wind * 1.1 + def.thermalMass * 3.5;

  // UTCI
  const utci = pet - 1.8 + (1 - def.breathability) * 4.2;

  // Costs
  const footprint = BASE_SIZE * BASE_SIZE;
  const facadeArea = 4 * BASE_SIZE * h;
  const totalFloorArea = footprint * floors;
  const constructCost = Math.round(totalFloorArea * def.constructCost / 1000);
  const maintainAnnual = Math.round((facadeArea + footprint) * def.maintainCost / 100) * 100;

  return {
    surfaceTemp: +surfaceTemp.toFixed(1),
    wind: +wind.toFixed(1),
    pet: +pet.toFixed(1),
    utci: +utci.toFixed(1),
    svf: Math.round(svf * 100),
    hw: +hw.toFixed(2),
    density: Math.round(density * 100),
    constructCost,
    maintainAnnual
  };
}

// ── View color helpers ─────────────────────────────────────────────────────
function gradientColor(t) {
  // blue → cyan → green → yellow → red
  const c = new THREE.Color();
  c.setHSL((1 - Math.max(0, Math.min(1, t))) * 0.67, 1.0, 0.42);
  return c;
}

function getViewColor(cx, cz, floors, mat) {
  if (viewMode === 'normal') return new THREE.Color(MATS[mat].color);
  const m = computeMetrics(cx, cz, floors, mat);
  if (viewMode === 'heat') return gradientColor((m.pet - 18) / 32);
  if (viewMode === 'wind') {
    const c = new THREE.Color();
    c.setHSL(0.6 - Math.max(0, Math.min(1, m.wind / 4)) * 0.45, 1.0, 0.42);
    return c;
  }
  if (viewMode === 'cost') {
    const c = new THREE.Color();
    c.setHSL((1 - Math.max(0, Math.min(1, (m.constructCost - 200) / 1800))) * 0.33, 1.0, 0.42);
    return c;
  }
  return new THREE.Color(MATS[mat].color);
}

// ── Building mesh ──────────────────────────────────────────────────────────
function createBuildingMesh(cx, cz, floors, mat) {
  const def = MATS[mat];
  const h = floors * FLOOR_H;
  const color = getViewColor(cx, cz, floors, mat);

  const group = new THREE.Group();

  // Main body
  const geo = new THREE.BoxGeometry(BASE_SIZE, h, BASE_SIZE);
  const meshMat = new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(def.emissive),
    roughness: def.roughness,
    metalness: 0.02
  });
  const mesh = new THREE.Mesh(geo, meshMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = { cx, cz, floors, mat, isBuilding: true };
  group.add(mesh);

  // Thin top cap (roof detail)
  const roofGeo = new THREE.BoxGeometry(BASE_SIZE * 0.94, 0.25, BASE_SIZE * 0.94);
  const roofMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.8),
    roughness: 0.6,
    metalness: 0.1
  });
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.y = h / 2 + 0.125;
  roof.castShadow = true;
  group.add(roof);

  // Floor edge lines
  const edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(BASE_SIZE + 0.1, h + 0.1, BASE_SIZE + 0.1));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 });
  group.add(new THREE.LineSegments(edgeGeo, lineMat));

  // Window rows on facades (visual detail)
  if (floors >= 2) {
    const winColor = mat === 'plaster' ? 0xaaccff : 0x88aadd;
    for (let f = 0; f < floors; f++) {
      const wy = -h / 2 + f * FLOOR_H + FLOOR_H * 0.55;
      const winGeo = new THREE.PlaneGeometry(BASE_SIZE * 0.65, FLOOR_H * 0.38);
      const winMatFront = new THREE.MeshStandardMaterial({
        color: winColor, emissive: new THREE.Color(0x001122),
        roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.75
      });
      // Front and back windows
      [0, Math.PI].forEach(ry => {
        const win = new THREE.Mesh(winGeo, winMatFront.clone());
        win.position.set(0, wy, (BASE_SIZE / 2 + 0.02) * (ry === 0 ? 1 : -1));
        win.rotation.y = ry;
        group.add(win);
      });
      // Side windows
      [Math.PI / 2, -Math.PI / 2].forEach(ry => {
        const win = new THREE.Mesh(winGeo, winMatFront.clone());
        win.position.set((BASE_SIZE / 2 + 0.02) * (ry > 0 ? 1 : -1), wy, 0);
        win.rotation.y = ry;
        group.add(win);
      });
    }
  }

  const pos = cellToWorld(cx, cz);
  group.position.set(pos.x, h / 2, pos.z);
  group.userData = { cx, cz, floors, mat, isBuilding: true };

  return group;
}

// ── Add / Remove ───────────────────────────────────────────────────────────
function addBuilding(cx, cz) {
  if (!inBounds(cx, cz)) return;
  const key = cellKey(cx, cz);
  if (buildings[key]) removeBuilding(cx, cz);
  const group = createBuildingMesh(cx, cz, currentFloors, currentMat);
  scene.add(group);
  buildings[key] = { group, floors: currentFloors, material: currentMat, cx, cz };
  refreshAllColors();
  updateMetrics();
}

function removeBuilding(cx, cz) {
  const key = cellKey(cx, cz);
  const b = buildings[key];
  if (!b) return;
  scene.remove(b.group);
  b.group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
  delete buildings[key];
  if (selected && selected.cx === cx && selected.cz === cz) selected = null;
  refreshAllColors();
  updateMetrics();
}

function refreshAllColors() {
  Object.values(buildings).forEach(b => {
    const col = getViewColor(b.cx, b.cz, b.floors, b.material);
    b.group.traverse(obj => {
      if (obj.isMesh && obj.material && !obj.material.transparent) {
        obj.material.color.set(col);
      }
    });
  });
}

function refreshAllGeometry() {
  const snapshot = Object.values(buildings).map(b => ({
    cx: b.cx, cz: b.cz, floors: b.floors, material: b.material
  }));
  snapshot.forEach(b => removeBuilding(b.cx, b.cz));
  snapshot.forEach(b => {
    const savedFloors = currentFloors;
    const savedMat = currentMat;
    currentFloors = b.floors;
    currentMat = b.material;
    addBuilding(b.cx, b.cz);
    currentFloors = savedFloors;
    currentMat = savedMat;
  });
}

// ── Ghost preview ──────────────────────────────────────────────────────────
function updateGhost(cx, cz, visible, replace) {
  // Clear previous ghost children
  while (ghostGroup.children.length) ghostGroup.remove(ghostGroup.children[0]);
  ghostGroup.visible = false;
  if (!visible || !inBounds(cx, cz)) return;
  const h = currentFloors * FLOOR_H;
  const geo = new THREE.BoxGeometry(BASE_SIZE, h, BASE_SIZE);
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: replace ? 0xffaa33 : 0x55cc88, transparent: true, opacity: 0.2
  }));
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(BASE_SIZE + 0.1, h + 0.1, BASE_SIZE + 0.1)),
    new THREE.LineBasicMaterial({ color: replace ? 0xffcc44 : 0x55ff99, transparent: true, opacity: 0.7 })
  );
  ghostGroup.add(fill);
  ghostGroup.add(edges);
  const pos = cellToWorld(cx, cz);
  ghostGroup.position.set(pos.x, h / 2, pos.z);
  ghostGroup.visible = true;
}

// ── Raycasting ─────────────────────────────────────────────────────────────
function getCellFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  // Check buildings first
  const meshes = [];
  Object.values(buildings).forEach(b => b.group.traverse(o => { if (o.isMesh) meshes.push(o); }));
  const hits = raycaster.intersectObjects(meshes);
  if (hits.length > 0) {
    let obj = hits[0].object;
    while (obj && !obj.userData.isBuilding) obj = obj.parent;
    if (obj && obj.userData.isBuilding) {
      return { cx: obj.userData.cx, cz: obj.userData.cz, hitBuilding: true };
    }
  }

  // Ground
  const gHits = raycaster.intersectObject(hitPlane);
  if (gHits.length > 0) {
    const p = gHits[0].point;
    const { cx, cz } = worldToCell(p.x, p.z);
    return { cx, cz, hitBuilding: false };
  }
  return null;
}

// ── Mouse events ───────────────────────────────────────────────────────────
const tip = document.getElementById('tip');
let mouseDownAt = { x: 0, y: 0 };
let dragging = false;

canvas.addEventListener('mousedown', e => {
  mouseDownAt = { x: e.clientX, y: e.clientY };
  dragging = false;
});

canvas.addEventListener('mousemove', e => {
  if (Math.hypot(e.clientX - mouseDownAt.x, e.clientY - mouseDownAt.y) > 4) dragging = true;

  const cell = getCellFromEvent(e);
  tip.style.display = 'none';

  if (!cell) { ghostGroup.visible = false; return; }
  const { cx, cz, hitBuilding } = cell;

  if (mode === 'add') {
    updateGhost(cx, cz, true, !!buildings[cellKey(cx, cz)]);
  } else {
    ghostGroup.visible = false;
  }

  if (mode === 'inspect' && hitBuilding) {
    const b = buildings[cellKey(cx, cz)];
    if (b) {
      const m = computeMetrics(cx, cz, b.floors, b.material);
      tip.innerHTML = `<b>${MATS[b.material].label}</b> · ${b.floors} fl · ${b.floors * FLOOR_H}m<br>
        PET <b>${m.pet}°C</b> · UTCI <b>${m.utci}°C</b><br>
        Wind <b>${m.wind} m/s</b> · SVF <b>${m.svf}%</b><br>
        Build <b>€${m.constructCost}k</b>`;
      tip.style.left = (e.clientX + 16) + 'px';
      tip.style.top = (e.clientY - 8) + 'px';
      tip.style.display = 'block';
    }
  }
});

canvas.addEventListener('click', e => {
  if (dragging) return;
  const cell = getCellFromEvent(e);
  if (!cell) return;
  const { cx, cz } = cell;
  if (!inBounds(cx, cz)) return;

  if (mode === 'add') addBuilding(cx, cz);
  else if (mode === 'remove') removeBuilding(cx, cz);
  else if (mode === 'inspect') {
    selected = buildings[cellKey(cx, cz)] || null;
    // Highlight selected
    Object.values(buildings).forEach(b => {
      const isSel = selected && b.cx === selected.cx && b.cz === selected.cz;
      b.group.traverse(o => {
        if (o.isLineSegments && o.material) {
          o.material.opacity = isSel ? 0.55 : 0.18;
          o.material.color.set(isSel ? 0xffffff : 0x000000);
        }
      });
    });
    updateSelectedMetrics();
  }
});

canvas.addEventListener('mouseleave', () => {
  ghostGroup.visible = false;
  tip.style.display = 'none';
});

// ── Global UI callbacks ────────────────────────────────────────────────────
window.setMode = m => {
  mode = m;
  ghostGroup.visible = false;
  ['add', 'rem', 'ins'].forEach(id => document.getElementById('btn-' + id).classList.remove('active'));
  ({ add: 'btn-add', remove: 'btn-rem', inspect: 'btn-ins' }[m] !== undefined) &&
    document.getElementById({ add: 'btn-add', remove: 'btn-rem', inspect: 'btn-ins' }[m]).classList.add('active');
};

window.setMat = m => {
  currentMat = m;
  ['concrete', 'wood', 'plaster'].forEach(id => document.getElementById('mat-' + id).classList.remove('active'));
  document.getElementById('mat-' + m).classList.add('active');
};

window.setH = v => {
  currentFloors = parseInt(v);
  document.getElementById('hval').textContent =
    `${currentFloors} floor${currentFloors > 1 ? 's' : ''} · ${currentFloors * FLOOR_H} m`;
};

window.setSW = v => {
  streetWidth = parseInt(v);
  document.getElementById('swval').textContent = `${streetWidth} m`;
  refreshAllGeometry();
  updateMetrics();
};

window.setView = v => {
  viewMode = v;
  ['normal', 'heat', 'wind', 'cost'].forEach(id => document.getElementById('view-' + id).classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
  refreshAllColors();
  updateLegend();
};

window.clearAll = () => {
  Object.keys(buildings).forEach(k => {
    const b = buildings[k];
    scene.remove(b.group);
    b.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
  });
  buildings = {};
  selected = null;
  updateMetrics();
};

window.loadPreset = name => {
  window.clearAll();

  if (name === 'residential') {
    document.getElementById('swslider').value = 8;
    streetWidth = 8;
    document.getElementById('swval').textContent = '8 m';
    [
      [1,1,3,'wood'],[1,3,2,'wood'],[1,5,4,'plaster'],
      [3,1,4,'plaster'],[3,3,3,'wood'],[3,5,2,'plaster'],
      [5,1,2,'wood'],[5,3,4,'plaster'],[5,5,3,'wood'],
      [2,2,2,'plaster'],[4,4,3,'wood'],[6,2,2,'plaster'],[2,6,3,'wood']
    ].forEach(([x, z, f, m]) => {
      currentFloors = f; currentMat = m; addBuilding(x, z);
    });
  } else if (name === 'dense') {
    document.getElementById('swslider').value = 4;
    streetWidth = 4;
    document.getElementById('swval').textContent = '4 m';
    for (let x = 1; x < 7; x++) for (let z = 1; z < 7; z++) {
      currentFloors = 4 + Math.floor((x * z) % 5);
      currentMat = 'concrete';
      addBuilding(x, z);
    }
  } else if (name === 'mixed') {
    document.getElementById('swslider').value = 6;
    streetWidth = 6;
    document.getElementById('swval').textContent = '6 m';
    [
      [0,0,2,'plaster'],[0,3,5,'concrete'],[0,6,3,'wood'],
      [2,1,3,'wood'],[2,4,7,'concrete'],[2,6,2,'plaster'],
      [4,0,4,'plaster'],[4,2,2,'wood'],[4,5,6,'concrete'],
      [6,1,8,'concrete'],[6,3,3,'wood'],[6,6,2,'plaster'],
      [1,5,4,'wood'],[3,3,3,'plaster'],[5,4,5,'concrete']
    ].forEach(([x, z, f, m]) => {
      currentFloors = f; currentMat = m; addBuilding(x, z);
    });
  }

  currentFloors = 3; currentMat = 'concrete';
  document.getElementById('hslider').value = 3;
  window.setH(3);
  window.setMat('concrete');
};

// ── Metric UI helpers ──────────────────────────────────────────────────────
function cls(val, thresholds, classes) {
  for (let i = 0; i < thresholds.length; i++) if (val < thresholds[i]) return classes[i];
  return classes[classes.length - 1];
}
const petCls = v => cls(v, [18, 23, 29, 35], ['cc', 'cg', 'cy', 'co', 'cr']);
const utciCls = v => cls(v, [9, 26, 32, 38], ['cc', 'cg', 'cy', 'co', 'cr']);
const windCls = v => cls(v, [1, 2, 3.5, 5], ['cs', 'cc', 'cg', 'cy', 'co']);

function bar(pct, hex) {
  return `<div class="mbar"><div class="mbfill" style="width:${Math.min(100, pct)}%;background:${hex}"></div></div>`;
}

function updateMetrics() {
  const keys = Object.keys(buildings);
  const sceneEl = document.getElementById('scene-metrics');
  if (!keys.length) {
    sceneEl.innerHTML = '<div class="empty"><div class="ic">🏗</div>Add buildings to see metrics</div>';
    updateLegend();
    return;
  }

  let tPet = 0, tUtci = 0, tWind = 0, tTemp = 0, tCost = 0, tMaint = 0;
  const mc = { concrete: 0, wood: 0, plaster: 0 };

  keys.forEach(k => {
    const b = buildings[k];
    const m = computeMetrics(b.cx, b.cz, b.floors, b.material);
    tPet += m.pet; tUtci += m.utci; tWind += m.wind;
    tTemp += m.surfaceTemp; tCost += m.constructCost; tMaint += m.maintainAnnual;
    mc[b.material]++;
  });

  const n = keys.length;
  const aPet = +(tPet / n).toFixed(1);
  const aUtci = +(tUtci / n).toFixed(1);
  const aWind = +(tWind / n).toFixed(1);
  const aTemp = +(tTemp / n).toFixed(1);
  const barColor = c => ({ cc: '#44aaff', cg: '#44dd77', cy: '#ffcc22', co: '#ff8822', cr: '#ff4444', cs: '#888' }[c]);

  sceneEl.innerHTML = `
    <div class="mcard">
      <div class="mhdr">Thermal Comfort (avg)</div>
      <div class="mrow"><span class="mname">PET</span><span class="mval ${petCls(aPet)}">${aPet}°C</span></div>
      ${bar((aPet - 10) / 40 * 100, barColor(petCls(aPet)))}
      <div class="mrow" style="margin-top:6px"><span class="mname">UTCI</span><span class="mval ${utciCls(aUtci)}">${aUtci}°C</span></div>
      ${bar((aUtci - 5) / 40 * 100, barColor(utciCls(aUtci)))}
      <div class="mrow" style="margin-top:6px"><span class="mname">Surface Temp</span><span class="mval cy">${aTemp}°C</span></div>
    </div>
    <div class="mcard">
      <div class="mhdr">Wind (avg)</div>
      <div class="mrow"><span class="mname">Speed</span><span class="mval ${windCls(aWind)}">${aWind} m/s</span></div>
      ${bar(aWind / 5 * 100, '#44aaff')}
      <div style="font-size:10px;color:#445;margin-top:4px">
        Street W/H ratio affects canyon ventilation
      </div>
    </div>
    <div class="mcard">
      <div class="mhdr">Economics (total)</div>
      <div class="mrow"><span class="mname">Construction</span><span class="mval cg">€${tCost.toLocaleString()}k</span></div>
      <div class="mrow"><span class="mname">Annual Maintenance</span><span class="mval cy">€${Math.round(tMaint / 1000)}k/yr</span></div>
    </div>
    <div class="mcard">
      <div class="mhdr">Urban Composition</div>
      <div class="mrow"><span class="mname">Buildings</span><span class="mval cw">${n} / ${GRID * GRID}</span></div>
      <div class="mrow"><span class="mname">Street Width</span><span class="mval cs">${streetWidth} m</span></div>
      <div style="font-size:10px;color:#556;margin-top:5px;line-height:1.7">
        ${mc.concrete ? `<span style="color:#9a9a9a">■</span> Concrete: ${mc.concrete}&nbsp;&nbsp;` : ''}
        ${mc.wood ? `<span style="color:#8B6914">■</span> Wood: ${mc.wood}&nbsp;&nbsp;` : ''}
        ${mc.plaster ? `<span style="color:#e8e0c8">■</span> Plaster: ${mc.plaster}` : ''}
      </div>
    </div>`;

  updateSelectedMetrics();
  updateLegend();
}

function updateSelectedMetrics() {
  const el = document.getElementById('sel-metrics');
  if (!selected || !buildings[cellKey(selected.cx, selected.cz)]) {
    el.innerHTML = '<div class="empty"><div class="ic">🖱</div>Use Inspect mode + click a building</div>';
    return;
  }
  const b = selected;
  const m = computeMetrics(b.cx, b.cz, b.floors, b.material);
  const def = MATS[b.material];
  const barColor = c => ({ cc: '#44aaff', cg: '#44dd77', cy: '#ffcc22', co: '#ff8822', cr: '#ff4444', cs: '#888' }[c]);

  el.innerHTML = `
    <div class="mcard">
      <div class="mhdr">${def.label} · ${b.floors} fl · ${b.floors * FLOOR_H}m</div>
      <div class="mrow"><span class="mname">Grid position</span><span class="mval cs">(${b.cx}, ${b.cz})</span></div>
      <div class="mrow"><span class="mname">H/W ratio</span><span class="mval cy">${m.hw}</span></div>
      <div class="mrow"><span class="mname">Sky View Factor</span><span class="mval cc">${m.svf}%</span></div>
      <div class="mrow"><span class="mname">Neighbour density</span><span class="mval co">${m.density}%</span></div>
    </div>
    <div class="mcard">
      <div class="mhdr">Comfort</div>
      <div class="mrow"><span class="mname">PET</span><span class="mval ${petCls(m.pet)}">${m.pet}°C</span></div>
      ${bar((m.pet - 10) / 40 * 100, barColor(petCls(m.pet)))}
      <div class="mrow" style="margin-top:6px"><span class="mname">UTCI</span><span class="mval ${utciCls(m.utci)}">${m.utci}°C</span></div>
      <div class="mrow"><span class="mname">Surface Temp</span><span class="mval cy">${m.surfaceTemp}°C</span></div>
      <div class="mrow"><span class="mname">Wind Speed</span><span class="mval ${windCls(m.wind)}">${m.wind} m/s</span></div>
    </div>
    <div class="mcard">
      <div class="mhdr">Material</div>
      <div class="mrow"><span class="mname">Albedo</span><span class="mval cc">${def.albedo}</span></div>
      <div class="mrow"><span class="mname">Thermal Mass</span><span class="mval cy">${def.thermalMass}</span></div>
      <div class="mrow"><span class="mname">Breathability</span><span class="mval cg">${def.breathability}</span></div>
    </div>
    <div class="mcard">
      <div class="mhdr">Cost</div>
      <div class="mrow"><span class="mname">Construction</span><span class="mval cg">€${m.constructCost}k</span></div>
      <div class="mrow"><span class="mname">Maintenance/yr</span><span class="mval cy">€${m.maintainAnnual.toLocaleString()}</span></div>
      <div class="mrow"><span class="mname">Unit rate</span><span class="mval cs">€${def.constructCost}/m²</span></div>
    </div>`;
}

function updateLegend() {
  const el = document.getElementById('legend');
  if (viewMode === 'normal') {
    el.innerHTML = `
      <div class="lgit"><div class="lgdot" style="background:#9a9a9a"></div>Concrete – High thermal mass</div>
      <div class="lgit"><div class="lgdot" style="background:#8B6914"></div>Wood – Breathable facade</div>
      <div class="lgit"><div class="lgdot" style="background:#e8e0c8"></div>White Plaster – High albedo</div>`;
  } else if (viewMode === 'heat') {
    el.innerHTML = `
      <div style="font-size:10px;color:#94a3b8;margin-bottom:5px">PET – Physiological Equiv. Temp</div>
      <div style="background:linear-gradient(90deg,#3b82f6,#10b981,#f59e0b,#ef4444);height:7px;border-radius:4px;margin-bottom:4px"></div>
      <div style="display:flex;justify-content:space-between;font-size:9px;color:#94a3b8"><span>18°C Cool</span><span>35°C Hot</span><span>50°C+</span></div>`;
  } else if (viewMode === 'wind') {
    el.innerHTML = `
      <div style="font-size:10px;color:#94a3b8;margin-bottom:5px">Wind Speed (m/s)</div>
      <div style="background:linear-gradient(90deg,#1e3a8a,#3b82f6,#7dd3fc);height:7px;border-radius:4px;margin-bottom:4px"></div>
      <div style="display:flex;justify-content:space-between;font-size:9px;color:#94a3b8"><span>0 Stagnant</span><span>2 Moderate</span><span>4+ Breezy</span></div>`;
  } else if (viewMode === 'cost') {
    el.innerHTML = `
      <div style="font-size:10px;color:#94a3b8;margin-bottom:5px">Construction Cost (€k)</div>
      <div style="background:linear-gradient(90deg,#10b981,#f59e0b,#ef4444);height:7px;border-radius:4px;margin-bottom:4px"></div>
      <div style="display:flex;justify-content:space-between;font-size:9px;color:#94a3b8"><span>€200k</span><span>€1M</span><span>€2M+</span></div>`;
  }
}

// ── Resize + render loop ───────────────────────────────────────────────────
function resize() {
  const vp = document.getElementById('viewport');
  const w = vp.clientWidth;
  const h = vp.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);
// Call resize several times to catch correct layout dimensions
requestAnimationFrame(() => { resize(); requestAnimationFrame(resize); });
setTimeout(resize, 0);
setTimeout(resize, 150);
window.addEventListener('load', resize);

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

// ── Init ───────────────────────────────────────────────────────────────────
updateLegend();
