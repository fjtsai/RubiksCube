import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { isUniformlySolved } from "../domain/cube-geometry";
import {
  FACE_MOVES,
  MOVE_SPECS,
  getMoveAngle,
  getMoveFace,
  getMoveSuffix,
  isInnerMove,
  isSliceMove,
  isWideMove,
  type FaceMove,
  type MoveToken,
} from "../domain/moves";

const CUBELET_SIZE = 0.92;
const CUBELET_SPACING = 1.04;
const STICKER_SIZE = 0.78;
const STICKER_DEPTH = 0.035;
const DEFAULT_MOVE_DURATION = 260;
const QUARTER_TURN = Math.PI / 2;
// 手指移動超過這個距離才決定要轉哪一層與哪個方向。
const DRAG_LOCK_THRESHOLD = 9;
// 放開時只要轉超過 1/4 圈的這個比例就完成這一轉，否則彈回原位。
const SNAP_COMPLETION_RATIO = 0.32;
// 放開瞬間的角速度（弧度/秒）超過這個值視為「甩一下」。
const FLICK_VELOCITY = 2.4;
const CAMERA_FOV = 34;
const CAMERA_ELEVATION = 0.34;
const DEFAULT_YAW = -Math.PI / 4;
const DEFAULT_PITCH = 0.2;
const PITCH_MIN = -1.35;
const PITCH_MAX = 1.2;
const ORBIT_SPEED = 0.0085;
const ZOOM_MIN = 0.75;
// 5x5 貼紙小，允許放大多一點方便點準；3x3 放太大反而找不到空白處轉視角。
const ZOOM_MAX: Record<CubeSize, number> = { 3: 1.45, 5: 1.9 };
const DOUBLE_TAP_MS = 320;
// 提示的脈動與箭頭動畫只播一小段時間就定格，避免一直重繪耗電。
const HINT_ANIMATION_MS = 6000;

export type CubeSize = 3 | 5;

type Axis = "x" | "y" | "z";
const AXES: readonly Axis[] = ["x", "y", "z"];

export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Cubelet {
  id: string;
  group: THREE.Group;
  stickers: THREE.Mesh[];
}

interface LayerAnimation {
  axis: Axis;
  from: number;
  to: number;
  duration: number;
  elapsed: number;
  selected: Cubelet[];
  onDone: () => void;
}

interface QueuedMove {
  move: MoveToken;
  duration: number;
  resolve: (applied: boolean) => void;
}

interface ViewAnimation {
  fromYaw: number;
  fromPitch: number;
  fromZoom: number;
  elapsed: number;
  duration: number;
}

interface TurnLock {
  axis: Axis;
  layer: number;
  selected: Cubelet[];
  jacobian: THREE.Vector2;
  angle: number;
  samples: Array<{ time: number; angle: number }>;
}

interface TurnGesture {
  mode: "turn";
  pointerId: number;
  startX: number;
  startY: number;
  startLocalPoint: THREE.Vector3;
  normalAxis: Axis;
  cubelet: Cubelet;
  lock: TurnLock | null;
  blocked: boolean;
}

interface OrbitGesture {
  mode: "orbit";
  pointerId: number;
  lastX: number;
  lastY: number;
  moved: number;
}

interface MultiTouchGesture {
  mode: "multi";
  lastCenter: THREE.Vector2;
  lastDistance: number;
}

interface IdleUntilReleaseGesture {
  mode: "wait-release";
}

type Gesture = TurnGesture | OrbitGesture | MultiTouchGesture | IdleUntilReleaseGesture | null;

export interface FaceletTarget {
  face: FaceMove;
  index: number;
}

export interface RubiksSceneOptions {
  cubeSize?: CubeSize;
  onUserMove?: (move: MoveToken) => void;
  onMessage?: (message: string) => void;
  isMoveAllowed?: (move: MoveToken) => boolean;
  onTurnStart?: () => void;
}

