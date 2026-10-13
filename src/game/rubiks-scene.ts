import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  FACE_MOVES,
  MOVE_SPECS,
  getMoveAngle,
  getMoveFace,
  isInnerMove,
  isWideMove,
  type FaceMove,
  type MoveToken,
} from "../domain/moves";

const CUBELET_SIZE = 0.92;
const CUBELET_SPACING = 1.04;
const STICKER_SIZE = 0.68;
const STICKER_DEPTH = 0.035;
const POINTER_TURN_THRESHOLD = 18;
const DEFAULT_MOVE_DURATION = 260;

export type CubeSize = 3 | 5;

interface Cubelet {
  id: string;
  group: THREE.Group;
  stickers: THREE.Mesh[];
}

interface ActiveMove {
  axis: "x" | "y" | "z";
  finalAngle: number;
  duration: number;
  elapsed: number;
  selected: Cubelet[];
  resolve: () => void;
}

interface TurnPointerState {
  mode: "turn";
  pointerId: number;
  startX: number;
  startY: number;
  startLocalPoint: THREE.Vector3;
  cubelet: Cubelet;
  grabbedAxis: "x" | "y" | "z";
  consumed: boolean;
}

interface OrbitPointerState {
  mode: "orbit";
  pointerId: number;
  lastX: number;
  lastY: number;
}

type PointerState = TurnPointerState | OrbitPointerState | null;

export interface FaceletTarget {
  face: FaceMove;
  index: number;
}

export interface RubiksSceneOptions {
  cubeSize?: CubeSize;
  onUserMove?: (move: MoveToken) => void;
  onMessage?: (message: string) => void;
  isMoveAllowed?: (move: MoveToken) => boolean;
}

export class RubiksScene {
  private readonly container: HTMLElement;
  private readonly options: RubiksSceneOptions;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly mainGroup = new THREE.Group();
  private readonly movePivot = new THREE.Group();
  private readonly cubelets: Cubelet[] = [];
  private readonly hitTargets: THREE.Object3D[] = [];
  private readonly bodyGeometry = new RoundedBoxGeometry(CUBELET_SIZE, CUBELET_SIZE, CUBELET_SIZE, 5, 0.09);
  private readonly stickerGeometry = new RoundedBoxGeometry(STICKER_SIZE, STICKER_SIZE, STICKER_DEPTH, 4, 0.055);
  private readonly bodyMaterial = new THREE.MeshStandardMaterial({
    color: "#20242c",
    roughness: 0.72,
    metalness: 0.04,
  });

  private pointerState: PointerState = null;
  private activeMove: ActiveMove | null = null;
  private inputEnabled = true;
  private rafId = 0;
  private lastFrameTime = performance.now();
  private highlightedStickers: THREE.Mesh[] = [];
  private cubeSize: CubeSize;

  constructor(container: HTMLElement, options: RubiksSceneOptions = {}) {
    this.container = container;
    this.options = options;
    this.cubeSize = options.cubeSize ?? 3;

    this.camera.position.set(4.8, 4.4, 6.2);
    this.camera.lookAt(0, 0, 0);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "cube-canvas";
    this.container.appendChild(this.renderer.domElement);

    this.mainGroup.rotation.set(-0.33, -0.58, 0.08);
    this.mainGroup.add(this.movePivot);
    this.scene.add(this.mainGroup);

    this.addLights();
    this.addEnvironment();
    this.createCube();
    this.bindEvents();
    this.resize();
    this.start();
  }

  reset(): void {
    this.clearHighlight();
    this.activeMove = null;
    for (const cubelet of this.cubelets) {
      this.mainGroup.remove(cubelet.group);
    }
    this.cubelets.length = 0;
    this.hitTargets.length = 0;
    this.movePivot.rotation.set(0, 0, 0);
    this.createCube();
    this.resize();
  }

  setCubeSize(size: CubeSize): void {
    if (this.cubeSize === size) return;
    this.cubeSize = size;
    this.reset();
  }

