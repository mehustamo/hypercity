import * as THREE from 'three';
import type { SceneLighting, WeatherConfig } from '../types';
import { clamp, smoothstep } from '../utils/random';

const SKY_VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uDaylight;
  uniform float uNight;
  uniform float uGolden;
  uniform float uCloud;
  uniform float uStorm;
  uniform float uFlash;
  uniform vec3 uSunDirection;
  uniform vec3 uMoonDirection;
  uniform vec3 uSunColor;
  uniform vec3 uFogColor;

  varying vec3 vWorldPosition;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 rotation = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise2(p);
      p = rotation * p * 2.02;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec3 direction = normalize(vWorldPosition - cameraPosition);
    float elevation = direction.y;
    float up = max(elevation, 0.0);

    vec3 dayHorizon = vec3(0.27, 0.47, 0.64);
    vec3 dayZenith = vec3(0.018, 0.07, 0.18);
    vec3 nightHorizon = vec3(0.009, 0.02, 0.04);
    vec3 nightZenith = vec3(0.001, 0.0025, 0.009);
    vec3 sunsetColor = vec3(0.98, 0.22, 0.1);
    vec3 duskViolet = vec3(0.13, 0.04, 0.2);

    float skyGradient = pow(up, 0.42);
    vec3 daySky = mix(dayHorizon, dayZenith, skyGradient);
    vec3 nightSky = mix(nightHorizon, nightZenith, pow(up, 0.55));
    vec3 sky = mix(nightSky, daySky, uDaylight);

    float sunHorizon = max(0.0, 1.0 - abs(elevation) * 3.4);
    float azimuthMatch = pow(max(dot(normalize(direction.xz + vec2(0.0001)), normalize(uSunDirection.xz + vec2(0.0001))), 0.0), 3.2);
    sky += sunsetColor * uGolden * (0.2 + azimuthMatch * 1.15) * sunHorizon * 0.72;
    sky += duskViolet * uGolden * sunHorizon * (1.0 - azimuthMatch * 0.55) * 0.95;
    sky += vec3(0.04, 0.08, 0.12) * uDaylight * pow(up, 2.0);

    vec3 sunColor = uSunColor;
    float sunDot = max(dot(direction, uSunDirection), 0.0);
    float sunDisk = smoothstep(0.99955, 0.99982, sunDot);
    float sunHalo = pow(sunDot, 520.0) * 2.2 + pow(sunDot, 34.0) * 0.22;
    float sunVisibility = smoothstep(-0.06, 0.02, uSunDirection.y);
    sky += sunColor * (sunDisk * 11.0 + sunHalo) * sunVisibility * (0.35 + uDaylight * 0.9);

    float moonDot = max(dot(direction, uMoonDirection), 0.0);
    float moonDisk = smoothstep(0.9994, 0.99978, moonDot);
    float moonGlow = pow(moonDot, 320.0) * 0.26;
    float moonVisibility = smoothstep(-0.02, 0.12, uMoonDirection.y) * uNight;
    sky += vec3(0.63, 0.76, 1.0) * (moonDisk * 2.4 + moonGlow) * moonVisibility;

    vec2 skyUv = vec2(
      atan(direction.z, direction.x) / 6.2831853 + 0.5,
      asin(clamp(elevation, -1.0, 1.0)) / 3.1415926 + 0.5
    );
    vec2 starGrid = skyUv * vec2(820.0, 410.0);
    vec2 starCell = floor(starGrid);
    vec2 starLocal = fract(starGrid) - 0.5;
    float starRandom = hash21(starCell);
    float star = step(0.9975, starRandom) * (1.0 - smoothstep(0.0, 0.26, length(starLocal)));
    float twinkle = 0.55 + 0.45 * sin(uTime * (0.45 + starRandom * 2.4) + starRandom * 18.0);
    sky += vec3(0.66, 0.8, 1.0) * star * twinkle * uNight * (1.0 - uCloud * 0.8) * smoothstep(0.02, 0.35, elevation) * 1.5;

    float cloudField;
    if (elevation > -0.01) {
      vec2 cloudUv = direction.xz / (elevation + 0.19);
      cloudUv = cloudUv * 0.55 + vec2(uTime * 0.0032, uTime * 0.0017);
      float base = fbm(cloudUv * 1.5);
      float detail = fbm(cloudUv * 3.7 + 19.2);
      cloudField = smoothstep(0.47 - uCloud * 0.24, 0.77 - uCloud * 0.15, base + detail * 0.22);
      float horizonFade = smoothstep(-0.02, 0.16, elevation);
      float cloudVisibility = cloudField * horizonFade;
      vec3 litCloud = mix(vec3(0.38, 0.43, 0.49), vec3(0.75, 0.47, 0.32), uGolden * 0.75);
      litCloud = mix(litCloud, vec3(0.12, 0.14, 0.17), uStorm * 0.7);
      litCloud *= 0.24 + uDaylight * 1.05;
      vec3 nightCloud = vec3(0.015, 0.022, 0.031);
      vec3 cloudColor = mix(nightCloud, litCloud, clamp(uDaylight + uGolden * 0.25, 0.0, 1.0));
      cloudColor += vec3(0.14, 0.2, 0.28) * uFlash;
      sky = mix(sky, cloudColor, cloudVisibility * (0.35 + uCloud * 0.65));
    }

    // Below the horizon, settle into the atmosphere/fog color.
    vec3 lowerSkies = mix(uFogColor, sky * 0.55, 0.28);
    sky = mix(sky, lowerSkies, 1.0 - smoothstep(-0.14, 0.02, elevation));

    sky = mix(sky, vec3(0.07, 0.085, 0.105) * (0.18 + uDaylight * 0.9), uStorm * 0.45);
    sky += uFlash * vec3(0.48, 0.62, 0.9);
    sky = mix(sky, uFogColor, (1.0 - smoothstep(0.0, 0.11, abs(elevation))) * (0.18 + uCloud * 0.18));

    // A whisper of dithering prevents visible banding in long gradients.
    float dither = (hash21(gl_FragCoord.xy + uTime) - 0.5) * (1.5 / 255.0);
    gl_FragColor = vec4(max(sky + dither, 0.0), 1.0);
  }
