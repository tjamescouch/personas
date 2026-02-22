/**
 * Three.js scene controller for Ellie GLB model.
 *
 * Ellie's face is bone-driven (1867 bones per animation). Every animation
 * includes ALL bone tracks. Playing face animations alongside idle would
 * blend body bones toward T-pose.
 *
 * Solution: Strip face animations to ONLY face-bone tracks + morph target tracks.
 * Face-only clips blend safely with idle — idle controls body, face clips control face.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SignalMapper } from "./signal-mapper.mjs";

// Face bone name patterns (from Ellie's rig)
// Face bones only — exclude Head/Neck so idle controls head movement
const FACE_BONE_RE = /Lip|Eyelid|Eye_Ring|Eye\b|Cheek|Jaw|Brow|Nose|Chin|Tongue|Mouth|Pupil|Eyeball/i;

// Known Three.js property suffixes
const PROP_SUFFIXES = [".quaternion", ".position", ".scale"];

/**
 * Extract the node name from a Three.js animation track name.
 * Track format: "NodeName.property" — but node names can contain dots (e.g. "Bone.L")
 * We split from the right on known property names.
 */
function getNodeName(trackName) {
  // Handle morphTargetInfluences (keep all morph tracks)
  if (trackName.includes("morphTargetInfluences")) return null; // special: always keep

  for (const suffix of PROP_SUFFIXES) {
    if (trackName.endsWith(suffix)) {
      return trackName.slice(0, -suffix.length);
    }
  }
  return trackName;
}

/**
 * Create a new clip containing only face-bone tracks and morph target tracks.
 */
function faceOnlyClip(clip) {
  const faceTracks = clip.tracks.filter((t) => {
    // Always keep morph target tracks
    if (t.name.includes("morphTargetInfluences")) return true;
    // Keep tracks for face bones
    const nodeName = getNodeName(t.name);
    return nodeName && FACE_BONE_RE.test(nodeName);
  });

  if (faceTracks.length === 0) return null;
  return new THREE.AnimationClip(clip.name + "_face", clip.duration, faceTracks);
}

const LFS_CLIP_NAMES = [
  "Ellie Mouth Aa", "Ellie mouth Ee", "Ellie mouth Eh",
  "Ellie mouth Oo", "Ellie mouth Uu", "Ellie mouth squeeze",
  "Ellie mouth smileclosed", "Ellie mouth smileclosed2", "Ellie mouth smileopen",
  "Ellie eyemask content", "Ellie eyemask relaxed", "Ellie eyemask concerned",
  "Ellie eyemask angry", "Ellie eyemask closed", "Ellie eyemask squint",
  "Ellie eymask scared",
  "Ellie face default", "Ellie face excited", "Ellie face awkward",
  "Ellie face scared", "Ellie face scared2", "Ellie face annoyed",
  "Ellie face suspicious", "Ellie face squint", "Ellie face wissle",
  "RIG.Ellie_Eyebrows_Down",
  "RIG.Ellie_Eyelid_Upper_Close-Open",
  "RIG.Ellie_Eyelid_Lower_Close-Open",
];

export class AvatarController {
  constructor(container) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    this.camera = new THREE.PerspectiveCamera(
      30, window.innerWidth / window.innerHeight, 0.1, 100
    );
    this.camera.position.set(0, 1.5, 3.0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    // Lighting
    const keyLight = new THREE.DirectionalLight(0xfff5e6, 2.0);
    keyLight.position.set(2, 3, 3);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xb4c7e7, 0.8);
    fillLight.position.set(-2, 2, 1);
    this.scene.add(fillLight);
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.4);
    rimLight.position.set(0, 2, -3);
    this.scene.add(rimLight);
    this.scene.add(new THREE.HemisphereLight(0xb1e1ff, 0x3d2b1f, 0.8));

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.3, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.update();

    this.mixer = null;
    this.actions = {};
    this.activeActions = {};
    this.currentTargets = {};
    this.clock = new THREE.Clock();
    this.signalMapper = new SignalMapper();
    this.debugEl = null;

    window.addEventListener("resize", () => this._onResize());
  }

  async load(url, onProgress) {
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, onProgress || undefined, reject);
    });

    this.scene.add(gltf.scene);
    this.mixer = new THREE.AnimationMixer(gltf.scene);

    const clipsByName = {};
    for (const clip of gltf.animations) {
      clipsByName[clip.name] = clip;
    }

    // --- Idle: full body, normal blending ---
    if (clipsByName["ANI-ellie.idle"]) {
      const idle = this.mixer.clipAction(clipsByName["ANI-ellie.idle"]);
      idle.setEffectiveWeight(1.0);
      idle.setLoop(THREE.LoopRepeat, Infinity);
      idle.play();
      this.actions["ANI-ellie.idle"] = idle;
      this.activeActions["ANI-ellie.idle"] = true;
    }

    // --- Face animations: stripped to face-bone tracks only ---
    let count = 0;
    for (const name of LFS_CLIP_NAMES) {
      const clip = clipsByName[name];
      if (!clip) continue;

      const stripped = faceOnlyClip(clip);
      if (!stripped) {
        console.warn(`No face tracks found in "${name}"`);
        continue;
      }

      const action = this.mixer.clipAction(stripped);
      action.setEffectiveWeight(0);
      action.setLoop(THREE.LoopRepeat, Infinity);
      this.actions[name] = action;
      this.activeActions[name] = false;
      count++;

      // Log first clip's stats
      if (count === 1) {
        console.log(`"${name}": ${clip.tracks.length} total → ${stripped.tracks.length} face tracks`);
        // Sample face bone names
        const faceNodes = new Set();
        for (const t of stripped.tracks) {
          if (!t.name.includes("morphTarget")) {
            const n = getNodeName(t.name);
            if (n) faceNodes.add(n);
          }
        }
        console.log("Face bones sample:", [...faceNodes].slice(0, 15));
      }
    }

    console.log(`Loaded: idle + ${count} face-only clips`);
    return Object.keys(this.actions);
  }

  applySignal(signal) {
    const targets = this.signalMapper.map(signal);
    Object.assign(this.currentTargets, targets);

    if (this.debugEl) {
      const { v, c, e, dt, seq } = signal;
      this.debugEl.textContent =
        `v:${(v || "SIL").padEnd(3)} c:${(c ?? 0).toFixed(2)} e:${(e ?? 0).toFixed(2)} dt:${dt ?? 0}ms seq:${seq ?? "-"}`;
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = this.clock.getDelta();

    for (const [name, targetWeight] of Object.entries(this.currentTargets)) {
      const action = this.actions[name];
      if (!action) continue;

      const current = action.getEffectiveWeight();
      const isBlink = name.includes("Eyelid");
      const rate = isBlink ? 0.4 : 0.15;
      let next = current + (targetWeight - current) * rate;
      if (Math.abs(next) < 0.005) next = 0;
      next = Math.max(0, next);

      if (next > 0 && !this.activeActions[name]) {
        action.play();
        this.activeActions[name] = true;
      } else if (next === 0 && this.activeActions[name] && name !== "ANI-ellie.idle") {
        action.stop();
        this.activeActions[name] = false;
      }

      action.setEffectiveWeight(next);
    }

    if (this.mixer) this.mixer.update(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  setDebugElement(el) {
    this.debugEl = el;
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
