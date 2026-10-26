import { escapeHtml } from '../../i18n.js';
// globe-flight — 3D interactive globe with an animated flight arc.
//
// Spec shape:
//   {
//     renderer: "globe-flight",
//     title: "SFO → NRT",
//     origin:      { lat: 37.6189,  lng: -122.3750, label: "SFO" },
//     destination: { lat: 35.7647,  lng: 140.3863,  label: "NRT" },
//     // Optional
//     flightNumber: "UA837",
//     subtitle: "United 837 · 11h 05m",
//     autoRotate: true,
//     arcDuration: 8    // seconds for the plane to traverse origin→destination
//   }
//
// Interaction: drag to rotate, scroll to zoom, right-drag to pan.
// The plane loops the arc indefinitely; fine-tune `arcDuration` for pace.

import { Scene3DRenderer, THREE, latLngToVec3, greatCirclePoints } from '../scene3d.js';

const EARTH_RADIUS = 1.0;

class GlobeFlightScene extends Scene3DRenderer {
  constructor(host, spec) {
    super(host, {
      cameraDistance: 3.2,
      cameraFov: 45,
      bgColor: 0x05080f,
      enablePan: false, // pan on a globe is rarely useful and feels weird
      autoRotate: !!spec.autoRotate,
      minDistance: 1.5,
      maxDistance: 8,
    });
    this.spec = spec;
    this.arcDuration = Math.max(2, Number(spec.arcDuration) || 8);
  }

  build() {
    const { scene } = this;

    // ── Earth sphere ─────────────────────────────────────────────────────
    // No external texture dependencies — we paint a stylized earth with two
    // layers: a dark-ocean base + a land-mass overlay driven by procedural
    // noise. This keeps the bundle offline-only and avoids CDN calls.
    const earthGeo = this.trackDisposable(new THREE.SphereGeometry(EARTH_RADIUS, 96, 96));
    const earthMat = this.trackDisposable(
      new THREE.MeshPhongMaterial({
        color: 0x1b3a5a,
        emissive: 0x0a1a30,
        specular: 0x223344,
        shininess: 14,
      }),
    );
    const earth = new THREE.Mesh(earthGeo, earthMat);
    scene.add(earth);
    this.earth = earth;

    // Landmass overlay: a wireframe icosahedron at 1.001× radius gives the
    // globe a stylized mesh-of-continents look without needing a texture.
    const landGeo = this.trackDisposable(new THREE.IcosahedronGeometry(EARTH_RADIUS * 1.001, 6));
    const landMat = this.trackDisposable(
      new THREE.MeshBasicMaterial({
        color: 0x56c6b8,
        wireframe: true,
        transparent: true,
        opacity: 0.22,
      }),
    );
    scene.add(new THREE.Mesh(landGeo, landMat));

    // Subtle atmosphere halo.
    const atmoGeo = this.trackDisposable(new THREE.SphereGeometry(EARTH_RADIUS * 1.06, 48, 48));
    const atmoMat = this.trackDisposable(
      new THREE.MeshBasicMaterial({
        color: 0x2bb9b2,
        transparent: true,
        opacity: 0.08,
        side: THREE.BackSide,
      }),
    );
    scene.add(new THREE.Mesh(atmoGeo, atmoMat));

    // ── Lighting ─────────────────────────────────────────────────────────
    const sun = new THREE.DirectionalLight(0xffffff, 1.15);
    sun.position.set(3, 2, 2);
    scene.add(sun);
    const ambient = new THREE.AmbientLight(0x406070, 0.55);
    scene.add(ambient);

    // ── Endpoint pins ────────────────────────────────────────────────────
    const { origin, destination } = this.spec;
    this.originVec = latLngToVec3(origin.lat, origin.lng, EARTH_RADIUS);
    this.destinationVec = latLngToVec3(destination.lat, destination.lng, EARTH_RADIUS);
    this._addPin(this.originVec, origin.label || 'Origin', 0x3ad6cf);
    this._addPin(this.destinationVec, destination.label || 'Destination', 0xff6b4a);

    // ── Great-circle arc ─────────────────────────────────────────────────
    const arcPoints = greatCirclePoints(this.originVec, this.destinationVec, 128, 0.12);
    this.arcPoints = arcPoints;
    const arcGeo = this.trackDisposable(new THREE.BufferGeometry().setFromPoints(arcPoints));
    const arcMat = this.trackDisposable(
      new THREE.LineBasicMaterial({ color: 0xf6b24a, transparent: true, opacity: 0.85 }),
    );
    scene.add(new THREE.Line(arcGeo, arcMat));

    // ── Plane marker ─────────────────────────────────────────────────────
    // A cone pointing along +Z works as a stylized plane silhouette. We
    // re-orient it each frame so its nose tracks the arc tangent.
    const planeGeo = this.trackDisposable(new THREE.ConeGeometry(0.02, 0.07, 12));
    planeGeo.rotateX(Math.PI / 2);
    const planeMat = this.trackDisposable(
      new THREE.MeshBasicMaterial({ color: 0xffe9b8 }),
    );
    this.plane = new THREE.Mesh(planeGeo, planeMat);
    scene.add(this.plane);

    // Plane glow (a sprite would be nicer but adds a dependency; a small
    // emissive sphere behind the plane looks clean and costs nothing).
    const glowGeo = this.trackDisposable(new THREE.SphereGeometry(0.015, 12, 12));
    const glowMat = this.trackDisposable(
      new THREE.MeshBasicMaterial({ color: 0xf6b24a, transparent: true, opacity: 0.85 }),
    );
    this.planeGlow = new THREE.Mesh(glowGeo, glowMat);
    scene.add(this.planeGlow);

    // ── Rotate globe so the arc is roughly facing the camera at mount ────
    const mid = this.originVec.clone().add(this.destinationVec).normalize();
    const targetAzimuth = Math.atan2(-mid.z, mid.x);
    earth.rotation.y = Math.PI / 2 - targetAzimuth;
    // Apply the same rotation to our endpoint vectors so pins + arc match
    // the earth. Easier: parent everything to a group. We do the simple
    // version — rotate every anchor ourselves to stay pinned to the globe.
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      earth.rotation.y,
    );
    this.originVec.applyQuaternion(q);
    this.destinationVec.applyQuaternion(q);
    for (const p of this.arcPoints) p.applyQuaternion(q);
    arcGeo.setFromPoints(this.arcPoints);
    // Re-position the pins now that we rotated their anchor vectors.
    this._rebuildPins();