  getCubeSize(): CubeSize {
    return this.cubeSize;
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.resize);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.handlePointerDown);
    canvas.removeEventListener("pointermove", this.handlePointerMove);
    canvas.removeEventListener("pointerup", this.handlePointerUp);
    canvas.removeEventListener("pointercancel", this.handlePointerUp);
    canvas.removeEventListener("wheel", this.handleWheel);
    this.bodyGeometry.dispose();
    this.stickerGeometry.dispose();
    this.bodyMaterial.dispose();
    this.renderer.dispose();
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
  }

  isBusy(): boolean {
    return this.activeMove !== null;
  }

  getFaceletString(): string {
    const faceletCount = this.cubeSize * this.cubeSize;
    const faces: Record<FaceMove, string[]> = {
      U: Array(faceletCount).fill("U"),
      R: Array(faceletCount).fill("R"),
      F: Array(faceletCount).fill("F"),
      D: Array(faceletCount).fill("D"),
      L: Array(faceletCount).fill("L"),
      B: Array(faceletCount).fill("B"),
    };

    for (const cubelet of this.cubelets) {
      for (const sticker of cubelet.stickers) {
        const color = sticker.userData.face as FaceMove;
        const placement = this.getStickerPlacement(sticker);
        if (!placement) continue;
        faces[placement.face][placement.index] = color;
      }
    }

    return [...faces.U, ...faces.R, ...faces.F, ...faces.D, ...faces.L, ...faces.B].join("");
  }

  setFaceletString(raw: string): void {
    const faceletCount = this.cubeSize * this.cubeSize;
    if (raw.length !== FACE_MOVES.length * faceletCount) {
      throw new Error(`Expected ${FACE_MOVES.length * faceletCount} facelets, got ${raw.length}`);
    }

    this.clearHighlight();
    for (const cubelet of this.cubelets) {
      for (const sticker of cubelet.stickers) {
        const placement = this.getStickerPlacement(sticker);
        if (!placement) continue;
        const stickerFace = raw[FACE_MOVES.indexOf(placement.face) * faceletCount + placement.index] as FaceMove;
        sticker.userData.face = stickerFace;
        const material = sticker.material as THREE.MeshStandardMaterial;
        material.color.set(MOVE_SPECS[stickerFace].color);
        material.emissive.set("#000000");
        material.emissiveIntensity = 0;
      }
    }
  }

  isSolved(): boolean {
    const faceletCount = this.cubeSize * this.cubeSize;
    return this.getFaceletString() === FACE_MOVES.map((face) => face.repeat(faceletCount)).join("");
  }

  highlightMove(move: MoveToken | null): void {
    this.clearHighlight();
    if (!move) return;
    const selected = this.getMoveCubelets(move);
    this.highlightStickers(selected.flatMap((cubelet) => cubelet.stickers));
  }

  highlightFaces(faces: FaceMove[]): void {
    this.clearHighlight();
    const faceSet = new Set(faces);
    const stickers = this.cubelets.flatMap((cubelet) =>
      cubelet.stickers.filter((sticker) => faceSet.has(sticker.userData.face as FaceMove))
    );
    this.highlightStickers(stickers);
  }

  highlightFacelets(targets: readonly FaceletTarget[]): void {
    this.clearHighlight();
    const targetKeys = new Set(targets.map((target) => `${target.face}:${target.index}`));
    const stickers = this.cubelets.flatMap((cubelet) =>
      cubelet.stickers.filter((sticker) => {
        const placement = this.getStickerPlacement(sticker);
        return placement ? targetKeys.has(`${placement.face}:${placement.index}`) : false;
      })
    );
    this.highlightStickers(stickers);
  }

  getFaceletScreenPoint(face: FaceMove, index: number): { x: number; y: number } | null {
    for (const cubelet of this.cubelets) {
      for (const sticker of cubelet.stickers) {
        const placement = this.getStickerPlacement(sticker);
        if (!placement || placement.face !== face || placement.index !== index) continue;
        const world = new THREE.Vector3();
        sticker.getWorldPosition(world);
        const screen = this.worldToScreen(world);
        return { x: screen.x, y: screen.y };
      }
    }
    return null;
  }

  async applyAlgorithm(moves: readonly MoveToken[], duration = DEFAULT_MOVE_DURATION): Promise<void> {
    for (const move of moves) {
      await this.applyMove(move, duration);
    }
  }

  applyMove(move: MoveToken, duration = DEFAULT_MOVE_DURATION): Promise<void> {
    if (this.activeMove) return Promise.resolve();

    const spec = MOVE_SPECS[getMoveFace(move)];
    const selected = this.getMoveCubelets(move);
    const finalAngle = getMoveAngle(move);
    this.clearHighlight();

    if (duration <= 0) {
      this.performInstantMove(spec.axis, selected, finalAngle);
      return Promise.resolve();
    }

    selected.forEach((cubelet) => this.movePivot.attach(cubelet.group));
    this.movePivot.rotation.set(0, 0, 0);

    return new Promise((resolve) => {
      this.activeMove = {
        axis: spec.axis,
        finalAngle,
        duration,
        elapsed: 0,
        selected,
        resolve,
      };
    });
  }

  private start(): void {
    const tick = (): void => {
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      const delta = Math.min((now - this.lastFrameTime) / 1000, 0.05);
      this.lastFrameTime = now;
      this.updateActiveMove(delta);
      this.updateHighlightPulse();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  private addLights(): void {
    const hemi = new THREE.HemisphereLight("#ffffff", "#9dc9c0", 2.8);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight("#ffffff", 3.8);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key);

    const rim = new THREE.PointLight("#ffb347", 2.2, 16);
    rim.position.set(-4, 2, 4);
    this.scene.add(rim);
  }

  private addEnvironment(): void {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4.6, 64),
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        roughness: 0.86,
        metalness: 0,
        transparent: true,
        opacity: 0.35,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.82;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  private createCube(): void {
    let id = 0;
    const max = this.maxLayer;
    for (let x = -max; x <= max; x += 1) {
      for (let y = -max; y <= max; y += 1) {
        for (let z = -max; z <= max; z += 1) {
          if (Math.abs(x) < max && Math.abs(y) < max && Math.abs(z) < max) continue;
          this.createCubelet(x, y, z, `cubelet-${id}`);
          id += 1;
        }
      }
    }
  }

  private createCubelet(x: number, y: number, z: number, id: string): void {
    const group = new THREE.Group();
    group.position.set(x * CUBELET_SPACING, y * CUBELET_SPACING, z * CUBELET_SPACING);

    const body = new THREE.Mesh(this.bodyGeometry, this.bodyMaterial);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const cubelet: Cubelet = { id, group, stickers: [] };
    body.userData.cubelet = cubelet;
    this.hitTargets.push(body);

    const max = this.maxLayer;
    if (x === max) this.addSticker(cubelet, "R", new THREE.Vector3(CUBELET_SIZE / 2 + 0.024, 0, 0), new THREE.Euler(0, Math.PI / 2, 0));
    if (x === -max) this.addSticker(cubelet, "L", new THREE.Vector3(-CUBELET_SIZE / 2 - 0.024, 0, 0), new THREE.Euler(0, -Math.PI / 2, 0));
    if (y === max) this.addSticker(cubelet, "U", new THREE.Vector3(0, CUBELET_SIZE / 2 + 0.024, 0), new THREE.Euler(-Math.PI / 2, 0, 0));
    if (y === -max) this.addSticker(cubelet, "D", new THREE.Vector3(0, -CUBELET_SIZE / 2 - 0.024, 0), new THREE.Euler(Math.PI / 2, 0, 0));
    if (z === max) this.addSticker(cubelet, "F", new THREE.Vector3(0, 0, CUBELET_SIZE / 2 + 0.024), new THREE.Euler(0, 0, 0));
    if (z === -max) this.addSticker(cubelet, "B", new THREE.Vector3(0, 0, -CUBELET_SIZE / 2 - 0.024), new THREE.Euler(0, Math.PI, 0));

    this.cubelets.push(cubelet);
    this.mainGroup.add(group);
  }

  private addSticker(cubelet: Cubelet, face: FaceMove, position: THREE.Vector3, rotation: THREE.Euler): void {
    const material = new THREE.MeshStandardMaterial({
      color: MOVE_SPECS[face].color,
      roughness: 0.48,
      metalness: 0.02,
      emissive: "#000000",
      emissiveIntensity: 0,
    });
    const sticker = new THREE.Mesh(this.stickerGeometry, material);
    sticker.position.copy(position);
    sticker.rotation.copy(rotation);
    sticker.castShadow = true;
    sticker.userData.cubelet = cubelet;
    sticker.userData.face = face;
    cubelet.group.add(sticker);
    cubelet.stickers.push(sticker);
    this.hitTargets.push(sticker);
  }

  private bindEvents(): void {
    const canvas = this.renderer.domElement;
    window.addEventListener("resize", this.resize, { passive: true });
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointercancel", this.handlePointerUp);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  private readonly resize = (): void => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const narrow = width < 620;
    const landscapeCompact = width > height && height < 680;
    const sizeFactor = this.cubeSize === 5 ? 0.62 : 1;

    const scale = (narrow ? 0.68 : landscapeCompact ? 0.72 : 0.84) * sizeFactor;
    this.mainGroup.scale.setScalar(scale);
    this.mainGroup.position.y = narrow ? 0.9 : 0.36;
    this.camera.position.z = (narrow ? 7.9 : landscapeCompact ? 7.2 : 6.6) + (this.cubeSize === 5 ? 1.8 : 0);
    this.camera.lookAt(0, 0.08, 0);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.inputEnabled || this.activeMove) return;
    event.preventDefault();
    this.renderer.domElement.setPointerCapture(event.pointerId);

    const hit = this.pickCubelet(event.clientX, event.clientY);
    if (hit) {
      const startLocalPoint = this.mainGroup.worldToLocal(hit.point.clone());
      this.pointerState = {
        mode: "turn",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLocalPoint,
        cubelet: hit.cubelet,
        grabbedAxis: this.dominantAxis(startLocalPoint),
        consumed: false,
      };
      return;
    }

    this.pointerState = {
      mode: "orbit",
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    };
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const state = this.pointerState;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();

    if (state.mode === "orbit") {
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      this.mainGroup.rotation.y += dx * 0.006;
      this.mainGroup.rotation.x = THREE.MathUtils.clamp(this.mainGroup.rotation.x + dy * 0.004, -1.15, 0.65);
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      return;
    }

    if (state.consumed || this.activeMove) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    const distance = Math.hypot(dx, dy);
    if (distance < POINTER_TURN_THRESHOLD) return;

    const move = this.chooseGestureMove(state, new THREE.Vector2(dx, dy));
    if (!move) {
      this.options.onMessage?.("換個角度拖曳這一層");
      return;
    }

    state.consumed = true;
    this.applyMove(move).then(() => {
      this.options.onUserMove?.(move);
    });
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.pointerState?.pointerId === event.pointerId) {
      this.pointerState = null;
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z + event.deltaY * 0.004, 4.6, 8.5);
    this.camera.lookAt(0, 0, 0);
  };

  private pickCubelet(clientX: number, clientY: number): { cubelet: Cubelet; point: THREE.Vector3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = this.raycaster.intersectObjects(this.hitTargets, false);
    const first = hits.find((hit) => hit.object.userData.cubelet);
    if (!first) return null;

    return {
      cubelet: first.object.userData.cubelet as Cubelet,
      point: first.point,
    };
  }

  // 把拖曳向量反投影回「被按住的那個面」的平面上，直接在方塊座標系裡
  // 判斷要轉哪一條行/列與方向。這樣判斷不受相機角度影響，
  // 也不會發生輪廓邊緣貼紙的投影方向反轉問題。
  // 繞被按面法線的旋轉（例如按著 F 面轉 F）一律由相鄰面的拖曳觸發。
  private chooseGestureMove(state: TurnPointerState, delta: THREE.Vector2): MoveToken | null {
    const normalAxis = state.grabbedAxis;
    const planeValue = state.startLocalPoint[normalAxis];
    const currentOnPlane = this.unprojectToLocalPlane(
      state.startX + delta.x,
      state.startY + delta.y,
      normalAxis,
      planeValue
    );
    if (!currentOnPlane) return null;

    const dragLocal = currentOnPlane.sub(state.startLocalPoint);
    dragLocal[normalAxis] = 0;
    if (dragLocal.lengthSq() < 1e-6) return null;
    // 手指在面上的位移不可能超過一整個面寬；更大的值代表視線幾乎
    // 平行面時的畸形反投影，先不判斷，等下一個 pointermove。
    if (dragLocal.lengthSq() > 36) return null;

    // 拖曳方向必須明顯偏向所選的行或列，避免把「無法轉的方向」
    //（例如 5x5 的正中間切片）誤判成幾乎垂直的另一條切片。
    const minAlignment = dragLocal.length() * 0.45;
    const coord = this.getDiscreteCoord(state.cubelet);
    let best: { move: MoveToken; alignment: number } | null = null;

    for (const axis of ["x", "y", "z"] as const) {
      if (axis === normalAxis) continue;
      // 繞 axis 正向旋轉時，此格貼紙在面平面上的移動方向
      const rotationDir = this.axisVector(axis).cross(state.startLocalPoint);
      rotationDir[normalAxis] = 0;
      if (rotationDir.lengthSq() < 1e-6) continue;
      rotationDir.normalize();

      const alignment = dragLocal.dot(rotationDir);
      const move = this.moveForAxisRotation(axis, coord[axis], alignment > 0 ? 1 : -1);
      if (!move || Math.abs(alignment) < minAlignment) continue;
      if (this.options.isMoveAllowed && !this.options.isMoveAllowed(move)) continue;
      if (!best || Math.abs(alignment) > Math.abs(best.alignment)) {
        best = { move, alignment };
      }
    }

    return best?.move ?? null;
  }

  private moveForAxisRotation(axis: "x" | "y" | "z", coordOnAxis: number, rotationSign: 1 | -1): MoveToken | null {
    const face = FACE_MOVES.find(
      (candidate) => MOVE_SPECS[candidate].axis === axis && MOVE_SPECS[candidate].layer === Math.sign(coordOnAxis)
    );
    if (!face) return null;

    const spec = MOVE_SPECS[face];
    const depth = Math.abs(coordOnAxis);
    let base: string;
    if (depth === this.maxLayer) {
      base = face;
    } else if (this.cubeSize === 5 && depth === this.maxLayer - 1) {
      base = `2${face}`;
    } else {
      return null;
    }

    return (Math.sign(spec.angle) === rotationSign ? base : `${base}'`) as MoveToken;
  }

  private unprojectToLocalPlane(
    clientX: number,
    clientY: number,
    axis: "x" | "y" | "z",
    value: number
  ): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const ray = this.raycaster.ray.clone();
    ray.applyMatrix4(this.mainGroup.matrixWorld.clone().invert());

    const direction = ray.direction[axis];
    if (Math.abs(direction) < 1e-6) return null;
    const t = (value - ray.origin[axis]) / direction;
    if (t <= 0) return null;
    return ray.origin.clone().addScaledVector(ray.direction, t);
  }

  private updateActiveMove(delta: number): void {
    const move = this.activeMove;
    if (!move) return;

    move.elapsed += delta * 1000;
    const progress = Math.min(1, move.elapsed / move.duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    this.movePivot.rotation[move.axis] = move.finalAngle * eased;

    if (progress >= 1) {
      this.finishActiveMove(move);
    }
  }

  private finishActiveMove(move: ActiveMove): void {
    this.movePivot.rotation[move.axis] = move.finalAngle;
    move.selected.forEach((cubelet) => {
      this.mainGroup.attach(cubelet.group);
      this.snapCubeletPosition(cubelet);
    });
    this.movePivot.rotation.set(0, 0, 0);
    this.activeMove = null;
    move.resolve();
  }

  private performInstantMove(axis: "x" | "y" | "z", selected: Cubelet[], angle: number): void {
    this.movePivot.rotation.set(0, 0, 0);
    selected.forEach((cubelet) => this.movePivot.attach(cubelet.group));
    this.movePivot.rotation[axis] = angle;
    selected.forEach((cubelet) => {
      this.mainGroup.attach(cubelet.group);
      this.snapCubeletPosition(cubelet);
    });
    this.movePivot.rotation.set(0, 0, 0);
  }

  private getMoveCubelets(move: MoveToken): Cubelet[] {
    const spec = MOVE_SPECS[getMoveFace(move)];
    const layers = this.getMoveLayers(move);
    return this.cubelets.filter((cubelet) => layers.has(this.getDiscreteCoord(cubelet)[spec.axis]));
  }

  private getMoveLayers(move: MoveToken): Set<number> {
    const spec = MOVE_SPECS[getMoveFace(move)];
    if (isInnerMove(move) && this.cubeSize === 5) {
      return new Set([spec.layer * (this.maxLayer - 1)]);
    }

    const layers = new Set([this.outerLayerValue(spec.layer)]);
    if (isWideMove(move) && this.cubeSize === 5) {
      layers.add(spec.layer * (this.maxLayer - 1));
    }
    return layers;
  }

  private outerLayerValue(layer: -1 | 1): number {
    return layer * this.maxLayer;
  }

  private getDiscreteCoord(cubelet: Cubelet): Record<"x" | "y" | "z", number> {
    return {
      x: Math.round(cubelet.group.position.x / CUBELET_SPACING),
      y: Math.round(cubelet.group.position.y / CUBELET_SPACING),
      z: Math.round(cubelet.group.position.z / CUBELET_SPACING),
    };
  }

  private snapCubeletPosition(cubelet: Cubelet): void {
    const coord = this.getDiscreteCoord(cubelet);
    cubelet.group.position.set(coord.x * CUBELET_SPACING, coord.y * CUBELET_SPACING, coord.z * CUBELET_SPACING);
  }

  private getStickerPlacement(sticker: THREE.Mesh): { face: FaceMove; index: number } | null {
    const position = new THREE.Vector3();
    sticker.getWorldPosition(position);
    this.mainGroup.worldToLocal(position);

    const worldQuaternion = new THREE.Quaternion();
    const mainQuaternion = new THREE.Quaternion();
    sticker.getWorldQuaternion(worldQuaternion);
    this.mainGroup.getWorldQuaternion(mainQuaternion);

    const normal = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(worldQuaternion)
      .applyQuaternion(mainQuaternion.invert())
      .normalize();

    const abs = {
      x: Math.abs(normal.x),
      y: Math.abs(normal.y),
      z: Math.abs(normal.z),
    };

    if (abs.y > abs.x && abs.y > abs.z) {
      return {
        face: normal.y > 0 ? "U" : "D",
        index: normal.y > 0 ? this.indexForU(position) : this.indexForD(position),
      };
    }
    if (abs.x > abs.z) {
      return {
        face: normal.x > 0 ? "R" : "L",
        index: normal.x > 0 ? this.indexForR(position) : this.indexForL(position),
      };
    }

    return {
      face: normal.z > 0 ? "F" : "B",
      index: normal.z > 0 ? this.indexForF(position) : this.indexForB(position),
    };
  }

  private indexForF(position: THREE.Vector3): number {
    return this.rowFromY(position.y) * this.cubeSize + this.colFromAscending(position.x);
  }

  private indexForB(position: THREE.Vector3): number {
    return this.rowFromY(position.y) * this.cubeSize + this.colFromDescending(position.x);
  }

  private indexForR(position: THREE.Vector3): number {
    return this.rowFromY(position.y) * this.cubeSize + this.colFromDescending(position.z);
  }

  private indexForL(position: THREE.Vector3): number {
    return this.rowFromY(position.y) * this.cubeSize + this.colFromAscending(position.z);
  }

  private indexForU(position: THREE.Vector3): number {
    return this.rowFromAscending(position.z) * this.cubeSize + this.colFromAscending(position.x);
  }

  private indexForD(position: THREE.Vector3): number {
    return this.rowFromDescending(position.z) * this.cubeSize + this.colFromAscending(position.x);
  }

  private rowFromY(y: number): number {
    return this.maxLayer - Math.round(y / CUBELET_SPACING);
  }

  private rowFromAscending(value: number): number {
    return Math.round(value / CUBELET_SPACING) + this.maxLayer;
  }

  private rowFromDescending(value: number): number {
    return this.maxLayer - Math.round(value / CUBELET_SPACING);
  }

  private colFromAscending(value: number): number {
    return Math.round(value / CUBELET_SPACING) + this.maxLayer;
  }

  private colFromDescending(value: number): number {
    return this.maxLayer - Math.round(value / CUBELET_SPACING);
  }

  private get maxLayer(): number {
    return Math.floor(this.cubeSize / 2);
  }

  private dominantAxis(localPoint: THREE.Vector3): "x" | "y" | "z" {
    const abs = { x: Math.abs(localPoint.x), y: Math.abs(localPoint.y), z: Math.abs(localPoint.z) };
    if (abs.y >= abs.x && abs.y >= abs.z) return "y";
    if (abs.x >= abs.z) return "x";
    return "z";
  }

  private axisVector(axis: "x" | "y" | "z"): THREE.Vector3 {
    if (axis === "x") return new THREE.Vector3(1, 0, 0);
    if (axis === "y") return new THREE.Vector3(0, 1, 0);
    return new THREE.Vector3(0, 0, 1);
  }

  private worldToScreen(world: THREE.Vector3): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const projected = world.clone().project(this.camera);
    return new THREE.Vector2(
      (projected.x * 0.5 + 0.5) * rect.width + rect.left,
      (-projected.y * 0.5 + 0.5) * rect.height + rect.top
    );
  }

  private highlightStickers(stickers: THREE.Mesh[]): void {
    this.highlightedStickers = stickers;
    this.updateHighlightPulse();
  }

  private clearHighlight(): void {
    for (const sticker of this.highlightedStickers) {
      const material = sticker.material as THREE.MeshStandardMaterial;
      material.emissive.set("#000000");
      material.emissiveIntensity = 0;
    }
    this.highlightedStickers = [];
  }

  private updateHighlightPulse(): void {
    if (this.highlightedStickers.length === 0) return;
    const intensity = 0.3 + Math.sin(performance.now() * 0.006) * 0.16;
    for (const sticker of this.highlightedStickers) {
      const material = sticker.material as THREE.MeshStandardMaterial;
      material.emissive.set("#fff0a3");
      material.emissiveIntensity = intensity;
    }
  }
}
