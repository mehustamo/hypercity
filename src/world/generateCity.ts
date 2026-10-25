import type {
  BlockPlan,
  BuildingPlan,
  BuildingStyle,
  BuildingVolume,
  CityPlan,
  DistrictKind,
  TreePlan,
} from '../types';
import { hashString, intRange, mulberry32, pick, range, weighted, type Rng } from '../utils/random';

export const CITY_CONSTANTS = {
  blocksAcross: 11,
  pitch: 56,
  blockSize: 42,
  roadWidth: 14,
  sidewalkY: 0.26,
} as const;

const NAME_PREFIX = [
  'NOVA',
  'AETHER',
  'VANTA',
  'HELIX',
  'ORBIT',
  'LUMEN',
  'KESTREL',
  'NORTH',
  'ECHO',
  'PARALLAX',
  'VECTOR',
  'CIPHER',
  'AXIOM',
  'SOLACE',
  'MONSOON',
  'QUARTZ',
  'EMBER',
  'HALCYON',
  'TIDAL',
  'ZEPHYR',
  'MERIDIAN',
  'SIGNAL',
] as const;

const NAME_SUFFIX = [
  'TOWER',
  'HOUSE',
  'WORKS',
  'EXCHANGE',
  'LABS',
  'ARCADE',
  'TERRACE',
  'GATE',
  'STATION',
  'ATRIUM',
  'QUARTERS',
  'FORUM',
] as const;

const TENANTS = [
  'SYNAPSE LABS',
  'NORTHSTAR LOGISTICS',
  'HELIX BIOTECH',
  'DEEP SIGNAL',
  'AEON SYSTEMS',
  'PARALLAX MEDIA',
  'ORBITAL FREIGHT',
  'NOVA ENERGY',
  'KESTREL & CO.',
  'ECHO FOUNDRY',
  'MERIDIAN CAPITAL',
  'AXIOM RESEARCH',
  'VECTOR CLINIC',
  'NEURAL ARCHIVE',
] as const;

const PALETTES: Record<BuildingStyle, number[]> = {
  glass: [0x142b3d, 0x173248, 0x1b2a3a, 0x213b50, 0x152833, 0x243342, 0x1d3b4e],
  concrete: [0x2d3137, 0x3b3b3c, 0x41403c, 0x343a3f, 0x494640, 0x2c3338, 0x4d4a43],
  stone: [0x4b443b, 0x574f43, 0x5f5548, 0x403d39, 0x514c42],
};

function districtFor(ix: number, iz: number, across: number): DistrictKind {
  const centre = (across - 1) / 2;
  const radius = Math.hypot(ix - centre, iz - centre);
  if (radius <= 1.2) return 'core';
  if (radius <= 2.75) return 'midtown';
  if (radius <= 4.2) return 'residential';
  return 'industrial';
}

function heightFor(rng: Rng, district: DistrictKind): number {
  switch (district) {
    case 'core':
      return Math.round(weighted(rng, [
        { value: range(rng, 62, 115), weight: 5 },
        { value: range(rng, 115, 165), weight: 3 },
        { value: range(rng, 165, 205), weight: 1 },
      ]));
    case 'midtown':
      return Math.round(weighted(rng, [
        { value: range(rng, 32, 62), weight: 4 },
        { value: range(rng, 62, 108), weight: 3 },
        { value: range(rng, 108, 145), weight: 1 },
      ]));
    case 'residential':
      return Math.round(range(rng, 14, 46));
    case 'industrial':
      return Math.round(range(rng, 8, 25));
  }
}

function styleFor(rng: Rng, district: DistrictKind): BuildingStyle {
  if (district === 'industrial') {
    return weighted(rng, [
      { value: 'concrete' as const, weight: 7 },
      { value: 'stone' as const, weight: 3 },
    ]);
  }
  if (district === 'residential') {
    return weighted(rng, [
      { value: 'stone' as const, weight: 5 },
      { value: 'concrete' as const, weight: 4 },
      { value: 'glass' as const, weight: 2 },
    ]);
  }
  return weighted(rng, [
    { value: 'glass' as const, weight: district === 'core' ? 6 : 4 },
    { value: 'concrete' as const, weight: 4 },
    { value: 'stone' as const, weight: 2 },
  ]);
}

function makeName(rng: Rng): string {
  return `${pick(rng, NAME_PREFIX)} ${pick(rng, NAME_SUFFIX)}`;
}