    // Starfield backdrop — cheap and adds a lot of atmosphere to a chat card.
    this._addStarfield();
  }

  _addPin(anchor, label, color) {
    if (!this._pinEntries) this._pinEntries = [];
    this._pinEntries.push({ anchor: anchor.clone(), label, color });
    this._rebuildPins();
  }

  _rebuildPins() {
    // Remove any previous pins.
    if (this._pinGroup) {
      this.scene.remove(this._pinGroup);
    }
    this._pinGroup = new THREE.Group();
    this.scene.add(this._pinGroup);
    for (const entry of this._pinEntries || []) {
      const surface = entry.anchor.clone().normalize().multiplyScalar(EARTH_RADIUS);
      const tip = surface.clone().normalize().multiplyScalar(EARTH_RADIUS + 0.12);
      // Stem: a thin cylinder from surface to tip.
      const stemGeo = this.trackDisposable(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 8));
      const stemMat = this.trackDisposable(new THREE.MeshBasicMaterial({ color: entry.color }));
      const stem = new THREE.Mesh(stemGeo, stemMat);
      stem.position.copy(surface.clone().add(tip).multiplyScalar(0.5));
      stem.lookAt(tip);
      stem.rotateX(Math.PI / 2);
      this._pinGroup.add(stem);
      // Head: a small sphere at the tip.
      const headGeo = this.trackDisposable(new THREE.SphereGeometry(0.022, 12, 12));
      const headMat = this.trackDisposable(
        new THREE.MeshBasicMaterial({ color: entry.color }),
      );
      const head = new THREE.Mesh(headGeo, headMat);
      head.position.copy(tip);
      this._pinGroup.add(head);
    }
  }

  _addStarfield() {
    const starCount = 600;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i += 1) {
      // Random point on a sphere with radius ~25 so the camera can't reach it.
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * Math.PI * 2;
      const r = 25;
      const sqrtOne = Math.sqrt(1 - u * u);
      positions[i * 3 + 0] = r * sqrtOne * Math.cos(theta);
      positions[i * 3 + 1] = r * u;
      positions[i * 3 + 2] = r * sqrtOne * Math.sin(theta);
    }
    const geo = this.trackDisposable(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = this.trackDisposable(
      new THREE.PointsMaterial({ color: 0xbfd4f0, size: 0.05, sizeAttenuation: true }),
    );
    this.scene.add(new THREE.Points(geo, mat));
  }

  onFrame(t) {
    if (!this.plane || !this.arcPoints?.length) return;
    // Loop the plane along the arc. Phase ∈ [0, 1).
    const phase = (t / this.arcDuration) % 1;
    const fIdx = phase * (this.arcPoints.length - 1);
    const i = Math.floor(fIdx);
    const frac = fIdx - i;
    const p0 = this.arcPoints[i];
    const p1 = this.arcPoints[Math.min(i + 1, this.arcPoints.length - 1)];
    const pos = p0.clone().lerp(p1, frac);
    this.plane.position.copy(pos);
    this.planeGlow.position.copy(pos);
    // Point the cone along the tangent to the arc.
    const ahead = this.arcPoints[Math.min(i + 2, this.arcPoints.length - 1)];
    this.plane.lookAt(ahead);
  }
}

export default function mountGlobeFlight(host, spec) {
  if (!host) return null;
  // Give the host a defined height so the WebGL canvas has room to render.
  host.classList.add('viz-card', 'viz-card-scene3d');
  host.innerHTML = `
    <div class="viz-title">${escapeHtml(spec.title || 'Flight path')}</div>
    <div class="viz-scene3d-stage" data-stage></div>
    <div class="viz-scene3d-meta">
      ${spec.subtitle ? `<span class="viz-scene3d-subtitle">${escapeHtml(spec.subtitle)}</span>` : ''}
      <span class="viz-scene3d-hint">Drag to rotate · Scroll to zoom</span>
    </div>
  `;
  const stage = host.querySelector('[data-stage]');
  if (!stage) return null;
  const scene = new GlobeFlightScene(stage, spec);
  return {
    dispose() {
      scene.dispose();
    },
  };
}