`;

function createEnvironmentTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const skyGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  skyGradient.addColorStop(0, '#050b16');
  skyGradient.addColorStop(0.32, '#14334d');
  skyGradient.addColorStop(0.49, '#9eb7c8');
  skyGradient.addColorStop(0.52, '#6d6963');
  skyGradient.addColorStop(0.7, '#1a1b1b');
  skyGradient.addColorStop(1, '#060708');
  ctx.fillStyle = skyGradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const sunGlow = ctx.createRadialGradient(720, 230, 4, 720, 230, 240);
  sunGlow.addColorStop(0, 'rgba(255, 209, 154, 0.85)');
  sunGlow.addColorStop(0.18, 'rgba(255, 153, 95, 0.28)');
  sunGlow.addColorStop(1, 'rgba(255, 117, 67, 0)');
  ctx.fillStyle = sunGlow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export interface Atmosphere extends SceneLighting {
  lightsOn: number;
  cloud: number;
  wetness: number;
  storm: number;
}

export class SkySystem {
  readonly sunLight: THREE.DirectionalLight;
  readonly moonLight: THREE.DirectionalLight;
  readonly hemiLight: THREE.HemisphereLight;
  readonly flashLight: THREE.AmbientLight;
  readonly fillLight: THREE.DirectionalLight;

  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly skyMesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly shadowCameraSize = 360;
  private readonly fogColor = new THREE.Color();
  private readonly coolFog = new THREE.Color(0x1b2633);
  private readonly coolFogDay = new THREE.Color(0x536675);

  private readonly sunDir = new THREE.Vector3();
  private readonly moonDir = new THREE.Vector3();
  private readonly sunColor = new THREE.Color();
  private readonly horizonColor = new THREE.Color();
  private readonly dayHorizon = new THREE.Color(0x91aec3);
  private readonly goldenHorizon = new THREE.Color(0xd39a79);
  private readonly nightHorizon = new THREE.Color(0x09121d);
  private readonly stormHorizon = new THREE.Color(0x303b46);
  private readonly snowHorizon = new THREE.Color(0x93a2ad);
  private readonly hemiSky = new THREE.Color(0x91c4e4);
  private readonly worldUp = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;

    const environmentTexture = createEnvironmentTexture();
    scene.environment = environmentTexture;
    scene.environmentIntensity = 0.8;

    const geometry = new THREE.SphereGeometry(1400, 48, 24);
    this.uniforms = {
      uTime: { value: 0 },
      uDaylight: { value: 0.5 },
      uNight: { value: 0.2 },
      uGolden: { value: 0.6 },
      uCloud: { value: 0.25 },
      uStorm: { value: 0 },
      uFlash: { value: 0 },
      uSunDirection: { value: this.sunDir },
      uMoonDirection: { value: this.moonDir },
      uSunColor: { value: this.sunColor },
      uFogColor: { value: this.horizonColor },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.skyMesh = new THREE.Mesh(geometry, material);
    this.skyMesh.renderOrder = -1000;
    this.skyMesh.frustumCulled = false;
    this.skyMesh.name = 'sky-dome';
    this.scene.add(this.skyMesh);

    this.sunLight = new THREE.DirectionalLight(0xffe0be, 3.2);
    this.sunLight.name = 'sun';
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -this.shadowCameraSize;
    this.sunLight.shadow.camera.right = this.shadowCameraSize;
    this.sunLight.shadow.camera.top = this.shadowCameraSize;
    this.sunLight.shadow.camera.bottom = -this.shadowCameraSize;
    this.sunLight.shadow.camera.near = 5;
    this.sunLight.shadow.camera.far = 1200;
    this.sunLight.shadow.bias = -0.00025;
    this.sunLight.shadow.normalBias = 0.6;
    this.sunLight.shadow.camera.updateProjectionMatrix();
    this.sunLight.target.position.set(0, 0, 0);
    scene.add(this.sunLight, this.sunLight.target);

    this.moonLight = new THREE.DirectionalLight(0x89a9d8, 0);
    this.moonLight.name = 'moon';
    scene.add(this.moonLight, this.moonLight.target);

    this.hemiLight = new THREE.HemisphereLight(0x86b7d9, 0x13110f, 0.6);
    this.hemiLight.name = 'sky-bounce';
    scene.add(this.hemiLight);

    this.fillLight = new THREE.DirectionalLight(0x668bac, 0.35);
    this.fillLight.name = 'city-fill';
    this.fillLight.position.set(-260, 140, 280);
    this.fillLight.target.position.set(0, 20, 0);
    scene.add(this.fillLight, this.fillLight.target);

    this.flashLight = new THREE.AmbientLight(0xa9d2ff, 0);
    scene.add(this.flashLight);

    scene.fog = new THREE.FogExp2(0x0c1219, 0.001);
  }

  update(elapsed: number, hours: number, weather: WeatherConfig, flash: number, cameraPosition: THREE.Vector3): Atmosphere {
    const solarAngle = ((hours - 6) / 24) * Math.PI * 2;
    this.sunDir.set(Math.cos(solarAngle), Math.sin(solarAngle), 0.55).normalize();
    this.moonDir.copy(this.sunDir).multiplyScalar(-1).applyAxisAngle(this.worldUp, 0.18).normalize();
    const sunHeight = this.sunDir.y;

    const daylight = smoothstep(-0.045, 0.22, sunHeight) * (1 - weather.cloud * 0.32 - weather.storm * 0.24);
    const night = 1 - smoothstep(-0.2, 0.08, sunHeight);
    const golden = Math.exp(-(((sunHeight - 0.02) / 0.12) ** 2)) * (1 - weather.storm * 0.7) * (1 - weather.cloud * 0.3);
    const lightsOn = clamp(night * 0.92 + weather.wet * 0.14 + weather.snow * 0.08 + weather.cloud * 0.1, 0, 1);

    const sunWarmth = smoothstep(0.0, 0.45, sunHeight);
    this.sunColor.setRGB(1.0, 0.46 + sunWarmth * 0.42, 0.18 + sunWarmth * 0.58);

    const dayHorizon = this.dayHorizon;
    const goldenHorizon = this.goldenHorizon;
    const nightHorizon = this.nightHorizon;
    const stormHorizon = this.stormHorizon;
    this.horizonColor.copy(nightHorizon).lerp(dayHorizon, daylight);
    this.horizonColor.lerp(goldenHorizon, golden * 0.68);
    if (weather.storm > 0.02) {
      this.horizonColor.lerp(stormHorizon, weather.storm * (0.25 + daylight * 0.4));
    }
    if (weather.snow > 0.02) {
      this.horizonColor.lerp(this.snowHorizon, weather.snow * 0.12 * daylight);
    }

    const sunIntensity = smoothstep(-0.02, 0.24, sunHeight) * 3.0 * weather.sunDim;
    const moonIntensity = night * 0.86 * (1 - weather.cloud * 0.55) * (1 - weather.storm * 0.5);
    const ambient = 0.33 + daylight * 1.0;

    this.sunLight.position.copy(this.sunDir).multiplyScalar(650);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.color.copy(this.sunColor);
    this.sunLight.intensity = sunIntensity;
    this.sunLight.castShadow = sunIntensity > 0.03;
    this.moonLight.position.copy(this.moonDir).multiplyScalar(600);
    this.moonLight.target.position.set(0, 0, 0);
    this.moonLight.intensity = moonIntensity;
    this.moonLight.color.setHex(0x89a9d8);
    this.fillLight.intensity = 0.08 + night * 0.42 + daylight * 0.16;
    this.fillLight.color.copy(this.hemiSky).lerp(new THREE.Color(0x9f7ccc), golden * 0.5);
    this.hemiLight.color.copy(this.horizonColor).lerp(this.hemiSky, daylight * 0.5);
    this.hemiLight.groundColor.setHex(0x17140f);
    this.hemiLight.intensity = ambient * weather.ambient;
    this.flashLight.intensity = flash * 4.2;

    const exposure = weather.exposure * (0.99 + night * 0.08 + golden * 0.05);
    this.renderer.toneMappingExposure = exposure;

    const fogDensity = 0.00042 + weather.fog * 0.0038;
    const fog = this.scene.fog as THREE.FogExp2;
    this.fogColor.copy(this.horizonColor).lerp(this.coolFogDay, daylight * 0.34);
    this.fogColor.lerp(this.coolFog, (1 - daylight) * 0.42 + weather.storm * 0.2);
    this.fogColor.multiplyScalar(0.62 + daylight * 0.14);
    fog.color.copy(this.fogColor);
    fog.density = fogDensity;

    this.skyMesh.position.copy(cameraPosition);
    this.scene.environmentIntensity =
      0.2 + daylight * 0.66 * (1 - weather.storm * 0.35) + golden * 0.1;

    this.uniforms.uTime!.value = elapsed;
    this.uniforms.uDaylight!.value = daylight;
    this.uniforms.uNight!.value = night;
    this.uniforms.uGolden!.value = golden;
    this.uniforms.uCloud!.value = weather.cloud;
    this.uniforms.uStorm!.value = weather.storm;
    this.uniforms.uFlash!.value = flash;
    this.uniforms.uSunDirection!.value = this.sunDir;
    this.uniforms.uMoonDirection!.value = this.moonDir;
    this.uniforms.uSunColor!.value = this.sunColor;
    this.uniforms.uFogColor!.value = fog.color;

    return {
      sunDirection: this.sunDir,
      moonDirection: this.moonDir,
      nightFactor: night,
      daylight,
      golden,
      exposure,
      fogColor: fog.color.getHex(),
      fogDensity,
      sunIntensity,
      moonIntensity,
      ambientIntensity: this.hemiLight.intensity,
      lightningFlash: flash,
      lightsOn,
      cloud: weather.cloud,
      wetness: weather.wet,
      storm: weather.storm,
    };
  }
}
