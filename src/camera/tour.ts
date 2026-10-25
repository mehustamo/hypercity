import * as THREE from 'three';
import type { CityPlan } from '../types';

export class CinematicTour {
  readonly duration = 54;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly path: THREE.CatmullRomCurve3;
  private readonly targets: THREE.CatmullRomCurve3;
  private elapsed = 0;
  private active = false;
  private readonly targetPoint = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, plan: CityPlan) {
    this.camera = camera;
    const core = new THREE.Vector3(plan.core.x, 0, plan.core.z);
    const landmark = plan.landmark
      ? new THREE.Vector3(plan.landmark.x, plan.landmark.height * 0.45, plan.landmark.z)
      : new THREE.Vector3(0, 50, 0);

    this.path = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(280, 175, 320),
        new THREE.Vector3(140, 80, 210),
        new THREE.Vector3(84, 42, 160),
        new THREE.Vector3(84, 21, 84),
        new THREE.Vector3(84, 20, 0),
        new THREE.Vector3(84, 22, -84),
        new THREE.Vector3(84, 64, -175),
        new THREE.Vector3(0, 150, -255),
        new THREE.Vector3(-200, 195, -150),
        new THREE.Vector3(-300, 150, 30),
        new THREE.Vector3(-110, 205, 170),
        new THREE.Vector3(180, 165, 300),
      ],
      true,
      'catmullrom',
      0.32,
    );
    const target = new THREE.Vector3();
    this.targets = new THREE.CatmullRomCurve3(
      [
        core.clone().setY(34),
        core.clone().setY(46),
        landmark.clone().setY(80),
        core.clone().setY(17),
        core.clone().setY(19),
        core.clone().setY(20),
        core.clone().setY(38),
        core.clone().setY(55),
        core.clone().setY(38),
        landmark.clone().setY(110),
        core.clone().setY(42),
        core.clone().setY(34),
      ],
      true,
      'catmullrom',
      0.3,
    );
    void target;
  }

  start(): void {
    this.active = true;
    this.elapsed = 0;
    this.camera.fov = 52;
    this.camera.updateProjectionMatrix();
  }

  stop(): void {
    this.active = false;
  }

  get isActive(): boolean {
    return this.active;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.elapsed = (this.elapsed + dt) % this.duration;
    const t = this.elapsed / this.duration;
    this.path.getPointAt(t, this.camera.position);
    this.targets.getPointAt(t, this.targetPoint);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.targetPoint);

    const highPoint = THREE.MathUtils.smoothstep(this.camera.position.y, 18, 195);
    const desiredFov = THREE.MathUtils.lerp(57, 46, highPoint);
    this.camera.fov += (desiredFov - this.camera.fov) * Math.min(1, dt * 1.2);
    this.camera.updateProjectionMatrix();
    const roll = Math.sin(t * Math.PI * 6) * 0.008 * highPoint;
    this.camera.rotateZ(roll);
  }
}