function makeBuilding(
  rng: Rng,
  x: number,
  z: number,
  w: number,
  d: number,
  district: DistrictKind,
  blockX: number,
  blockZ: number,
  index: number,
): BuildingPlan {
  const style = styleFor(rng, district);
  const color = pick(rng, PALETTES[style]);
  const baseHeight = heightFor(rng, district);
  const seed = Math.floor(rng() * 1_000_000);
  const volumes: BuildingVolume[] = [];
  let total = 0;

  // The podium anchors the building to the block, then 1-2 slender tiers give it silhouette.
  const podiumFraction = range(rng, 0.42, 0.7);
  const podiumHeight = baseHeight * podiumFraction;
  const podiumColor = adjustColor(color, range(rng, -0.07, 0.08));
  volumes.push({ x, y: CITY_CONSTANTS.sidewalkY, z, w, h: podiumHeight, d, color: podiumColor, style });
  total = podiumHeight;

  const tierCount = baseHeight > 34 ? (rng() < 0.45 ? 2 : 1) : rng() < 0.3 ? 1 : 0;
  let currentW = w;
  let currentD = d;
  for (let tier = 0; tier < tierCount; tier++) {
    const remaining = baseHeight - total;
    const fraction = tier === tierCount - 1 ? 1 : range(rng, 0.5, 0.72);
    const tierHeight = Math.max(4, remaining * fraction);
    currentW *= range(rng, 0.68, 0.88);
    currentD *= range(rng, 0.68, 0.88);
    const offsetX = range(rng, -1, 1) * Math.max(0, (w - currentW) * 0.28);
    const offsetZ = range(rng, -1, 1) * Math.max(0, (d - currentD) * 0.28);
    volumes.push({
      x: x + offsetX,
      y: CITY_CONSTANTS.sidewalkY + total,
      z: z + offsetZ,
      w: currentW,
      h: tierHeight,
      d: currentD,
      color: adjustColor(color, range(rng, -0.06, 0.1)),
      style,
    });
    total += tierHeight;
  }

  const topHeight = total;
  const isTall = topHeight > 85;
  return {
    id: `b-${blockX}-${blockZ}-${index}`,
    name: makeName(rng),
    blockX,
    blockZ,
    x,
    z,
    w,
    d,
    height: topHeight,
    floors: Math.max(2, Math.round(topHeight / 3.35)),
    district,
    style,
    color,
    seed,
    volumes,
    hasAntenna: isTall ? rng() < 0.36 : rng() < 0.08,
    hasHelipad: isTall && rng() < 0.22,
    hasBeacon: isTall && rng() < 0.55,
    hasNeonBand: (district === 'core' || district === 'midtown') && rng() < 0.26,
    neonColor: pick(rng, [0x5de9ff, 0x9d7bff, 0xff5fd2, 0xffb15e, 0x4f9cff]),
    occupancy: Math.round(range(rng, 48, 98)),
    energy: Math.round(range(rng, 40, 100)),
    built: Math.round(range(rng, 2015, 2068)),
    tenant: pick(rng, TENANTS),
    landmark: false,
  };
}

function adjustColor(hex: number, amount: number): number {
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 0xff) + 255 * amount));
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 0xff) + 255 * amount));
  const b = Math.min(255, Math.max(0, (hex & 0xff) + 255 * amount));
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

function makeLandmark(x: number, z: number): BuildingPlan {
  const seed = 818181;
  const color = 0x21374a;
  const volumes: BuildingVolume[] = [
    { x, y: CITY_CONSTANTS.sidewalkY, z, w: 27, h: 88, d: 27, color, style: 'glass' },
    { x, y: CITY_CONSTANTS.sidewalkY + 88, z, w: 21.5, h: 60, d: 21.5, color: 0x274257, style: 'glass' },
    { x, y: CITY_CONSTANTS.sidewalkY + 148, z, w: 15, h: 40, d: 15, color: 0x2c4a60, style: 'glass' },
    { x, y: CITY_CONSTANTS.sidewalkY + 188, z, w: 7, h: 18, d: 7, color: 0x334f61, style: 'glass' },
  ];
  const height = 206;
  return {
    id: 'landmark',
    name: 'MERIDIAN SPIRE',
    blockX: 6,
    blockZ: 5,
    x,
    z,
    w: 27,
    d: 27,
    height,
    floors: 58,
    district: 'core',
    style: 'glass',
    color,
    seed,
    volumes,
    hasAntenna: true,
    hasHelipad: false,
    hasBeacon: true,
    hasNeonBand: true,
    neonColor: 0x63e6ff,
    occupancy: 96,
    energy: 99,
    built: 2071,
    tenant: 'DEEPSEEK RESEARCH',
    landmark: true,
  };
}