export class RubiksScene {
  private readonly container: HTMLElement;
  private readonly options: RubiksSceneOptions;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly mainGroup = new THREE.Group();
  private readonly movePivot = new THREE.Group();
  private readonly arrowGroup = new THREE.Group();
  private readonly cubelets: Cubelet[] = [];
  private readonly hitTargets: THREE.Object3D[] = [];
  private readonly bodyGeometry = new RoundedBoxGeometry(CUBELET_SIZE, CUBELET_SIZE, CUBELET_SIZE, 4, 0.09);
  private readonly stickerGeometry = new RoundedBoxGeometry(STICKER_SIZE, STICKER_SIZE, STICKER_DEPTH, 3, 0.07);
  private readonly bodyMaterial = new THREE.MeshStandardMaterial({ color: "#20242c", roughness: 0.72, metalness: 0.04 });
  private readonly arrowFillMaterial = new THREE.MeshBasicMaterial({ color: "#e8336f", transparent: true, depthWrite: false });
  private readonly arrowOutlineMaterial = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, depthWrite: false });
  private readonly activePointers = new Map<number, THREE.Vector2>();
  private readonly resizeObserver: ResizeObserver;

  private gesture: Gesture = null;
  private animation: LayerAnimation | null = null;
  private readonly moveQueue: QueuedMove[] = [];
  private viewAnimation: ViewAnimation | null = null;
  private inputEnabled = true;
  private rafId = 0;
  private lastFrameTime = performance.now();
  private needsRender = true;
  private highlightedStickers: THREE.Mesh[] = [];
  private savedHighlight: THREE.Mesh[] = [];
  private arrowMeshes: Array<{ mesh: THREE.Object3D; normal: THREE.Vector3; direction: THREE.Vector3 }> = [];
  private arrowMove: MoveToken | null = null;
  private savedArrowMove: MoveToken | null = null;
  private cubeSize: CubeSize;
  private yaw = DEFAULT_YAW;
  private pitch = DEFAULT_PITCH;
  private zoom = 1;
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private lastBackgroundTap = 0;
  private hintAnimationUntil = 0;
  private highlightFrozen = false;

  constructor(container: HTMLElement, options: RubiksSceneOptions = {}) {
    this.container = container;
    this.options = options;
    this.cubeSize = options.cubeSize ?? 3;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "cube-canvas";
    this.renderer.domElement.setAttribute("role", "img");
    this.renderer.domElement.setAttribute("aria-label", "3D 魔方：拖曳任一排轉動，拖曳空白處或兩指滑動旋轉視角");
    this.container.appendChild(this.renderer.domElement);

    this.mainGroup.add(this.movePivot);
    this.mainGroup.add(this.arrowGroup);
    this.scene.add(this.mainGroup);
    this.applyViewRotation();

    this.addLights();
    this.addEnvironment();
    this.createCube();
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.start();
  }

  reset(): void {
    this.cancelTurnGesture(true);
    this.clearHighlight();
    this.clearArrow();
    this.moveQueue.splice(0).forEach((queued) => queued.resolve(false));
    this.animation = null;
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
    this.zoom = Math.min(this.zoom, ZOOM_MAX[size]);
    this.reset();
  }

  getCubeSize(): CubeSize {
    return this.cubeSize;
  }

  // 開發用：累計實際重繪的次數，用來確認閒置時不會一直重繪。
  getRenderCount(): number {
    return this.renderer.info.render.frame;
  }

  // 讓方塊置中在 HUD 與底部控制列之間真正空出來的區域。
  setViewInsets(insets: ViewInsets): void {
    const changed = (Object.keys(insets) as Array<keyof ViewInsets>).some(
      (key) => Math.abs(insets[key] - this.insets[key]) > 0.5
    );
    if (!changed) return;
    this.insets = { ...insets };
    this.resize();
  }

  resetView(animate = true): void {
    if (!animate) {
      this.yaw = DEFAULT_YAW;
      this.pitch = DEFAULT_PITCH;
      this.zoom = 1;
      this.applyViewRotation();
      this.resize();
      return;
    }
    // 繞最短的方向轉回預設視角。
    const turns = Math.round((this.yaw - DEFAULT_YAW) / (Math.PI * 2));
    this.yaw -= turns * Math.PI * 2;
    this.viewAnimation = { fromYaw: this.yaw, fromPitch: this.pitch, fromZoom: this.zoom, elapsed: 0, duration: 420 };
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.handlePointerDown);
    canvas.removeEventListener("pointermove", this.handlePointerMove);
    canvas.removeEventListener("pointerup", this.handlePointerUp);
    canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    canvas.removeEventListener("wheel", this.handleWheel);
    this.bodyGeometry.dispose();
    this.stickerGeometry.dispose();
    this.bodyMaterial.dispose();
    this.renderer.dispose();
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) this.cancelTurnGesture(true);
  }

  isBusy(): boolean {
    return this.animation !== null || this.moveQueue.length > 0 || this.gesture?.mode === "turn";
  }

  getFaceletString(): string {
    return this.withPivotAtRest(() => this.readFacelets());
  }

  // 讀取狀態時把轉到一半的那一層視為還沒轉，避免動畫中途讀到歪掉的貼紙位置。
  private withPivotAtRest<T>(read: () => T): T {
    const rotation = this.movePivot.rotation.clone();
    if (rotation.x === 0 && rotation.y === 0 && rotation.z === 0) return read();
    this.movePivot.rotation.set(0, 0, 0);
    this.mainGroup.updateMatrixWorld(true);
    try {
      return read();
    } finally {
      this.movePivot.rotation.copy(rotation);
      this.mainGroup.updateMatrixWorld(true);
    }
  }

  private readFacelets(): string {
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
    this.requestRender();
  }

  // 中間切片會讓中心換位，所以只看「每面是否單一顏色」，不要求白色一定在上。
  isSolved(): boolean {
    return isUniformlySolved(this.getFaceletString(), this.cubeSize);
  }

  highlightMove(move: MoveToken | null, options: { arrow?: boolean } = {}): void {
    this.clearHighlight();
    this.clearArrow();
    if (!move) return;
    const selected = this.getMoveCubelets(move);
    this.highlightStickers(selected.flatMap((cubelet) => cubelet.stickers));
    if (options.arrow) this.showMoveArrow(move);
  }

  highlightFaces(faces: FaceMove[]): void {
    this.clearHighlight();
    this.clearArrow();
    const faceSet = new Set(faces);
    const stickers = this.cubelets.flatMap((cubelet) =>
      cubelet.stickers.filter((sticker) => faceSet.has(sticker.userData.face as FaceMove))
    );
    this.highlightStickers(stickers);
  }

  highlightFacelets(targets: readonly FaceletTarget[]): void {
    this.clearHighlight();
    this.clearArrow();
    const targetKeys = new Set(targets.map((target) => `${target.face}:${target.index}`));
    const stickers = this.withPivotAtRest(() =>
      this.cubelets.flatMap((cubelet) =>
        cubelet.stickers.filter((sticker) => {
          const placement = this.getStickerPlacement(sticker);
          return placement ? targetKeys.has(`${placement.face}:${placement.index}`) : false;
        })
      )
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
      if (!(await this.applyMove(move, duration))) return;
    }
  }

  // 轉動一律排隊執行：動畫（或拖曳放開後的回彈）還沒結束時呼叫，會等前一個轉完再轉，
  // 不會「沒轉卻回報完成」，讓移動紀錄與畫面永遠一致。沒有動畫時的瞬間轉動會同步完成。
  // 回傳是否真的轉了（排隊中遇到 reset 會回傳 false，呼叫端就不要記錄這一步）。
  applyMove(move: MoveToken, duration = DEFAULT_MOVE_DURATION): Promise<boolean> {
    return new Promise((resolve) => {
      this.moveQueue.push({ move, duration, resolve });
      this.drainMoveQueue();
    });
  }

  private drainMoveQueue(): void {
    while (!this.animation && this.moveQueue.length > 0) {
      const next = this.moveQueue.shift() as QueuedMove;
      this.startMove(next.move, next.duration, next.resolve);
    }
  }

  private startMove(move: MoveToken, duration: number, resolve: (applied: boolean) => void): void {
    this.cancelTurnGesture(true);

    const axis = MOVE_SPECS[getMoveFace(move)].axis;
    const selected = this.getMoveCubelets(move);
    const finalAngle = getMoveAngle(move);
    this.clearHighlight();
    this.clearArrow();

    this.movePivot.rotation.set(0, 0, 0);
    selected.forEach((cubelet) => this.movePivot.attach(cubelet.group));

    if (duration <= 0) {
      this.movePivot.rotation[axis] = finalAngle;
      this.releasePivot(selected);
      this.requestRender();
      resolve(true);
      return;
    }

    this.animation = {
      axis,
      from: 0,
      to: finalAngle,
      duration: prefersReducedMotion() ? Math.min(duration, 90) : duration,
      elapsed: 0,
      selected,
      onDone: () => {
        this.releasePivot(selected);
        resolve(true);
      },
    };
  }

  private start(): void {
    const tick = (): void => {
      this.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      const delta = Math.min((now - this.lastFrameTime) / 1000, 0.05);
      this.lastFrameTime = now;
      const layerAnimating = this.updateLayerAnimation(delta);
      const viewAnimating = this.updateViewAnimation(delta);
      const animating = layerAnimating || viewAnimating;
      const pulsing = this.updateHighlightPulse();
      const arrows = this.updateArrows(now);
      if (!animating && !pulsing && !arrows && !this.needsRender && this.gesture?.mode !== "turn") return;
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  private requestRender(): void {
    this.needsRender = true;
  }

  private addLights(): void {
    const hemi = new THREE.HemisphereLight("#ffffff", "#9dc9c0", 2.8);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight("#ffffff", 3.6);
    key.position.set(4, 8, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    this.scene.add(key);

    const rim = new THREE.PointLight("#ffb347", 2.2, 16);
    rim.position.set(-4, 2, 4);
    this.scene.add(rim);
  }

  private addEnvironment(): void {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(3.4, 64),
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        roughness: 0.86,
        metalness: 0,
        transparent: true,
        opacity: 0.35,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.8;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  private createCube(): void {
    // 不同階數都縮放成同樣大小，鏡頭與光影設定不用跟著改。
    this.mainGroup.scale.setScalar(3 / this.cubeSize);
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
    this.requestRender();
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
    const offset = CUBELET_SIZE / 2 + 0.024;
    if (x === max) this.addSticker(cubelet, "R", new THREE.Vector3(offset, 0, 0), new THREE.Euler(0, Math.PI / 2, 0));
    if (x === -max) this.addSticker(cubelet, "L", new THREE.Vector3(-offset, 0, 0), new THREE.Euler(0, -Math.PI / 2, 0));
    if (y === max) this.addSticker(cubelet, "U", new THREE.Vector3(0, offset, 0), new THREE.Euler(-Math.PI / 2, 0, 0));
    if (y === -max) this.addSticker(cubelet, "D", new THREE.Vector3(0, -offset, 0), new THREE.Euler(Math.PI / 2, 0, 0));
    if (z === max) this.addSticker(cubelet, "F", new THREE.Vector3(0, 0, offset), new THREE.Euler(0, 0, 0));
    if (z === -max) this.addSticker(cubelet, "B", new THREE.Vector3(0, 0, -offset), new THREE.Euler(0, Math.PI, 0));

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
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointercancel", this.handlePointerCancel);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  private readonly resize = (): void => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const freeWidth = Math.max(80, width - this.insets.left - this.insets.right);
    const freeHeight = Math.max(80, height - this.insets.top - this.insets.bottom);
    const centerX = this.insets.left + freeWidth / 2;
    const centerY = this.insets.top + freeHeight / 2;

    // 以預設斜角視角下的方塊外接圓（約 0.82 個邊長）去貼合可用區域。
    const cubeEdge = 3 * CUBELET_SPACING;
    const silhouetteRadius = cubeEdge * 0.86;
    const targetRadiusPx = (Math.min(freeWidth, freeHeight) / 2) * 0.9;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
    const distance = (silhouetteRadius * height) / (2 * targetRadiusPx * tanHalfFov) / this.zoom;

    this.camera.position.set(0, Math.sin(CAMERA_ELEVATION) * distance, Math.cos(CAMERA_ELEVATION) * distance);
    this.camera.lookAt(0, 0, 0);
    this.camera.aspect = width / height;
    this.camera.setViewOffset(width, height, width / 2 - centerX, height / 2 - centerY, width, height);
    this.camera.updateProjectionMatrix();
    const canvas = this.renderer.domElement;
    const pixelRatio = this.renderer.getPixelRatio();
    if (canvas.width !== Math.floor(width * pixelRatio) || canvas.height !== Math.floor(height * pixelRatio)) {
      this.renderer.setSize(width, height, false);
    }
    this.requestRender();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    const canvas = this.renderer.domElement;
    canvas.setPointerCapture(event.pointerId);
    this.activePointers.set(event.pointerId, new THREE.Vector2(event.clientX, event.clientY));

    if (this.activePointers.size >= 2) {
      this.cancelTurnGesture(false);
      this.startMultiTouch();
      return;
    }

    const canTurn = this.inputEnabled && !this.animation;
    const hit = canTurn ? this.pickCubelet(event.clientX, event.clientY) : null;
    if (hit) {
      const startLocalPoint = this.mainGroup.worldToLocal(hit.point.clone());
      this.gesture = {
        mode: "turn",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLocalPoint,
        normalAxis: this.dominantAxis(startLocalPoint),
        cubelet: hit.cubelet,
        lock: null,
        blocked: false,
      };
      return;
    }

    this.gesture = {
      mode: "orbit",
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: 0,
    };
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const tracked = this.activePointers.get(event.pointerId);
    if (!tracked) return;
    tracked.set(event.clientX, event.clientY);
    const gesture = this.gesture;
    if (!gesture) return;
    event.preventDefault();

    if (gesture.mode === "multi") {
      this.updateMultiTouch(gesture);
      return;
    }

    if (gesture.mode === "orbit" && gesture.pointerId === event.pointerId) {
      const dx = event.clientX - gesture.lastX;
      const dy = event.clientY - gesture.lastY;
      gesture.moved += Math.hypot(dx, dy);
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      this.orbitBy(dx, dy);
      return;
    }

    if (gesture.mode === "turn" && gesture.pointerId === event.pointerId) {
      this.updateTurnGesture(gesture, event.clientX, event.clientY);
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    const gesture = this.gesture;
    if (!gesture) return;

    if (gesture.mode === "multi" || gesture.mode === "wait-release") {
      this.gesture = this.activePointers.size > 0 ? { mode: "wait-release" } : null;
      return;
    }

    if (gesture.pointerId !== event.pointerId) return;
    if (gesture.mode === "turn") {
      this.releaseTurnGesture(gesture);
      return;
    }

    if (gesture.moved < 6) {
      const now = performance.now();
      if (now - this.lastBackgroundTap < DOUBLE_TAP_MS) {
        this.resetView();
        this.lastBackgroundTap = 0;
      } else {
        this.lastBackgroundTap = now;
      }
    }
    this.gesture = null;
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.gesture?.mode === "turn" && this.gesture.pointerId === event.pointerId) {
      this.cancelTurnGesture(false);
    }
    if (this.activePointers.size === 0) this.gesture = null;
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.0015));
  };

  private startMultiTouch(): void {
    const [a, b] = [...this.activePointers.values()];
    this.gesture = {
      mode: "multi",
      lastCenter: a.clone().add(b).multiplyScalar(0.5),
      lastDistance: Math.max(1, a.distanceTo(b)),
    };
  }

  private updateMultiTouch(gesture: MultiTouchGesture): void {
    const points = [...this.activePointers.values()];
    if (points.length < 2) return;
    const [a, b] = points;
    const center = a.clone().add(b).multiplyScalar(0.5);
    const distance = Math.max(1, a.distanceTo(b));
    this.orbitBy(center.x - gesture.lastCenter.x, center.y - gesture.lastCenter.y);
    this.setZoom(this.zoom * (distance / gesture.lastDistance));
    gesture.lastCenter = center;
    gesture.lastDistance = distance;
  }

  private orbitBy(dx: number, dy: number): void {
    this.viewAnimation = null;
    this.yaw += dx * ORBIT_SPEED;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * ORBIT_SPEED, PITCH_MIN, PITCH_MAX);
    this.applyViewRotation();
  }

  private setZoom(zoom: number): void {
    const next = THREE.MathUtils.clamp(zoom, ZOOM_MIN, ZOOM_MAX[this.cubeSize]);
    if (Math.abs(next - this.zoom) < 1e-4) return;
    this.zoom = next;
    this.resize();
  }

  // 「轉盤式」視角：先繞垂直軸 yaw，再朝鏡頭方向傾斜 pitch，
  // 水平拖曳一定是左右轉、垂直拖曳一定是前後翻，不會越轉越歪。
  private applyViewRotation(): void {
    this.mainGroup.rotation.set(this.pitch, this.yaw, 0, "XYZ");
    this.mainGroup.updateMatrixWorld(true);
    this.requestRender();
  }

  private updateTurnGesture(gesture: TurnGesture, clientX: number, clientY: number): void {
    if (gesture.blocked) return;
    const drag = new THREE.Vector2(clientX - gesture.startX, clientY - gesture.startY);

    if (!gesture.lock) {
      if (drag.length() < DRAG_LOCK_THRESHOLD) return;
      const lock = this.lockTurnGesture(gesture, drag);
      if (!lock) {
        gesture.blocked = true;
        return;
      }
      gesture.lock = lock;
      this.options.onTurnStart?.();
    }

    const lock = gesture.lock;
    lock.angle = drag.dot(lock.jacobian) / lock.jacobian.lengthSq();
    this.movePivot.rotation[lock.axis] = lock.angle;
    const now = performance.now();
    lock.samples.push({ time: now, angle: lock.angle });
    while (lock.samples.length > 2 && now - lock.samples[0].time > 120) lock.samples.shift();
    this.requestRender();
  }

  // 貼紙繞某軸轉動時，在被按住那一面「面內」的移動方向是 軸 × 面法線，且整面每一格都一樣
  // （離開面的分量只會讓角落貼紙的投影方向失真，所以不算進來）。
  // 把兩個候選軸的面內方向投影到螢幕，看哪個最貼近手指移動，就轉那一軸上手指所在的那一層：
  // 外層、5x5 第二層、正中間切片都一樣處理。
  private lockTurnGesture(gesture: TurnGesture, drag: THREE.Vector2): TurnLock | null {
    const point = gesture.startLocalPoint;
    const normal = this.axisVector(gesture.normalAxis).multiplyScalar(Math.sign(point[gesture.normalAxis]) || 1);
    const faceDistance = Math.abs(point[gesture.normalAxis]);
    let best: { axis: Axis; jacobian: THREE.Vector2; alignment: number } | null = null;
    for (const axis of AXES) {
      if (axis === gesture.normalAxis) continue;
      const inPlane = this.axisVector(axis).cross(normal).multiplyScalar(faceDistance);
      const jacobian = this.screenJacobian(point, inPlane);
      const length = jacobian.length();
      if (length < 1e-3) continue;
      const alignment = Math.abs(drag.dot(jacobian)) / (drag.length() * length);
      if (!best || alignment > best.alignment) best = { axis, jacobian, alignment };
    }
    if (!best) return null;

    const layer = this.getDiscreteCoord(gesture.cubelet)[best.axis];
    const probe = this.moveForLayerRotation(best.axis, layer, 1);
    if (!probe) return null;
    if (this.options.isMoveAllowed && !this.options.isMoveAllowed(probe)) {
      this.options.onMessage?.("現在只能轉外層，保護已完成的 5x5 中心和邊");
      return null;
    }

    // 視線很斜時投影長度會變很短，設下限避免一點點移動就轉很多。
    const minLength = faceDistance * this.mainGroup.scale.x * this.pixelsPerWorldUnit() * 0.45;
    const jacobian = best.jacobian.clone();
    if (jacobian.length() < minLength) jacobian.setLength(minLength);

    const selected = this.cubelets.filter((cubelet) => this.getDiscreteCoord(cubelet)[best.axis] === layer);
    this.movePivot.rotation.set(0, 0, 0);
    selected.forEach((cubelet) => this.movePivot.attach(cubelet.group));
    this.savedHighlight = this.highlightedStickers;
    this.savedArrowMove = this.arrowMove;
    this.clearHighlight(false);
    this.clearArrow();
    this.highlightStickers(selected.flatMap((cubelet) => cubelet.stickers), "drag");

    return { axis: best.axis, layer, selected, jacobian, angle: 0, samples: [{ time: performance.now(), angle: 0 }] };
  }

  private releaseTurnGesture(gesture: TurnGesture): void {
    this.gesture = null;
    const lock = gesture.lock;
    if (!lock) return;

    const first = lock.samples[0];
    const last = lock.samples[lock.samples.length - 1];
    const elapsed = (last.time - first.time) / 1000;
    const velocity = elapsed > 0.01 ? (last.angle - first.angle) / elapsed : 0;
    const quarters = this.snapQuarters(lock.angle, velocity);
    const target = quarters * QUARTER_TURN;
    const move = this.moveForLayerRotation(lock.axis, lock.layer, quarters);

    this.animation = {
      axis: lock.axis,
      from: lock.angle,
      to: target,
      duration: 70 + 190 * Math.min(1, Math.abs(target - lock.angle) / QUARTER_TURN),
      elapsed: 0,
      selected: lock.selected,
      onDone: () => {
        this.releasePivot(lock.selected);
        this.clearHighlight(false);
        if (move) {
          this.savedHighlight = [];
          this.savedArrowMove = null;
          this.options.onUserMove?.(move);
        } else {
          this.restoreSavedHighlight();
        }
      },
    };
  }

  // 已經轉過的整格保留；剩下不到一格的部分超過 SNAP_COMPLETION_RATIO 就補完，
  // 或是放開時還在往同方向快速甩動也補完。甩動只負責「轉完這一格」，不會多轉一格。
  private snapQuarters(angle: number, velocity: number): number {
    const direction = Math.sign(angle);
    const progress = Math.abs(angle) / QUARTER_TURN;
    const whole = Math.floor(progress);
    const fraction = progress - whole;
    // 第一格輕輕一甩就能轉；已經轉超過一格時，要明顯多轉一些才補下一格，避免拖過頭。
    const flickThreshold = whole === 0 ? 0.08 : 0.2;
    const flick = Math.sign(velocity) === direction && Math.abs(velocity) > FLICK_VELOCITY && fraction > flickThreshold;
    const backFlick = Math.sign(velocity) === -direction && Math.abs(velocity) > FLICK_VELOCITY;
    const complete = !backFlick && (fraction >= SNAP_COMPLETION_RATIO || flick);
    return direction * (whole + (complete ? 1 : 0));
  }

  private cancelTurnGesture(instant: boolean): void {
    const gesture = this.gesture;
    if (gesture?.mode !== "turn") return;
    this.gesture = null;
    const lock = gesture.lock;
    if (!lock) return;

    if (instant || this.animation) {
      this.movePivot.rotation[lock.axis] = 0;
      this.releasePivot(lock.selected);
      this.clearHighlight(false);
      this.restoreSavedHighlight();
      return;
    }

    this.animation = {
      axis: lock.axis,
      from: lock.angle,
      to: 0,
      duration: 160,
      elapsed: 0,
      selected: lock.selected,
      onDone: () => {
        this.releasePivot(lock.selected);
        this.clearHighlight(false);
        this.restoreSavedHighlight();
      },
    };
  }

  private moveForLayerRotation(axis: Axis, layer: number, quarters: number): MoveToken | null {
    const turns = ((quarters % 4) + 4) % 4;
    if (turns === 0) return null;
    const max = this.maxLayer;
    const depth = max - Math.abs(layer);

    let base: string;
    let baseFace: FaceMove;
    if (layer === 0) {
      baseFace = axis === "x" ? "L" : axis === "y" ? "D" : "F";
      base = axis === "x" ? "M" : axis === "y" ? "E" : "S";
    } else {
      const face = FACE_MOVES.find(
        (candidate) => MOVE_SPECS[candidate].axis === axis && MOVE_SPECS[candidate].layer === Math.sign(layer)
      );
      if (!face) return null;
      baseFace = face;
      if (depth === 0) base = face;
      else if (depth === 1) base = `2${face}`;
      else return null;
    }

    if (turns === 2) return `${base}2` as MoveToken;
    const direction = turns === 1 ? 1 : -1;
    return (Math.sign(MOVE_SPECS[baseFace].angle) === direction ? base : `${base}'`) as MoveToken;
  }

  // 被按住的點沿著 velocity（每弧度的位移）移動時，螢幕上每弧度移動幾像素。
  private screenJacobian(localPoint: THREE.Vector3, velocity: THREE.Vector3): THREE.Vector2 {
    const epsilon = 0.02;
    const before = this.localToScreen(localPoint);
    const after = this.localToScreen(localPoint.clone().addScaledVector(velocity, epsilon));
    return after.sub(before).divideScalar(epsilon);
  }

  private localToScreen(localPoint: THREE.Vector3): THREE.Vector2 {
    return this.worldToScreen(this.mainGroup.localToWorld(localPoint.clone()));
  }

  private pixelsPerWorldUnit(): number {
    const height = Math.max(1, this.container.clientHeight);
    const distance = this.camera.position.length();
    return height / (2 * distance * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)));
  }

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

  private updateLayerAnimation(delta: number): boolean {
    const animation = this.animation;
    if (!animation) return false;

    animation.elapsed += delta * 1000;
    const progress = Math.min(1, animation.elapsed / animation.duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    this.movePivot.rotation[animation.axis] = animation.from + (animation.to - animation.from) * eased;

    if (progress >= 1) {
      this.movePivot.rotation[animation.axis] = animation.to;
      this.animation = null;
      animation.onDone();
      this.drainMoveQueue();
    }
    return true;
  }

  private updateViewAnimation(delta: number): boolean {
    const animation = this.viewAnimation;
    if (!animation) return false;
    animation.elapsed += delta * 1000;
    const progress = Math.min(1, animation.elapsed / animation.duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    this.yaw = animation.fromYaw + (DEFAULT_YAW - animation.fromYaw) * eased;
    this.pitch = animation.fromPitch + (DEFAULT_PITCH - animation.fromPitch) * eased;
    this.zoom = animation.fromZoom + (1 - animation.fromZoom) * eased;
    this.applyViewRotation();
    this.resize();
    if (progress >= 1) this.viewAnimation = null;
    return true;
  }

  private releasePivot(selected: readonly Cubelet[]): void {
    selected.forEach((cubelet) => {
      this.mainGroup.attach(cubelet.group);
      this.snapCubelet(cubelet);
    });
    this.movePivot.rotation.set(0, 0, 0);
    this.requestRender();
  }

  private getMoveCubelets(move: MoveToken): Cubelet[] {
    const axis = MOVE_SPECS[getMoveFace(move)].axis;
    const layers = this.getMoveLayers(move);
    return this.cubelets.filter((cubelet) => layers.has(this.getDiscreteCoord(cubelet)[axis]));
  }

  private getMoveLayers(move: MoveToken): Set<number> {
    if (isSliceMove(move)) return new Set([0]);
    const spec = MOVE_SPECS[getMoveFace(move)];
    const outer = spec.layer * this.maxLayer;
    const second = spec.layer * (this.maxLayer - 1);
    if (isInnerMove(move)) return new Set([second]);
    if (isWideMove(move)) return new Set([outer, second]);
    return new Set([outer]);
  }

  private getDiscreteCoord(cubelet: Cubelet): Record<Axis, number> {
    return {
      x: Math.round(cubelet.group.position.x / CUBELET_SPACING),
      y: Math.round(cubelet.group.position.y / CUBELET_SPACING),
      z: Math.round(cubelet.group.position.z / CUBELET_SPACING),
    };
  }

  // 每次轉完都把位置與方向對齊格點，避免浮點誤差累積讓貼紙歪掉或判錯位置。
  private snapCubelet(cubelet: Cubelet): void {
    const coord = this.getDiscreteCoord(cubelet);
    cubelet.group.position.set(coord.x * CUBELET_SPACING, coord.y * CUBELET_SPACING, coord.z * CUBELET_SPACING);
    const matrix = new THREE.Matrix4().makeRotationFromQuaternion(cubelet.group.quaternion);
    const elements = matrix.elements;
    for (const index of [0, 1, 2, 4, 5, 6, 8, 9, 10]) {
      elements[index] = Math.round(elements[index]);
    }
    cubelet.group.quaternion.setFromRotationMatrix(matrix);
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

  private dominantAxis(localPoint: THREE.Vector3): Axis {
    const abs = { x: Math.abs(localPoint.x), y: Math.abs(localPoint.y), z: Math.abs(localPoint.z) };
    if (abs.y >= abs.x && abs.y >= abs.z) return "y";
    if (abs.x >= abs.z) return "x";
    return "z";
  }

  private axisVector(axis: Axis): THREE.Vector3 {
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

  // 在轉動層經過的四個側面畫箭頭，標出貼紙要往哪邊走；
  // 每幀依面向鏡頭的程度淡入淡出，轉視角時永遠看得到正面那支。
  private showMoveArrow(move: MoveToken): void {
    this.arrowMove = move;
    this.hintAnimationUntil = performance.now() + HINT_ANIMATION_MS;
    const axis = MOVE_SPECS[getMoveFace(move)].axis;
    const axisVector = this.axisVector(axis);
    const layers = [...this.getMoveLayers(move)];
    const layerCenter = (layers.reduce((sum, layer) => sum + layer, 0) / layers.length) * CUBELET_SPACING;
    const rotationSign = Math.sign(getMoveAngle(move));
    const halfTurn = getMoveSuffix(move) === "2";
    const faceDistance = this.maxLayer * CUBELET_SPACING + CUBELET_SIZE / 2 + 0.09;
    const length = this.cubeSize * CUBELET_SPACING * 0.74;
    const fill = arrowShape(length, 0.13, 0.36, 0.44, halfTurn);
    const outline = arrowShape(length + 0.16, 0.2, 0.46, 0.52, halfTurn);

    for (const normalAxis of AXES) {
      if (normalAxis === axis) continue;
      for (const sign of [1, -1]) {
        const normal = this.axisVector(normalAxis).multiplyScalar(sign);
        const direction = axisVector.clone().cross(normal).multiplyScalar(rotationSign);
        const holder = new THREE.Group();
        const basis = new THREE.Matrix4().makeBasis(direction, normal.clone().cross(direction), normal);
        holder.quaternion.setFromRotationMatrix(basis);
        holder.position.copy(normal).multiplyScalar(faceDistance).addScaledVector(axisVector, layerCenter);
        const outlineMesh = new THREE.Mesh(outline, this.arrowOutlineMaterial);
        const fillMesh = new THREE.Mesh(fill, this.arrowFillMaterial);
        fillMesh.position.z = 0.012;
        outlineMesh.renderOrder = 10;
        fillMesh.renderOrder = 11;
        holder.add(outlineMesh, fillMesh);
        this.arrowGroup.add(holder);
        this.arrowMeshes.push({ mesh: holder, normal, direction });
      }
    }
    this.requestRender();
  }

  private clearArrow(): void {
    for (const { mesh } of this.arrowMeshes) {
      this.arrowGroup.remove(mesh);
      mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
    }
    this.arrowMeshes = [];
    this.arrowMove = null;
    this.requestRender();
  }

  private updateArrows(now: number): boolean {
    if (this.arrowMeshes.length === 0) return false;
    const animating = now < this.hintAnimationUntil && !prefersReducedMotion();
    // 定格後只有在視角或畫面有變動時才需要重新擺放箭頭。
    if (!animating && !this.needsRender && this.gesture?.mode !== "orbit" && this.gesture?.mode !== "multi") return false;
    const cameraLocal = this.mainGroup.worldToLocal(this.camera.position.clone()).normalize();
    const nudge = animating ? (Math.sin(now * 0.005) * 0.5 + 0.5) * 0.18 : 0;
    let maxFacing = 0;
    for (const arrow of this.arrowMeshes) {
      const facing = arrow.normal.dot(cameraLocal);
      maxFacing = Math.max(maxFacing, facing);
      arrow.mesh.visible = facing > 0.28;
      arrow.mesh.userData.facing = facing;
    }
    for (const arrow of this.arrowMeshes) {
      const holder = arrow.mesh;
      if (!holder.visible) continue;
      const base = holder.userData.base as THREE.Vector3 | undefined;
      if (!base) holder.userData.base = holder.position.clone();
      holder.position.copy(holder.userData.base as THREE.Vector3).addScaledVector(arrow.direction, nudge);
      // 只留下最正面與次正面的兩支，避免四支箭頭同時出現太亂。
      holder.visible = (holder.userData.facing as number) >= maxFacing - 0.45;
    }
    this.arrowFillMaterial.opacity = 0.95;
    this.arrowOutlineMaterial.opacity = 0.95;
    return animating;
  }

  private highlightStickers(stickers: THREE.Mesh[], style: "hint" | "drag" = "hint"): void {
    this.highlightedStickers = stickers;
    this.highlightFrozen = false;
    this.hintAnimationUntil = performance.now() + HINT_ANIMATION_MS;
    for (const sticker of stickers) sticker.userData.highlightStyle = style;
    this.updateHighlightPulse();
    this.requestRender();
  }

  private clearHighlight(forgetSaved = true): void {
    for (const sticker of this.highlightedStickers) {
      const material = sticker.material as THREE.MeshStandardMaterial;
      material.emissive.set("#000000");
      material.emissiveIntensity = 0;
    }
    this.highlightedStickers = [];
    if (forgetSaved) {
      this.savedHighlight = [];
      this.savedArrowMove = null;
    }
    this.requestRender();
  }

  private restoreSavedHighlight(): void {
    const saved = this.savedHighlight;
    const arrowMove = this.savedArrowMove;
    this.savedHighlight = [];
    this.savedArrowMove = null;
    if (saved.length > 0) this.highlightStickers(saved);
    if (arrowMove) this.showMoveArrow(arrowMove);
  }

  private updateHighlightPulse(): boolean {
    if (this.highlightedStickers.length === 0) return false;
    const now = performance.now();
    const animating = now < this.hintAnimationUntil && !prefersReducedMotion();
    if (!animating && this.highlightFrozen) return false;
    this.highlightFrozen = !animating;
    if (!animating) this.needsRender = true;
    const pulse = animating ? 0.2 + Math.sin(now * 0.006) * 0.1 : 0.22;
    for (const sticker of this.highlightedStickers) {
      const material = sticker.material as THREE.MeshStandardMaterial;
      const drag = sticker.userData.highlightStyle === "drag";
      material.emissive.set(drag ? "#ffffff" : "#fff0a3");
      material.emissiveIntensity = drag ? 0.16 : pulse;
    }
    return animating;
  }
}

function arrowShape(length: number, halfShaft: number, headLength: number, halfHead: number, doubleHead: boolean): THREE.ShapeGeometry {
  const half = length / 2;
  const tail = doubleHead ? -half + headLength : -half;
  const shape = new THREE.Shape();
  shape.moveTo(tail, -halfShaft);
  shape.lineTo(half - headLength, -halfShaft);
  shape.lineTo(half - headLength, -halfHead);
  shape.lineTo(half, 0);
  shape.lineTo(half - headLength, halfHead);
  shape.lineTo(half - headLength, halfShaft);
  shape.lineTo(tail, halfShaft);
  if (doubleHead) {
    shape.lineTo(tail, halfHead);
    shape.lineTo(-half, 0);
    shape.lineTo(tail, -halfHead);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
