// Shared Three.js scaffolding for the Demon 3D renderers.
//
// Every scene3d renderer (globe-flight, solar-system, molecule-3d, …) shares
// the exact same plumbing:
//   * a WebGL canvas sized to the container with DPI-correct pixel ratio,
//   * a PerspectiveCamera + OrbitControls (drag to rotate, wheel to zoom,
//     right-drag to pan — exactly what you'd expect in a 3D viewer),
//   * a requestAnimationFrame loop that calls `onFrame(tSeconds)` and renders,
//   * a ResizeObserver so the canvas tracks the host element's size,
//   * a rock-solid dispose() that drops the RAF, tears down controls, the
//     renderer, the ResizeObserver, and every geometry/material/texture the
//     caller hands in via `trackDisposable()`.
//
// Callers override `build()` to populate the scene. The orchestration for
// resize, animation, disposal, and lifecycle stays out of their hair.
//
// NOTE: we intentionally use OrbitControls from three/addons so users get
// smooth damped interaction without us hand-rolling quaternion math.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const DEFAULT_BG_COLOR = 0x0a0d12;

export class Scene3DRenderer {
  /**
   * @param {HTMLElement} host  container element — will host the canvas.
   * @param {object} [opts]
   * @param {number} [opts.cameraDistance=4]  initial camera distance.
   * @param {number} [opts.cameraFov=45]      vertical FOV in degrees.
   * @param {number} [opts.bgColor]           scene clear color.
   * @param {boolean} [opts.enablePan=true]   right-drag panning.
   * @param {boolean} [opts.autoRotate=false] slow automatic rotation.
   * @param {number} [opts.minDistance=1.2]
   * @param {number} [opts.maxDistance=20]
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = {
      cameraDistance: 4,
      cameraFov: 45,
      bgColor: DEFAULT_BG_COLOR,
      enablePan: true,
      autoRotate: false,
      minDistance: 1.2,
      maxDistance: 20,
      ...opts,
    };
    this._raf = 0;
    this._disposed = false;
    this._startedAt = performance.now();
    this._trackedDisposables = [];
    this._initRendererAndScene();
    this._initControls();
    this._initResizeObserver();
    // Defer build() one frame so subclass constructors finish first and the
    // canvas has a measured size.
    queueMicrotask(() => {
      if (this._disposed) return;
      try {
        this.build();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[scene3d] build() failed:', err);
      }
      this._start();
    });
  }

  _initRendererAndScene() {
    const { clientWidth, clientHeight } = this.host;
    // 16:10 is a reasonable default for chat cards; the ResizeObserver takes
    // over the real dimensions as soon as they're measurable.
    const w = clientWidth || 480;
    const h = clientHeight || 300;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.opts.bgColor);

    this.camera = new THREE.PerspectiveCamera(this.opts.cameraFov, w / h, 0.05, 500);
    this.camera.position.set(0, 0, this.opts.cameraDistance);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);

    // Prefer CSS-driven sizing so the canvas stretches to the host.
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none'; // stop the browser from scrolling while
                                       // the user is rotating the scene
    this.host.appendChild(canvas);
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = this.opts.enablePan;
    this.controls.autoRotate = this.opts.autoRotate;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.minDistance = this.opts.minDistance;
    this.controls.maxDistance = this.opts.maxDistance;
    // Clamp the polar angle so the user can't flip to an upside-down camera
    // in scenes where that looks broken (globe, solar-system, etc).
    if (this.opts.minPolarAngle != null) this.controls.minPolarAngle = this.opts.minPolarAngle;
    if (this.opts.maxPolarAngle != null) this.controls.maxPolarAngle = this.opts.maxPolarAngle;
  }

  _initResizeObserver() {
    this._ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) continue;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height, false);
      }
    });
    this._ro.observe(this.host);
  }

  _start() {
    const tick = () => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      const t = (performance.now() - this._startedAt) / 1000;
      try {
        this.onFrame(t);
      } catch (err) {
        // Never let a buggy frame callback take down the whole session.
        // eslint-disable-next-line no-console
        console.warn('[scene3d] onFrame threw, pausing animation:', err);
        this.dispose();
        return;
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this._raf = requestAnimationFrame(tick);
  }

  /**
   * Register a THREE geometry / material / texture / group / mesh so it's
   * cleaned up on dispose(). The Scene3DRenderer will walk these at teardown
   * and call .dispose() on anything that has it.
   */
  trackDisposable(obj) {
    if (obj) this._trackedDisposables.push(obj);
    return obj;
  }

  /** Subclasses override this to populate `this.scene`. Called once. */
  build() {
    /* no-op default */
  }

  /** Subclasses override this to update animated objects. Called every frame.
   *  @param {number} tSeconds elapsed since mount. */
  onFrame(_tSeconds) {
    /* no-op default */
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    if (this.controls) this.controls.dispose();
    // Walk tracked disposables once — order is arbitrary because
    // geometry/material/texture disposes are independent.
    for (const obj of this._trackedDisposables) {
      try {
        if (obj && typeof obj.dispose === 'function') obj.dispose();
      } catch {
        /* swallow — disposal is best-effort */
      }
    }
    this._trackedDisposables.length = 0;
    if (this.renderer) {
      this.renderer.dispose();
      const canvas = this.renderer.domElement;
      if (canvas && canvas.parentNode === this.host) {
        this.host.removeChild(canvas);
      }
    }
    // Drop references so anything still holding this instance can be GC'd.
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.renderer = null;
  }
}

/** Geographic → unit sphere conversion for globe renderers.
 *  lat/lng in degrees → (x, y, z) on a radius-1 sphere. */
export function latLngToVec3(latDeg, lngDeg, radius = 1) {
  const lat = (latDeg * Math.PI) / 180;
  const lng = (lngDeg * Math.PI) / 180;
  const x = radius * Math.cos(lat) * Math.cos(lng);
  const y = radius * Math.sin(lat);
  const z = -radius * Math.cos(lat) * Math.sin(lng);
  return new THREE.Vector3(x, y, z);
}

/** Great-circle slerp between two unit vectors, returning `samples`
 *  intermediate points (inclusive). Used to draw the flight arc on the
 *  globe as a smooth curve following the earth's surface rather than a
 *  straight line cutting through it. */
export function greatCirclePoints(a, b, samples = 64, altitudeBoost = 0.08) {
  const out = [];
  const dot = Math.min(1, Math.max(-1, a.dot(b)));
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    let p;
    if (sinOmega < 1e-6) {
      // Degenerate case (same point) — just duplicate.
      p = a.clone();
    } else {
      const s1 = Math.sin((1 - t) * omega) / sinOmega;
      const s2 = Math.sin(t * omega) / sinOmega;
      p = a.clone().multiplyScalar(s1).add(b.clone().multiplyScalar(s2));
    }
    // Lift the arc off the surface so it reads as a flight path rather than
    // a line painted on the ocean. Peaks at t=0.5.
    const lift = 1 + altitudeBoost * Math.sin(Math.PI * t);
    p.normalize().multiplyScalar(lift);
    out.push(p);
  }
  return out;
}

export { THREE };
