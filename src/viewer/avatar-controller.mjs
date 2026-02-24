/**
 * Avatar controller — loads Ellie GLB, plays idle animation, and drives
 * face/mouth/eye animations from LFS signals via clip action weights.
 *
 * On load, reports a full capabilities manifest (animations, bones, morph
 * targets) to the server so upstream models know what the body can do.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { SignalMapper } from "./signal-mapper.mjs";

export class AvatarController {
  constructor(container) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05050f);

    this.camera = new THREE.PerspectiveCamera(
      30, window.innerWidth / window.innerHeight, 0.1, 100
    );
    this.camera.position.set(0, 1.5, 3.0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    // PBR environment map — required for metallic/reflective materials to look correct
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment()).texture;
    pmremGenerator.dispose();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.3, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.update();

    this.mixer = null;
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
    for (const clip of gltf.animations) clipsByName[clip.name] = clip;

    // Play idle
    if (clipsByName["ANI-ellie.idle"]) {
      const idle = this.mixer.clipAction(clipsByName["ANI-ellie.idle"]);
      idle.setEffectiveWeight(1.0);
      idle.setLoop(THREE.LoopRepeat, Infinity);
      idle.play();
    }

    // Only create actions for clips the signal mapper uses — other clips
    // may have material/color tracks that corrupt the model's appearance
    const SIGNAL_CLIPS = new Set([
      "Ellie Mouth Aa", "Ellie mouth Ee", "Ellie mouth Eh",
      "Ellie mouth Oo", "Ellie mouth Uu", "Ellie mouth squeeze",
      "Ellie mouth smileclosed", "Ellie mouth smileopen",
      "Ellie face default", "Ellie face excited", "Ellie face awkward",
      "Ellie face scared", "Ellie face annoyed", "Ellie face suspicious",
      "Ellie face squint",
      "Ellie eyemask content", "Ellie eyemask relaxed",
      "Ellie eyemask concerned", "Ellie eyemask angry",
      "RIG.Ellie_Eyelid_Upper_Close-Open", "RIG.Ellie_Eyebrows_Down",
      "Ellie full cheerful", "Ellie full relaxed",
    ]);

    this._actions = {};
    for (const [name, clip] of Object.entries(clipsByName)) {
      if (name === "ANI-ellie.idle") continue;
      if (!SIGNAL_CLIPS.has(name)) continue;
      // Strip bone transform tracks — only keep morph targets.
      // Face clips contain bone tracks for ALL bones (arms, legs, etc.)
      // which pull the body toward T-pose. Morph targets only affect face geometry.
      const safeClip = clip.clone();
      safeClip.tracks = safeClip.tracks.filter((track) => {
        const prop = track.name.split(".").pop();
        return prop === "morphTargetInfluences";
      });
      if (safeClip.tracks.length === 0) continue;
      const action = this.mixer.clipAction(safeClip);
      action.setEffectiveWeight(0);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      this._actions[name] = action;
    }
    this._targetWeights = {};

    // === Survey all meshes, hide static ones, apply cyberpunk materials ===
    const allMeshes = [];
    const grimeMap = this._createGrimeMap();

    gltf.scene.traverse((obj) => {
      if (obj.isMesh) {
        allMeshes.push(obj);
        if (!obj.isSkinnedMesh) {
          obj.visible = false;
        } else {
          const hue = Math.random();
          const baseColor = new THREE.Color().setHSL(hue, 0.3, 0.12);
          const emissiveColor = new THREE.Color().setHSL(hue, 1.0, 0.4);
          obj.material = new THREE.MeshStandardMaterial({
            color: baseColor,
            emissive: emissiveColor,
            emissiveIntensity: 0.15,
            roughnessMap: grimeMap,
            metalness: 0.1,
            roughness: 0.8,
          });
        }
      }
    });

    // === Build capabilities manifest ===
    // Collect all animation clip info
    const animations = gltf.animations.map((clip) => {
      const trackTypes = new Set();
      const targetNames = new Set();
      for (const track of clip.tracks) {
        const prop = track.name.split(".").pop();
        trackTypes.add(prop);
        // Extract the object name (before the first dot)
        const objName = track.name.split(".")[0];
        if (objName) targetNames.add(objName);
      }
      return {
        name: clip.name,
        duration: Math.round(clip.duration * 1000) / 1000,
        trackCount: clip.tracks.length,
        trackTypes: [...trackTypes],
        active: clip.name in this._actions || clip.name === "ANI-ellie.idle",
      };
    });

    // Collect bone hierarchy from first skinned mesh
    const bones = [];
    const boneHierarchy = {};
    for (const mesh of allMeshes) {
      if (!mesh.isSkinnedMesh) continue;
      for (const bone of mesh.skeleton.bones) {
        bones.push(bone.name);
        if (bone.parent && bone.parent.isBone) {
          boneHierarchy[bone.name] = bone.parent.name;
        }
      }
      break; // only need first skeleton
    }

    // Collect morph targets from all skinned meshes
    const morphTargets = {};
    for (const mesh of allMeshes) {
      if (!mesh.isSkinnedMesh) continue;
      const dict = mesh.morphTargetDictionary;
      if (dict && Object.keys(dict).length > 0) {
        morphTargets[mesh.name] = Object.keys(dict);
      }
    }

    // Collect mesh info
    const meshes = allMeshes
      .filter((m) => m.isSkinnedMesh)
      .map((m) => {
        m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox;
        return {
          name: m.name,
          vertices: m.geometry.attributes.position.count,
          boundsY: [
            Math.round(bb.min.y * 100) / 100,
            Math.round(bb.max.y * 100) / 100,
          ],
          hasMorphTargets: !!(m.morphTargetDictionary && Object.keys(m.morphTargetDictionary).length > 0),
        };
      });

    this._capabilities = {
      animations,
      bones,
      boneHierarchy,
      morphTargets,
      meshes,
      activeClips: Object.keys(this._actions),
    };

    // POST capabilities to server so upstream models can discover the body
    this._reportCapabilities();

    console.log("=== Avatar loaded — capabilities reported to server ===");
  }

  /** Send capabilities manifest to the server. */
  async _reportCapabilities() {
    try {
      await fetch("/api/avatar/capabilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this._capabilities),
      });
    } catch (e) {
      console.warn("Failed to report capabilities:", e);
    }
  }

  applySignal(signal) {
    if (!this._actions) return;
    this._targetWeights = this.signalMapper.map(signal, signal.dt || 16);

    // Debug display
    if (this.debugEl) {
      const v = signal.v || "?";
      const c = (signal.c ?? 0).toFixed(2);
      const e = (signal.e ?? 0).toFixed(2);
      const dt = signal.dt ?? 0;
      this.debugEl.textContent = `v:${v}  c:${c}  e:${e}  dt:${dt}ms  seq:${signal.seq ?? "-"}`;
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = this.clock.getDelta();

    // Smoothly interpolate action weights toward signal-driven targets
    // (must run before mixer.update so weights take effect this frame)
    if (this._actions && this._targetWeights) {
      // Mouth animations: fast lerp for responsive lip sync
      // Expressions: slower lerp for smooth emotional transitions
      const MOUTH_LERP = 18;
      const EXPR_LERP = 6;

      for (const [name, action] of Object.entries(this._actions)) {
        const target = this._targetWeights[name] ?? 0;
        const current = action.getEffectiveWeight();
        const isMouth = name.includes("outh") || name.includes("squeeze");
        const speed = isMouth ? MOUTH_LERP : EXPR_LERP;
        const newWeight = current + (target - current) * Math.min(1, speed * dt);
        action.setEffectiveWeight(newWeight);
      }
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

  // ── Procedural cyberpunk materials ──

  _createGrimeMap() {
    return this._proceduralTexture(512, (ctx, w, h) => {
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, w, h);
      // Perlin-ish noise via layered random rects
      for (let s = 64; s >= 2; s = Math.floor(s / 2)) {
        ctx.globalAlpha = 0.15;
        for (let y = 0; y < h; y += s) {
          for (let x = 0; x < w; x += s) {
            const v = Math.floor(Math.random() * 80 + 88);
            ctx.fillStyle = `rgb(${v},${v},${v})`;
            ctx.fillRect(x, y, s, s);
          }
        }
      }
      // Dirt streaks
      ctx.globalAlpha = 0.3;
      for (let i = 0; i < 40; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const len = 20 + Math.random() * 80;
        ctx.strokeStyle = `rgba(40,35,30,${0.3 + Math.random() * 0.4})`;
        ctx.lineWidth = 1 + Math.random() * 4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (Math.random() - 0.5) * len, y + Math.random() * len);
        ctx.stroke();
      }
      // Scuff marks
      ctx.globalAlpha = 0.2;
      for (let i = 0; i < 20; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const r = 3 + Math.random() * 12;
        ctx.fillStyle = `rgba(30,30,30,${0.3 + Math.random() * 0.3})`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.4, Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  _proceduralTexture(size, drawFn) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    drawFn(ctx, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}
