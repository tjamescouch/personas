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

    this._clipsByName = {};
    for (const clip of gltf.animations) this._clipsByName[clip.name] = clip;
    const clipsByName = this._clipsByName;

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

    // === Survey all meshes, assign per-category procedural materials ===
    const allMeshes = [];
    this._materialCache = {};

    gltf.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      allMeshes.push(obj);
      if (!obj.isSkinnedMesh) {
        obj.visible = false;
        return;
      }
      const category = this._classifyMesh(obj.name);
      if (category === "hidden") {
        obj.visible = false;
      } else {
        obj.material = this._getMaterial(category);
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

    // Avatar animate command — set clip weights directly from stream markers.
    // These persist in _animateWeights and overlay viseme-driven weights.
    if (signal.type === "animate" && signal.clips) {
      // Queue animate commands — each plays for at least 2s before the next
      if (!this._animateQueue) this._animateQueue = [];
      this._animateQueue.push(signal.clips);
      if (!this._animatePlaying) this._playNextAnimate();
      return;
    }

    // Viseme signal — signal mapper drives morph-target-only actions
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

  _playNextAnimate() {
    if (!this._animateQueue || this._animateQueue.length === 0) {
      this._animatePlaying = false;
      // Restore idle when queue is empty
      this.mixer.stopAllAction();
      const idle = this._clipsByName["ANI-ellie.idle"];
      if (idle) {
        const act = this.mixer.clipAction(idle);
        act.reset();
        act.setEffectiveWeight(1);
        act.setLoop(THREE.LoopRepeat, Infinity);
        act.play();
      }
      // Restart signal-driven actions at weight 0
      for (const action of Object.values(this._actions)) {
        action.reset();
        action.setEffectiveWeight(0);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
      }
      if (this.debugEl) this.debugEl.textContent = "idle";
      return;
    }
    this._animatePlaying = true;
    const clips = this._animateQueue.shift();

    // Stop everything, play requested clips + idle at low weight
    this.mixer.stopAllAction();
    for (const [name, weight] of Object.entries(clips)) {
      const clip = this._clipsByName[name];
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      action.reset();
      action.setEffectiveWeight(weight);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
    }
    const idle = this._clipsByName["ANI-ellie.idle"];
    if (idle) {
      const act = this.mixer.clipAction(idle);
      act.reset();
      act.setEffectiveWeight(0.3);
      act.setLoop(THREE.LoopRepeat, Infinity);
      act.play();
    }
    if (this.debugEl) {
      this.debugEl.textContent = `animate: ${Object.keys(clips).join(", ")}`;
    }

    // Hold for 2.5s then play next in queue
    setTimeout(() => this._playNextAnimate(), 2500);
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

  // ── Mesh classification ──

  _classifyMesh(name) {
    const n = name.toLowerCase();
    // Rig/paint helpers — always hide
    if (n.includes("rig_helper") || n.includes("weight_paint_helper")) return "hidden";
    // Eyes
    if (n.includes("eye_highlight")) return "eye_highlight";
    if (n.includes("eyel001_1") || n.includes("eyer001_1")) return "iris";
    if (n.includes("eyel") || n.includes("eyer")) return "eye";
    if (n.includes("eyelash") || n.includes("eyelid")) return "lash";
    if (n.includes("eyebrow")) return "hair";
    // Hair
    if (n.includes("hair") || n.includes("hairgroom")) return "hair";
    if (n.includes("scrunchy")) return "fabric";
    // Mouth
    if (n.includes("teeth")) return "teeth";
    if (n.includes("tongue")) return "tongue";
    // Clothing — jacket
    if (n.includes("jacket_button") || n.includes("jacket_pin")) return "metal";
    if (n.includes("jacket")) return "jacket";
    // Clothing — lower
    if (n.includes("trousers")) return "fabric";
    if (n.includes("boots")) return "leather";
    // Accessories
    if (n.includes("watch")) return "metal";
    if (n.includes("earring")) return "metal";
    if (n.includes("fannypack_main")) return "fabric";
    if (n.includes("fannypack")) return "metal"; // buckles, straps, zippers
    if (n.includes("handkerchief")) return "fabric";
    // Skin — body, head, face lines
    if (n.includes("body")) return "skin";
    if (n.includes("head")) return "skin";
    if (n.includes("face_line")) return "skin";
    // Fallback
    return "skin";
  }

  // ── Per-category materials (cached) ──

  _getMaterial(category) {
    if (this._materialCache[category]) return this._materialCache[category];
    const mat = this._createMaterial(category);
    this._materialCache[category] = mat;
    return mat;
  }

  _createMaterial(category) {
    switch (category) {
      case "skin":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.85, 0.65, 0.52),
          roughness: 0.75,
          metalness: 0.0,
          roughnessMap: this._createSkinMap(),
          emissive: new THREE.Color(0.15, 0.05, 0.03),
          emissiveIntensity: 0.2,
        });

      case "eye":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.95, 0.95, 0.97),
          roughness: 0.05,
          metalness: 0.0,
          emissive: new THREE.Color(0.1, 0.1, 0.12),
          emissiveIntensity: 0.3,
        });

      case "iris":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.06, 0.12, 0.08),
          roughness: 0.1,
          metalness: 0.0,
          emissive: new THREE.Color(0.02, 0.05, 0.03),
          emissiveIntensity: 0.15,
        });

      case "eye_highlight":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(1.0, 1.0, 1.0),
          emissive: new THREE.Color(1.0, 1.0, 1.0),
          emissiveIntensity: 0.8,
          transparent: true,
          opacity: 0.9,
          roughness: 0.0,
          metalness: 0.0,
        });

      case "lash":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.05, 0.03, 0.02),
          roughness: 0.9,
          metalness: 0.0,
        });

      case "hair":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.18, 0.10, 0.06),
          roughness: 0.55,
          metalness: 0.0,
          emissive: new THREE.Color(0.08, 0.04, 0.02),
          emissiveIntensity: 0.15,
        });

      case "teeth":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.92, 0.9, 0.85),
          roughness: 0.2,
          metalness: 0.0,
          emissive: new THREE.Color(0.1, 0.1, 0.08),
          emissiveIntensity: 0.1,
        });

      case "tongue":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.75, 0.35, 0.35),
          roughness: 0.7,
          metalness: 0.0,
          emissive: new THREE.Color(0.1, 0.02, 0.02),
          emissiveIntensity: 0.15,
        });

      case "jacket":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.12, 0.14, 0.18),
          roughness: 0.85,
          metalness: 0.0,
          roughnessMap: this._createFabricMap(),
          emissive: new THREE.Color(0.02, 0.03, 0.05),
          emissiveIntensity: 0.1,
        });

      case "fabric":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.22, 0.20, 0.25),
          roughness: 0.80,
          metalness: 0.0,
          roughnessMap: this._createFabricMap(),
          emissive: new THREE.Color(0.03, 0.02, 0.04),
          emissiveIntensity: 0.08,
        });

      case "leather":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.15, 0.10, 0.07),
          roughness: 0.6,
          metalness: 0.05,
          roughnessMap: this._createLeatherMap(),
          emissive: new THREE.Color(0.03, 0.02, 0.01),
          emissiveIntensity: 0.1,
        });

      case "metal":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.7, 0.7, 0.72),
          roughness: 0.2,
          metalness: 0.9,
          roughnessMap: this._createGrimeMap(),
          emissive: new THREE.Color(0.05, 0.05, 0.06),
          emissiveIntensity: 0.05,
        });

      default:
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.5, 0.5, 0.5),
          roughness: 0.7,
          metalness: 0.0,
        });
    }
  }

  // ── Procedural texture generators ──

  _createSkinMap() {
    return this._proceduralTexture(512, (ctx, w, h) => {
      // Base warm tone
      ctx.fillStyle = "#c8a898";
      ctx.fillRect(0, 0, w, h);
      // Subtle warm/cool variation
      for (let s = 64; s >= 4; s = Math.floor(s / 2)) {
        ctx.globalAlpha = 0.08;
        for (let y = 0; y < h; y += s) {
          for (let x = 0; x < w; x += s) {
            const r = 160 + Math.floor(Math.random() * 40);
            const g = 130 + Math.floor(Math.random() * 30);
            const b = 110 + Math.floor(Math.random() * 30);
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x, y, s, s);
          }
        }
      }
      // Pore-like dots
      ctx.globalAlpha = 0.06;
      for (let i = 0; i < 800; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const r = 0.5 + Math.random() * 1.5;
        ctx.fillStyle = `rgba(100,70,60,0.4)`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  _createFabricMap() {
    return this._proceduralTexture(256, (ctx, w, h) => {
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, w, h);
      // Crosshatch weave pattern
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = "#606060";
      ctx.lineWidth = 1;
      for (let y = 0; y < h; y += 3) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y + (Math.random() - 0.5) * 2);
        ctx.stroke();
      }
      for (let x = 0; x < w; x += 3) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + (Math.random() - 0.5) * 2, h);
        ctx.stroke();
      }
      // Random variation
      ctx.globalAlpha = 0.1;
      for (let s = 32; s >= 4; s = Math.floor(s / 2)) {
        for (let y = 0; y < h; y += s) {
          for (let x = 0; x < w; x += s) {
            const v = 100 + Math.floor(Math.random() * 56);
            ctx.fillStyle = `rgb(${v},${v},${v})`;
            ctx.fillRect(x, y, s, s);
          }
        }
      }
    });
  }

  _createLeatherMap() {
    return this._proceduralTexture(256, (ctx, w, h) => {
      ctx.fillStyle = "#787070";
      ctx.fillRect(0, 0, w, h);
      // Irregular grain
      for (let s = 32; s >= 2; s = Math.floor(s / 2)) {
        ctx.globalAlpha = 0.12;
        for (let y = 0; y < h; y += s) {
          for (let x = 0; x < w; x += s) {
            const v = 90 + Math.floor(Math.random() * 50);
            ctx.fillStyle = `rgb(${v},${v},${v})`;
            ctx.fillRect(x, y, s, s);
          }
        }
      }
      // Creases
      ctx.globalAlpha = 0.2;
      for (let i = 0; i < 30; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const len = 10 + Math.random() * 40;
        ctx.strokeStyle = `rgba(50,45,40,0.5)`;
        ctx.lineWidth = 0.5 + Math.random() * 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (Math.random() - 0.5) * len, y + Math.random() * len * 0.3);
        ctx.stroke();
      }
    });
  }

  _createGrimeMap() {
    return this._proceduralTexture(256, (ctx, w, h) => {
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, w, h);
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
      // Scuff marks
      ctx.globalAlpha = 0.2;
      for (let i = 0; i < 15; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const r = 3 + Math.random() * 10;
        ctx.fillStyle = `rgba(30,30,30,0.3)`;
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
