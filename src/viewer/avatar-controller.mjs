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
    this._idleAction = null;
    if (clipsByName["ANI-ellie.idle"]) {
      this._idleAction = this.mixer.clipAction(clipsByName["ANI-ellie.idle"]);
      this._idleAction.setEffectiveWeight(1.0);
      this._idleAction.setLoop(THREE.LoopRepeat, Infinity);
      this._idleAction.play();
    }

    // Animate transition state machine
    // States: "idle" | "fade_to_idle" | "fade_to_target" | "holding"
    this._animState = "idle";
    this._animQueue = [];
    this._animCurrentAction = null;   // the action currently playing/fading
    this._animTargetAction = null;    // the action we're fading toward
    this._animTransitionT = 0;        // progress through current transition [0-1]
    this._animHoldTimer = 0;          // time remaining in hold phase
    this._animFadeDuration = 0.5;     // seconds per fade phase
    this._animHoldDuration = 2.0;     // seconds to hold each pose

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

    // Avatar animate command — sigmoid blend transitions via state machine.
    if (signal.type === "animate" && signal.clips) {
      // Cap queue at 3 — drop oldest if full to prevent endless buildup
      if (this._animQueue.length >= 3) this._animQueue.shift();
      this._animQueue.push(signal.clips);
      // Kick off transition if idle
      if (this._animState === "idle") {
        this._startNextTransition();
      }
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

  // Sigmoid smoothstep: slow start, fast middle, slow end
  _sigmoid(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  // Create and start an action from a clip dict { name: weight }
  // Returns the action with the highest target weight.
  _createAnimateAction(clips) {
    let bestAction = null;
    let bestWeight = 0;
    for (const [name, weight] of Object.entries(clips)) {
      const clip = this._clipsByName[name];
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      action.reset();
      action.setEffectiveWeight(0);
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
      action.play();
      action._targetWeight = weight;
      if (weight > bestWeight) { bestAction = action; bestWeight = weight; }
    }
    // Store all actions for this pose so we can weight them together
    if (bestAction) bestAction._poseClips = clips;
    return bestAction;
  }

  _startNextTransition() {
    if (this._animQueue.length === 0) {
      // Nothing queued — fade current back to idle, then stop
      this._animTargetAction = null;
      if (this._animState === "holding" && this._animCurrentAction) {
        this._animState = "fade_to_idle";
        this._animTransitionT = 0;
        if (this.debugEl) this.debugEl.textContent = "→ idle";
      } else {
        this._animState = "idle";
        if (this.debugEl) this.debugEl.textContent = "idle";
      }
      return;
    }

    const clips = this._animQueue.shift();
    const targetAction = this._createAnimateAction(clips);
    if (!targetAction) {
      this._startNextTransition();
      return;
    }
    this._animTargetAction = targetAction;

    if (this._animState === "idle") {
      // Directly fade idle → target
      this._animState = "fade_to_target";
      this._animTransitionT = 0;
    } else {
      // Fade current → idle first, then idle → target
      this._animState = "fade_to_idle";
      this._animTransitionT = 0;
    }

    if (this.debugEl) {
      this.debugEl.textContent = `→ ${Object.keys(clips).join(", ")}`;
    }
  }

  // Called every frame from animate() to drive the transition state machine
  _updateAnimTransition(dt) {
    if (this._animState === "idle") return;

    const step = dt / this._animFadeDuration;

    if (this._animState === "fade_to_idle") {
      // Blend current animate action → idle
      this._animTransitionT += step;
      const t = this._sigmoid(this._animTransitionT);
      if (this._animCurrentAction) {
        this._setActionWeights(this._animCurrentAction, 1 - t);
      }
      if (this._idleAction) {
        this._idleAction.setEffectiveWeight(t);
      }
      if (this._animTransitionT >= 1) {
        // Current fully faded, stop it
        if (this._animCurrentAction) {
          this._setActionWeights(this._animCurrentAction, 0);
        }
        if (this._idleAction) this._idleAction.setEffectiveWeight(1);
        this._animCurrentAction = null;
        // Fade to target if one exists, otherwise stay idle
        if (this._animTargetAction) {
          this._animState = "fade_to_target";
          this._animTransitionT = 0;
        } else {
          this._animState = "idle";
          this._animQueue = []; // clear any late-arriving stragglers
          if (this.debugEl) this.debugEl.textContent = "idle";
        }
      }

    } else if (this._animState === "fade_to_target") {
      // Blend idle → target animate action
      this._animTransitionT += step;
      const t = this._sigmoid(this._animTransitionT);
      if (this._idleAction) {
        this._idleAction.setEffectiveWeight(1 - t);
      }
      if (this._animTargetAction) {
        this._setActionWeights(this._animTargetAction, t);
      }
      if (this._animTransitionT >= 1) {
        // Target fully faded in
        if (this._idleAction) this._idleAction.setEffectiveWeight(0);
        if (this._animTargetAction) {
          this._setActionWeights(this._animTargetAction, 1);
        }
        this._animCurrentAction = this._animTargetAction;
        this._animTargetAction = null;
        this._animState = "holding";
        this._animHoldTimer = this._animHoldDuration;
      }

    } else if (this._animState === "holding") {
      this._animHoldTimer -= dt;
      if (this._animHoldTimer <= 0) {
        this._startNextTransition();
      }
    }
  }

  // Set weights for all clips in a pose action, scaled by blend factor
  _setActionWeights(action, blend) {
    if (action._poseClips) {
      for (const [name, weight] of Object.entries(action._poseClips)) {
        const clip = this._clipsByName[name];
        if (!clip) continue;
        const a = this.mixer.clipAction(clip);
        a.setEffectiveWeight(weight * blend);
      }
    } else {
      action.setEffectiveWeight(blend);
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

    // Drive animate transition state machine
    this._updateAnimTransition(dt);

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
          color: new THREE.Color(0.55, 0.42, 0.38),
          roughness: 0.95,
          metalness: 0.0,
          roughnessMap: this._createSkinMap(),
          emissive: new THREE.Color(0.0, 0.03, 0.06),
          emissiveIntensity: 0.15,
        });

      case "eye":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.08, 0.08, 0.1),
          roughness: 0.3,
          metalness: 0.0,
          emissive: new THREE.Color(0.15, 0.15, 0.2),
          emissiveIntensity: 0.4,
        });

      case "iris":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.0, 0.15, 0.2),
          roughness: 0.2,
          metalness: 0.0,
          emissive: new THREE.Color(0.0, 0.8, 1.0),
          emissiveIntensity: 0.6,
        });

      case "eye_highlight":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(1.0, 1.0, 1.0),
          emissive: new THREE.Color(0.5, 0.9, 1.0),
          emissiveIntensity: 1.2,
          transparent: true,
          opacity: 0.9,
          roughness: 0.0,
          metalness: 0.0,
        });

      case "lash":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.02, 0.02, 0.03),
          roughness: 1.0,
          metalness: 0.0,
        });

      case "hair":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.05, 0.03, 0.08),
          roughness: 0.85,
          metalness: 0.0,
          emissive: new THREE.Color(0.15, 0.0, 0.3),
          emissiveIntensity: 0.2,
        });

      case "teeth":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.85, 0.85, 0.9),
          roughness: 0.5,
          metalness: 0.0,
          emissive: new THREE.Color(0.05, 0.05, 0.1),
          emissiveIntensity: 0.1,
        });

      case "tongue":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.5, 0.2, 0.25),
          roughness: 0.9,
          metalness: 0.0,
          emissive: new THREE.Color(0.08, 0.01, 0.02),
          emissiveIntensity: 0.1,
        });

      case "jacket":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.06, 0.06, 0.1),
          roughness: 0.92,
          metalness: 0.0,
          roughnessMap: this._createFabricMap(),
          emissiveMap: this._createCircuitMap(),
          emissive: new THREE.Color(0.0, 0.6, 0.8),
          emissiveIntensity: 0.25,
        });

      case "fabric":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.08, 0.06, 0.12),
          roughness: 0.92,
          metalness: 0.0,
          roughnessMap: this._createFabricMap(),
          emissive: new THREE.Color(0.2, 0.0, 0.4),
          emissiveIntensity: 0.12,
        });

      case "leather":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.06, 0.05, 0.08),
          roughness: 0.8,
          metalness: 0.0,
          roughnessMap: this._createLeatherMap(),
          emissive: new THREE.Color(0.0, 0.15, 0.2),
          emissiveIntensity: 0.15,
        });

      case "metal":
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.3, 0.32, 0.35),
          roughness: 0.45,
          metalness: 0.7,
          roughnessMap: this._createGrimeMap(),
          emissive: new THREE.Color(0.0, 0.5, 0.6),
          emissiveIntensity: 0.15,
        });

      default:
        return new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.1, 0.1, 0.15),
          roughness: 0.9,
          metalness: 0.0,
          emissive: new THREE.Color(0.0, 0.1, 0.15),
          emissiveIntensity: 0.1,
        });
    }
  }

  // ── Procedural texture generators ──

  _createSkinMap() {
    return this._proceduralTexture(512, (ctx, w, h) => {
      // Cool-toned base
      ctx.fillStyle = "#8a7878";
      ctx.fillRect(0, 0, w, h);
      // Subtle cool variation
      for (let s = 64; s >= 4; s = Math.floor(s / 2)) {
        ctx.globalAlpha = 0.08;
        for (let y = 0; y < h; y += s) {
          for (let x = 0; x < w; x += s) {
            const r = 110 + Math.floor(Math.random() * 30);
            const g = 105 + Math.floor(Math.random() * 25);
            const b = 115 + Math.floor(Math.random() * 35);
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(x, y, s, s);
          }
        }
      }
      // Pore-like dots
      ctx.globalAlpha = 0.05;
      for (let i = 0; i < 600; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const r = 0.5 + Math.random() * 1.5;
        ctx.fillStyle = `rgba(60,70,90,0.4)`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Faint circuit traces under the skin
      ctx.globalAlpha = 0.04;
      ctx.strokeStyle = "#40c0d0";
      ctx.lineWidth = 0.5;
      for (let i = 0; i < 15; i++) {
        let x = Math.random() * w;
        let y = Math.random() * h;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let j = 0; j < 5; j++) {
          if (Math.random() > 0.5) x += 10 + Math.random() * 30;
          else y += 10 + Math.random() * 30;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    });
  }

  _createCircuitMap() {
    return this._proceduralTexture(512, (ctx, w, h) => {
      // Black base — only the circuit lines glow
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);
      // Circuit traces
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      for (let i = 0; i < 25; i++) {
        let x = Math.random() * w;
        let y = Math.random() * h;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let j = 0; j < 4 + Math.floor(Math.random() * 4); j++) {
          // Right-angle turns like PCB traces
          if (Math.random() > 0.5) x += (Math.random() > 0.5 ? 1 : -1) * (15 + Math.random() * 40);
          else y += (Math.random() > 0.5 ? 1 : -1) * (15 + Math.random() * 40);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // Junction nodes
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "#ffffff";
      for (let i = 0; i < 30; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.beginPath();
        ctx.arc(x, y, 1.5 + Math.random() * 2, 0, Math.PI * 2);
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
