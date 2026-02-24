/**
 * Avatar controller — loads Ellie GLB, plays idle animation, and drives
 * face/mouth/eye animations from LFS signals via clip action weights.
 * Bone matrix override (monkey-patched skeleton.update) remains available
 * for direct bone control if needed.
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

    // Override state — written each frame, read by monkey-patched skeleton.update
    this._boneOverride = null; // {matrix: Matrix4} or null

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
      if (!SIGNAL_CLIPS.has(name)) {
        console.log(`Skipping clip "${name}" (not used by signal mapper)`);
        continue;
      }
      // Strip bone transform tracks — only keep morph targets.
      // Face clips contain bone tracks for ALL bones (arms, legs, etc.)
      // which pull the body toward T-pose. Morph targets only affect face geometry.
      const safeClip = clip.clone();
      safeClip.tracks = safeClip.tracks.filter((track) => {
        const prop = track.name.split(".").pop();
        const keep = prop === "morphTargetInfluences";
        if (!keep) console.log(`  Stripped track "${track.name}" from "${name}"`);
        return keep;
      });
      if (safeClip.tracks.length === 0) {
        console.log(`Clip "${name}" has no safe tracks — skipping`);
        continue;
      }
      const action = this.mixer.clipAction(safeClip);
      action.setEffectiveWeight(0);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      this._actions[name] = action;
    }
    this._targetWeights = {};

    console.log("Animation clips registered:", Object.keys(this._actions).join(", "));

    // === Survey all meshes, hide static ones, apply cyberpunk materials ===
    console.log("=== MESH SURVEY ===");
    const allMeshes = [];
    const cyberMats = this._createCyberpunkMaterials();

    gltf.scene.traverse((obj) => {
      if (obj.isMesh) {
        allMeshes.push(obj);
        obj.geometry.computeBoundingBox();
        const bb = obj.geometry.boundingBox;
        const kind = obj.isSkinnedMesh ? "SKINNED" : "STATIC";
        console.log(`${kind} "${obj.name}" ` +
          `verts: ${obj.geometry.attributes.position.count}, ` +
          `bounds Y: [${bb.min.y.toFixed(2)}, ${bb.max.y.toFixed(2)}]`);

        if (!obj.isSkinnedMesh) {
          obj.visible = false;
          console.log(`  → hidden (static mesh)`);
        } else {
          // Apply cyberpunk material based on mesh region
          const name = obj.name.toLowerCase();
          const midY = (bb.min.y + bb.max.y) / 2;
          if (name.includes("hair") || name.includes("pony")) {
            obj.material = cyberMats.hair;
          } else if (name.includes("eye")) {
            obj.material = cyberMats.eyes;
          } else if (midY > 1.2) {
            // Head region
            obj.material = cyberMats.skin;
          } else if (midY > 0.6) {
            // Torso
            obj.material = cyberMats.jacket;
          } else {
            // Lower body / limbs
            obj.material = cyberMats.pants;
          }
          console.log(`  → cyberpunk material applied`);
        }
      }
    });

    // === Find DEF-Head in each skinned mesh ===
    let targetMesh = null;
    let targetBoneIndex = -1;

    for (const mesh of allMeshes) {
      if (!mesh.isSkinnedMesh) continue;
      const bones = mesh.skeleton.bones;
      for (let i = 0; i < bones.length; i++) {
        if (bones[i].name === "DEF-Head") {
          targetMesh = mesh;
          targetBoneIndex = i;
          console.log(`DEF-Head found in "${mesh.name}" skeleton at index ${i}`);
          break;
        }
      }
      if (targetMesh) break;
    }

    if (!targetMesh) {
      console.error("DEF-Head NOT FOUND! Listing head bones:");
      for (const mesh of allMeshes) {
        if (!mesh.isSkinnedMesh) continue;
        for (let i = 0; i < mesh.skeleton.bones.length; i++) {
          if (mesh.skeleton.bones[i].name.toLowerCase().includes("head")) {
            console.log(`  ${mesh.name}[${i}]: ${mesh.skeleton.bones[i].name}`);
          }
        }
      }
      return [];
    }

    // === Verify skin weights reference this bone ===
    const skinIndex = targetMesh.geometry.attributes.skinIndex;
    const skinWeight = targetMesh.geometry.attributes.skinWeight;
    let vertsBound = 0;
    if (skinIndex && skinWeight) {
      const count = skinIndex.count;
      for (let v = 0; v < count; v++) {
        for (let c = 0; c < skinIndex.itemSize; c++) {
          const idx = skinIndex.array[v * skinIndex.itemSize + c];
          const wt = skinWeight.array[v * skinWeight.itemSize + c];
          if (idx === targetBoneIndex && wt > 0.01) {
            vertsBound++;
            break;
          }
        }
      }
      console.log(`Vertices bound to DEF-Head (bone ${targetBoneIndex}): ${vertsBound} / ${count}`);
    }

    // === Monkey-patch skeleton.update ===
    const skeleton = targetMesh.skeleton;
    const origUpdate = skeleton.update.bind(skeleton);
    const self = this;
    const boneIdx = targetBoneIndex;

    skeleton.update = function () {
      origUpdate();

      // Apply our override AFTER normal computation
      const override = self._boneOverride;
      if (override) {
        override.matrix.toArray(this.boneMatrices, boneIdx * 16);
        if (this.boneTexture) {
          this.boneTexture.needsUpdate = true;
        }
      }
    };

    // Save the rest-pose bone matrix (right after first skeleton.update)
    skeleton.update();
    this._restBoneMatrix = new THREE.Matrix4();
    this._restBoneMatrix.fromArray(skeleton.boneMatrices, targetBoneIndex * 16);
    console.log("Rest bone matrix diagonal:",
      [0, 5, 10, 15].map(i => skeleton.boneMatrices[targetBoneIndex * 16 + i].toFixed(4)));

    this._targetMesh = targetMesh;
    this._targetBoneIndex = targetBoneIndex;

    console.log("=== Avatar loaded — waiting for LFS signals ===");
    return [];
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

  _createCyberpunkMaterials() {
    return {
      skin: new THREE.MeshPhysicalMaterial({
        color: 0x1a1a2e,
        emissive: 0x0d0d1a,
        emissiveMap: this._proceduralTexture(512, (ctx, w, h) => {
          // Circuit-trace skin pattern
          ctx.fillStyle = "#0a0a18";
          ctx.fillRect(0, 0, w, h);
          ctx.strokeStyle = "#00ffff";
          ctx.lineWidth = 0.5;
          ctx.globalAlpha = 0.15;
          for (let y = 0; y < h; y += 16) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            for (let x = 0; x < w; x += 8) {
              ctx.lineTo(x, y + (Math.random() - 0.5) * 4);
            }
            ctx.stroke();
          }
          // Neon vein highlights
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = "#ff00ff";
          ctx.lineWidth = 1;
          for (let i = 0; i < 8; i++) {
            ctx.beginPath();
            let x = Math.random() * w, y = Math.random() * h;
            ctx.moveTo(x, y);
            for (let j = 0; j < 6; j++) {
              x += (Math.random() - 0.5) * 80;
              y += Math.random() * 60;
              ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }),
        emissiveIntensity: 0.8,
        metalness: 0.3,
        roughness: 0.6,
        clearcoat: 0.4,
      }),

      hair: new THREE.MeshPhysicalMaterial({
        color: 0x0a0a1a,
        emissive: 0xff00ff,
        emissiveMap: this._proceduralTexture(256, (ctx, w, h) => {
          // Glowing fiber strands
          ctx.fillStyle = "#000008";
          ctx.fillRect(0, 0, w, h);
          for (let i = 0; i < 200; i++) {
            const x = Math.random() * w;
            const bright = Math.random();
            ctx.strokeStyle = bright > 0.7
              ? `rgba(255,0,255,${0.3 + bright * 0.5})`
              : `rgba(0,255,255,${0.1 + bright * 0.2})`;
            ctx.lineWidth = 0.5 + Math.random();
            ctx.beginPath();
            ctx.moveTo(x, 0);
            let cx = x;
            for (let y = 0; y < h; y += 10) {
              cx += (Math.random() - 0.5) * 6;
              ctx.lineTo(cx, y);
            }
            ctx.stroke();
          }
        }),
        emissiveIntensity: 1.2,
        metalness: 0.7,
        roughness: 0.3,
        sheen: 1.0,
        sheenColor: new THREE.Color(0x00ffff),
      }),

      eyes: new THREE.MeshPhysicalMaterial({
        color: 0x000000,
        emissive: 0x00ffff,
        emissiveIntensity: 2.0,
        metalness: 1.0,
        roughness: 0.0,
        clearcoat: 1.0,
      }),

      jacket: new THREE.MeshPhysicalMaterial({
        color: 0x0f0f1f,
        emissiveMap: this._proceduralTexture(512, (ctx, w, h) => {
          // Tech-jacket: grid + circuit board
          ctx.fillStyle = "#080818";
          ctx.fillRect(0, 0, w, h);
          // Grid lines
          ctx.strokeStyle = "#00ffff";
          ctx.lineWidth = 0.5;
          ctx.globalAlpha = 0.12;
          for (let x = 0; x < w; x += 32) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
          }
          for (let y = 0; y < h; y += 32) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
          }
          // Circuit nodes
          ctx.globalAlpha = 0.6;
          ctx.fillStyle = "#ff00ff";
          for (let i = 0; i < 30; i++) {
            const x = Math.round(Math.random() * (w / 32)) * 32;
            const y = Math.round(Math.random() * (h / 32)) * 32;
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
            // Trace from node
            ctx.strokeStyle = "#ff00ff";
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.3;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + (Math.random() > 0.5 ? 32 : 0), y + (Math.random() > 0.5 ? 32 : 0));
            ctx.stroke();
          }
          // Neon accent stripe
          ctx.globalAlpha = 0.8;
          const grd = ctx.createLinearGradient(0, h * 0.4, 0, h * 0.45);
          grd.addColorStop(0, "transparent");
          grd.addColorStop(0.5, "#ff00ff");
          grd.addColorStop(1, "transparent");
          ctx.fillStyle = grd;
          ctx.fillRect(0, h * 0.4, w, h * 0.05);
        }),
        emissive: 0xffffff,
        emissiveIntensity: 0.5,
        metalness: 0.5,
        roughness: 0.4,
        clearcoat: 0.3,
      }),

      pants: new THREE.MeshPhysicalMaterial({
        color: 0x0a0a1a,
        emissiveMap: this._proceduralTexture(256, (ctx, w, h) => {
          // Dark tech-pants with scanlines
          ctx.fillStyle = "#050510";
          ctx.fillRect(0, 0, w, h);
          ctx.globalAlpha = 0.08;
          ctx.fillStyle = "#00ffff";
          for (let y = 0; y < h; y += 4) {
            ctx.fillRect(0, y, w, 1);
          }
          // Side stripe
          ctx.globalAlpha = 0.5;
          const grd = ctx.createLinearGradient(w * 0.85, 0, w * 0.9, 0);
          grd.addColorStop(0, "transparent");
          grd.addColorStop(0.5, "#ff00ff");
          grd.addColorStop(1, "transparent");
          ctx.fillStyle = grd;
          ctx.fillRect(w * 0.85, 0, w * 0.05, h);
        }),
        emissive: 0xffffff,
        emissiveIntensity: 0.3,
        metalness: 0.4,
        roughness: 0.5,
      }),
    };
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