export function generateCity(seedInput: number | string): CityPlan {
  const seed = typeof seedInput === 'number' ? seedInput >>> 0 : hashString(String(seedInput));
  const rng = mulberry32(seed);
  const { blocksAcross, pitch, blockSize, roadWidth } = CITY_CONSTANTS;
  const centre = (blocksAcross - 1) / 2;
  const extent = (blocksAcross * pitch) / 2 + blockSize / 2;
  const roadLines: number[] = [];
  for (let i = 0; i <= blocksAcross; i++) {
    roadLines.push((i - blocksAcross / 2) * pitch);
  }

  const blocks: BlockPlan[] = [];
  const buildings: BuildingPlan[] = [];
  const trees: TreePlan[] = [];
  let landmark: BuildingPlan | null = null;

  for (let iz = 0; iz < blocksAcross; iz++) {
    for (let ix = 0; ix < blocksAcross; ix++) {
      const x = (ix - centre) * pitch;
      const z = (iz - centre) * pitch;
      const coreBlock = ix === 5 && iz === 5;
      const parkBlock = ix === 4 && iz === 4;
      const landmarkBlock = ix === 6 && iz === 5;
      const kind = coreBlock ? 'core' : parkBlock ? 'park' : landmarkBlock ? 'landmark' : 'city';
      blocks.push({ ix, iz, x, z, size: blockSize, kind });

      if (kind === 'core' || kind === 'park') continue;
      if (kind === 'landmark') {
        landmark = makeLandmark(x, z);
        buildings.push(landmark);
        continue;
      }

      const district = districtFor(ix, iz, blocksAcross);
      const usable = blockSize - 7.2;
      const twoByTwo = rng() < (district === 'core' ? 0.66 : 0.58);
      const oneByTwo = !twoByTwo && rng() < 0.42;
      const gap = 1.8;
      let lots: { x: number; z: number; w: number; d: number }[] = [];

      if (!twoByTwo && !oneByTwo) {
        const w = usable * range(rng, 0.62, 0.9);
        const d = usable * range(rng, 0.62, 0.9);
        lots = [{ x, z, w, d }];
      } else if (oneByTwo) {
        const cell = (usable - gap) / 2;
        const w = usable * range(rng, 0.98, 1);
        lots = [
          { x, z: z - cell / 2 - gap / 2, w, d: cell },
          { x, z: z + cell / 2 + gap / 2, w, d: cell },
        ];
      } else {
        const cell = (usable - gap) / 2;
        for (let lz = 0; lz < 2; lz++) {
          for (let lx = 0; lx < 2; lx++) {
            lots.push({
              x: x + (lx === 0 ? -1 : 1) * (cell / 2 + gap / 2),
              z: z + (lz === 0 ? -1 : 1) * (cell / 2 + gap / 2),
              w: cell,
              d: cell,
            });
          }
        }
      }

      let lotIndex = 0;
      for (const lot of lots) {
        const skipChance = district === 'core' ? 0.025 : district === 'industrial' ? 0.16 : 0.065;
        if (rng() < skipChance) {
          lotIndex++;
          continue;
        }
        const width = lot.w * (twoByTwo || oneByTwo ? range(rng, 0.83, 0.98) : range(rng, 0.78, 0.96));
        const depth = lot.d * (twoByTwo || oneByTwo ? range(rng, 0.83, 0.98) : range(rng, 0.78, 0.96));
        const jitterX = twoByTwo || oneByTwo ? 0 : range(rng, -1.2, 1.2);
        const jitterZ = twoByTwo || oneByTwo ? 0 : range(rng, -1.2, 1.2);
        buildings.push(
          makeBuilding(rng, lot.x + jitterX, lot.z + jitterZ, width, depth, district, ix, iz, lotIndex),
        );
        lotIndex++;
      }
    }
  }

  // Park canopy and sidewalk trees. The park gets the densest planting.
  const parkX = (4 - centre) * pitch;
  const parkZ = (4 - centre) * pitch;
  const parkRadius = 16;
  for (let i = 0; i < 34; i++) {
    const angle = rng() * Math.PI * 2;
    const radius = 9.4 + Math.sqrt(rng()) * (parkRadius - 9.4);
    trees.push({
      x: parkX + Math.cos(angle) * radius,
      z: parkZ + Math.sin(angle) * radius,
      scale: range(rng, 0.65, 1.25),
      hue: range(rng, 0.88, 1.03),
    });
  }
  for (const block of blocks) {
    if (block.kind !== 'city') continue;
    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const;
    const count = intRange(rng, 1, 3);
    for (let i = 0; i < count; i++) {
      const corner = corners[Math.floor(rng() * 4)]!;
      if (rng() < 0.35) continue;
      const ox = corner[0] * (blockSize / 2 - 2.2);
      const oz = corner[1] * (blockSize / 2 - 2.2);
      trees.push({
        x: block.x + ox + range(rng, -1.2, 1.2),
        z: block.z + oz + range(rng, -1.2, 1.2),
        scale: range(rng, 0.55, 1.0),
        hue: range(rng, 0.9, 1.06),
      });
    }
  }

  return {
    seed,
    blocksAcross,
    pitch,
    blockSize,
    roadWidth,
    extent,
    roadLines,
    blocks,
    buildings,
    trees,
    core: { x: 0, z: 0, radius: 16 },
    park: { x: parkX, z: parkZ, size: blockSize },
    landmark,
  };
}
