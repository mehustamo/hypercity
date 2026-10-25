import * as THREE from 'three';
import type { CameraMode, CityPlan } from '../types';
import { clamp, damp, smoothstep } from '../utils/random';

interface Collider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface CameraTween {
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromYaw: number;
  fromPitch: number;
  toYaw: number;
  toPitch: number;
  elapsed: number;
  duration: number;
}

const WALK_EYE_HEIGHT = 2.15;
const WALK_RADIUS = 0.55;
const KEY_LOOK_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight']);

export class CameraController {
  onHover: ((clientX: number, clientY: number) => void) | null = null;
  onHoverEnd: (() => void) | null = null;
  onPick: ((clientX: number, clientY: number) => void) | null = null;
  onSpeedChanged: ((speed: number) => void) | null = null;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly plan: CityPlan;
  private readonly colliders: Collider[] = [];
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private readonly desiredVelocity = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly moveInput = new THREE.Vector2();
  private readonly virtualMove = new THREE.Vector2();
  private virtualLift = 0;

  private yaw = 0;
  private pitch = 0;
  private enabled = true;
  private mode: CameraMode = 'fly';
  private dragging = false;
  private dragMoved = 0;
  private pointerId: number | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private speed = 22;
  private walkPhase = 0;
  private tween: CameraTween | null = null;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement, plan: CityPlan) {
    this.camera = camera;
    this.canvas = canvas;
    this.plan = plan;
    this.buildColliders();
    this.bindEvents();
  }

  private buildColliders(): void {
    for (const building of this.plan.buildings) {
      for (const volume of building.volumes) {
        if (volume.y > WALK_EYE_HEIGHT) continue;
        this.colliders.push({
          minX: volume.x - volume.w / 2,
          maxX: volume.x + volume.w / 2,
          minZ: volume.z - volume.d / 2,
          maxZ: volume.z + volume.d / 2,
        });
      }
    }
    this.colliders.push({
      minX: this.plan.core.x - 3.3,
      maxX: this.plan.core.x + 3.3,
      minZ: this.plan.core.z - 3.3,
      maxZ: this.plan.core.z + 3.3,
    });
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.clearInput);
    document.addEventListener('visibilitychange', this.clearInput);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.keys.clear();
      this.dragging = false;
      this.canvas.style.cursor = 'default';
    } else {
      this.canvas.style.cursor = 'grab';
    }
  }

  setMode(mode: CameraMode): void {
    if (mode === 'tour') {
      this.mode = 'tour';
      this.setEnabled(false);
      return;
    }
    this.mode = mode;
    this.tween = null;
    if (mode === 'walk') {
      const safe = this.findSafeWalkPosition(this.camera.position.x, this.camera.position.z);
      this.camera.position.set(safe.x, WALK_EYE_HEIGHT, safe.z);
      this.velocity.set(0, 0, 0);
      this.pitch = clamp(this.pitch, -0.8, 0.8);
    }
    this.setEnabled(true);
    this.syncAnglesFromCamera();
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  get cruiseSpeed(): number {
    return this.speed;
  }

  setPose(position: THREE.Vector3, yaw: number, pitch: number): void {
    this.camera.position.copy(position);
    this.yaw = yaw;
    this.pitch = clamp(pitch, -1.52, 1.52);
    this.applyRotation();
    this.velocity.set(0, 0, 0);
    this.tween = null;
  }

  beginExploreFromCamera(): void {
    this.syncAnglesFromCamera();
    this.mode = 'fly';
    this.enabled = true;
    this.canvas.style.cursor = 'grab';
    this.tween = null;
    this.velocity.set(0, 0, 0);
  }

  syncAnglesFromCamera(): void {
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    this.pitch = Math.asin(clamp(direction.y, -1, 1));
    this.yaw = Math.atan2(-direction.x, -direction.z);
    this.applyRotation();
  }

  setLookAt(target: THREE.Vector3): void {
    const direction = target.clone().sub(this.camera.position).normalize();
    this.pitch = Math.asin(clamp(direction.y, -1, 1));
    this.yaw = Math.atan2(-direction.x, -direction.z);
    this.applyRotation();
  }

  flyTo(position: THREE.Vector3, target: THREE.Vector3, duration = 2.2): void {
    const direction = target.clone().sub(position).normalize();
    const toPitch = Math.asin(clamp(direction.y, -1, 1));
    const toYaw = Math.atan2(-direction.x, -direction.z);
    this.tween = {
      fromPosition: this.camera.position.clone(),
      toPosition: position.clone(),
      fromYaw: this.yaw,
      fromPitch: this.pitch,
      toYaw: this.shortestYaw(this.yaw, toYaw),
      toPitch,
      elapsed: 0,
      duration,
    };
    this.velocity.set(0, 0, 0);
  }

  setVirtualMove(x: number, y: number): void {
    this.virtualMove.set(clamp(x, -1, 1), clamp(y, -1, 1));
  }

  setVirtualLift(value: number): void {
    this.virtualLift = clamp(value, -1, 1);
  }

  update(dt: number): void {
    const clampedDt = Math.min(dt, 0.05);
    if (this.tween) {
      this.updateTween(clampedDt);
      return;
    }
    if (!this.enabled || this.mode === 'tour') return;

    const inputX = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0) + this.virtualMove.x;
    const inputZ = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0) + -this.virtualMove.y;
    const inputY = (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0) + this.virtualLift;
    this.moveInput.set(clamp(inputX, -1, 1), clamp(inputZ, -1, 1));
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3.1 : 1;

    if (this.mode === 'walk') {
      this.updateWalk(clampedDt, boost);
    } else {
      this.updateFly(clampedDt, inputY, boost);
    }
    this.camera.position.y = clamp(this.camera.position.y, 1.55, 420);
    const bound = this.plan.extent + 280;
    this.camera.position.x = clamp(this.camera.position.x, -bound, bound);
    this.camera.position.z = clamp(this.camera.position.z, -bound, bound);
    this.applyRotation();
  }

  private updateFly(dt: number, inputY: number, boost: number): void {
    const cosPitch = Math.cos(this.pitch);
    this.forward.set(-Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), -Math.cos(this.yaw) * cosPitch);
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.desiredVelocity.set(0, 0, 0);
    this.desiredVelocity.addScaledVector(this.forward, this.moveInput.y);
    this.desiredVelocity.addScaledVector(this.right, this.moveInput.x);
    this.desiredVelocity.y += inputY * Math.max(0.55, cosPitch);
    if (this.desiredVelocity.lengthSq() > 1) this.desiredVelocity.normalize();
    this.desiredVelocity.multiplyScalar(this.speed * boost);
    const responsiveness = 1 - Math.exp(-7.5 * dt);
    this.velocity.lerp(this.desiredVelocity, responsiveness);
    this.camera.position.addScaledVector(this.velocity, dt);
  }

  private updateWalk(dt: number, boost: number): void {
    this.desiredVelocity.set(0, 0, 0);
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.desiredVelocity.addScaledVector(this.forward, this.moveInput.y);
    this.desiredVelocity.addScaledVector(this.right, this.moveInput.x);
    if (this.desiredVelocity.lengthSq() > 1) this.desiredVelocity.normalize();
    this.desiredVelocity.multiplyScalar(6.2 * (boost > 1 ? 1.8 : 1));
    const responsiveness = 1 - Math.exp(-12 * dt);
    this.velocity.lerp(this.desiredVelocity, responsiveness);
    const moveX = this.velocity.x * dt;
    const moveZ = this.velocity.z * dt;
    const nextX = this.camera.position.x + moveX;
    if (!this.isBlocked(nextX, this.camera.position.z)) this.camera.position.x = nextX;
    const nextZ = this.camera.position.z + moveZ;
    if (!this.isBlocked(this.camera.position.x, nextZ)) this.camera.position.z = nextZ;

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizontalSpeed > 0.2) this.walkPhase += dt * horizontalSpeed * 1.2;
    const bob = Math.sin(this.walkPhase) * 0.035 * Math.min(1, horizontalSpeed / 4);
    this.camera.position.y = WALK_EYE_HEIGHT + bob;
  }

  private isBlocked(x: number, z: number): boolean {
    for (const collider of this.colliders) {
      if (
        x > collider.minX - WALK_RADIUS &&
        x < collider.maxX + WALK_RADIUS &&
        z > collider.minZ - WALK_RADIUS &&
        z < collider.maxZ + WALK_RADIUS
      ) {
        return true;
      }
    }
    return false;
  }

  private findSafeWalkPosition(x: number, z: number): { x: number; z: number } {
    if (!this.isBlocked(x, z)) return { x, z };
    let nearestVertical = this.plan.roadLines[0]!;
    let nearestHorizontal = this.plan.roadLines[0]!;
    let verticalDistance = Infinity;
    let horizontalDistance = Infinity;
    for (const line of this.plan.roadLines) {
      const dv = Math.abs(line - x);
      if (dv < verticalDistance) {
        verticalDistance = dv;
        nearestVertical = line;
      }
      const dh = Math.abs(line - z);
      if (dh < horizontalDistance) {
        horizontalDistance = dh;
        nearestHorizontal = line;
      }
    }
    if (verticalDistance < horizontalDistance) return { x: nearestVertical, z };
    return { x, z: nearestHorizontal };
  }

  private updateTween(dt: number): void {
    if (!this.tween) return;
    this.tween.elapsed += dt;
    const raw = clamp(this.tween.elapsed / this.tween.duration, 0, 1);
    const t = smoothstep(0, 1, raw);
    this.camera.position.lerpVectors(this.tween.fromPosition, this.tween.toPosition, t);
    this.yaw = this.tween.fromYaw + (this.tween.toYaw - this.tween.fromYaw) * t;
    this.pitch = this.tween.fromPitch + (this.tween.toPitch - this.tween.fromPitch) * t;
    this.applyRotation();
    if (raw >= 1) this.tween = null;
  }

  private applyRotation(): void {
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private shortestYaw(from: number, to: number): number {
    let delta = (to - from) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return from + delta;
  }

  private cancelTween(): void {
    this.tween = null;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.mode === 'tour' || event.button > 0) return;
    this.cancelTween();
    this.dragging = true;
    this.dragMoved = 0;
    this.pointerId = event.pointerId;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.dragging && this.pointerId === event.pointerId) {
      const dx = event.clientX - this.lastPointerX;
      const dy = event.clientY - this.lastPointerY;
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      if (this.enabled) {
        this.yaw -= dx * 0.0025;
        this.pitch = clamp(this.pitch - dy * 0.0024, -1.5, 1.5);
        this.applyRotation();
        this.velocity.multiplyScalar(0.92);
      }
      return;
    }
    if (this.enabled) this.onHover?.(event.clientX, event.clientY);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.dragging || this.pointerId !== event.pointerId) return;
    this.dragging = false;
    this.pointerId = null;
    this.canvas.style.cursor = 'grab';
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
    if (this.enabled && this.dragMoved < 6 && event.button === 0) {
      this.onPick?.(event.clientX, event.clientY);
    }
  };

  private handlePointerLeave = (): void => {
    if (!this.dragging) this.onHoverEnd?.();
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    this.speed = clamp(this.speed * (1 - event.deltaY * 0.0012), 4, 85);
    this.onSpeedChanged?.(this.speed);
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (!KEY_LOOK_KEYS.has(event.code)) return;
    if (!this.enabled) return;
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.keys.add(event.code);
    } else {
      this.keys.add(event.code);
    }
    this.cancelTween();
    if (event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') event.preventDefault();
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private clearInput = (): void => {
    this.keys.clear();
    this.dragging = false;
    this.pointerId = null;
  };
}
