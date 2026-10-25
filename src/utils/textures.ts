import * as THREE from 'three';
import { mulberry32 } from './random';

function canvasTexture(
  width: number,
  height: number,
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void,
  colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  draw(context, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

export function makeAsphaltTexture(): THREE.CanvasTexture {
  const texture = canvasTexture(512, 512, (ctx, w, h) => {
    const image = ctx.createImageData(w, h);
    const data = image.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const grain = 17 + Math.random() * 20;
        const streak = Math.sin(y * 0.18) * 3;
        data[i] = grain + streak;
        data[i + 1] = grain + streak + 1;
        data[i + 2] = grain + streak + 3;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = '#0b0d11';
    for (let i = 0; i < 120; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      ctx.beginPath();
      ctx.arc(x, y, Math.random() * 2.4, 0, Math.PI * 2);
      ctx.fillStyle = Math.random() > 0.5 ? '#05070a' : '#41474f';
      ctx.fill();
    }
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(110, 110);
  return texture;
}

export function makeGlowTexture(size = 128): THREE.CanvasTexture {
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(0.12, 'rgba(255,255,255,0.92)');
      gradient.addColorStop(0.3, 'rgba(255,255,255,0.38)');
      gradient.addColorStop(0.65, 'rgba(255,255,255,0.08)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    },
    THREE.NoColorSpace,
  );
}

export function makeSoftDotTexture(size = 64): THREE.CanvasTexture {
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(0.3, 'rgba(255,255,255,0.9)');
      gradient.addColorStop(0.8, 'rgba(255,255,255,0.1)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    },
    THREE.NoColorSpace,
  );
}

export function makeRadialFloorTexture(size = 256): THREE.CanvasTexture {
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      gradient.addColorStop(0, 'rgba(255,255,255,0.55)');
      gradient.addColorStop(0.25, 'rgba(255,255,255,0.2)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    },
    THREE.NoColorSpace,
  );
}

export interface SignOptions {
  title: string;
  subtitle?: string;
  accent?: string;
  width?: number;
  height?: number;
  align?: 'left' | 'center';
}

export function makeSignTexture({
  title,
  subtitle = '',
  accent = '#63e6ff',
  width = 768,
  height = 384,
  align = 'left',
}: SignOptions): THREE.CanvasTexture {
  return canvasTexture(width, height, (ctx, w, h) => {
    ctx.fillStyle = '#050910';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.9;
    ctx.strokeRect(14, 14, w - 28, h - 28);
    ctx.globalAlpha = 1;
    const grid = 48;
    ctx.globalAlpha = 0.1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const padding = w * 0.075;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 26;
    ctx.font = `700 ${Math.round(h * 0.29)}px "Bahnschrift", "Arial Narrow", sans-serif`;
    ctx.fillText(title, align === 'center' ? w / 2 : padding, h * 0.47, w - padding * 2);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(223, 244, 255, 0.76)';
    ctx.font = `500 ${Math.round(h * 0.09)}px "Cascadia Mono", Consolas, monospace`;
    ctx.fillText(subtitle, align === 'center' ? w / 2 : padding, h * 0.72, w - padding * 2);
    ctx.fillStyle = accent;
    ctx.fillRect(align === 'center' ? w / 2 - 34 : padding, h * 0.6, 68, 3);
  });
}

export function makeDestinationTexture(): THREE.CanvasTexture {
  return canvasTexture(768, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(4, 12, 21, 0.94)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(99, 230, 255, 0.8)';
    ctx.lineWidth = 5;
    ctx.strokeRect(8, 8, w - 16, h - 16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9cefff';
    ctx.shadowColor = '#63e6ff';
    ctx.shadowBlur = 22;
    ctx.font = '700 66px "Bahnschrift", "Arial Narrow", sans-serif';
    ctx.fillText('DEEPSEEK // HYPERCITY', w / 2, h * 0.43);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(230, 247, 255, 0.72)';
    ctx.font = '500 27px "Cascadia Mono", Consolas, monospace';
    ctx.fillText('NEURAL INFRASTRUCTURE · SECTOR 05 · ONLINE', w / 2, h * 0.74);
  });
}

export function makeWindowArrayTexture(): THREE.CanvasTexture {
  const size = 1024;
  const cells = 16;
  const cellSize = size / cells;
  const texture = canvasTexture(size, size, (ctx) => {
    const rng = mulberry32(0x51a7c0de);
    ctx.clearRect(0, 0, size, size);
    for (let row = 0; row < cells; row++) {
      for (let col = 0; col < cells; col++) {
        const x = col * cellSize;
        const y = row * cellSize;
        const paneX = x + cellSize * 0.25;
        const paneY = y + cellSize * 0.27;
        const paneW = cellSize * 0.5;
        const paneH = cellSize * 0.46;
        const lit = rng() < 0.44;
        const brightness = rangeFrom(rng, 0.3, 1);
        const base = lit
          ? rng() < 0.2
            ? [120, 178, 235]
            : [236, 164, 66]
          : [5, 11, 17];
        const color = `rgb(${Math.round(base[0] * brightness)}, ${Math.round(base[1] * brightness)}, ${Math.round(base[2] * brightness)})`;
        ctx.fillStyle = color;
        ctx.fillRect(paneX, paneY, paneW, paneH);
        if (lit) {
          const glow = ctx.createLinearGradient(paneX, paneY, paneX, paneY + paneH);
          glow.addColorStop(0, 'rgba(255,255,255,0.16)');
          glow.addColorStop(0.5, 'rgba(255,255,255,0.025)');
          glow.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = glow;
          ctx.fillRect(paneX, paneY, paneW, paneH);
        }
      }
    }
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function rangeFrom(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function makeStorefrontTexture(): THREE.CanvasTexture {
  return canvasTexture(
    512,
    160,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const paneWidth = w / 7;
      for (let i = 0; i < 7; i++) {
        const x = i * paneWidth + 5;
        const y = h * 0.16;
        const width = paneWidth - 11;
        const height = h * 0.68;
        const gradient = ctx.createLinearGradient(0, y, 0, y + height);
        const alpha = i % 3 === 0 ? 0.42 : 0.82;
        gradient.addColorStop(0, `rgba(255,255,255,${alpha * 0.42})`);
        gradient.addColorStop(0.48, `rgba(255,255,255,${alpha})`);
        gradient.addColorStop(1, `rgba(255,255,255,${alpha * 0.28})`);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, width, height);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(x, y + height * 0.5, width, 2);
        ctx.fillRect(x + width * 0.52, y, 1.4, height);
        if (i === 2 || i === 5) {
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          ctx.fillRect(x + width * 0.18, y - 8, width * 0.64, 5);
        }
      }
      ctx.fillStyle = 'rgba(255,255,255,0.54)';
      ctx.fillRect(0, 4, w, 2);
      ctx.fillRect(0, h - 6, w, 2);
    },
    THREE.NoColorSpace,
  );
}

export function makeHelipadTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.beginPath();
    ctx.arc(0, 0, w * 0.44, 0, Math.PI * 2);
    ctx.fillStyle = '#192027';
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#d6b96c';
    ctx.stroke();
    ctx.fillStyle = '#d6b96c';
    ctx.font = '700 120px "Bahnschrift", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('H', 0, 7);
  });
}

export function makeRingTexture(size = 256): THREE.CanvasTexture {
  return canvasTexture(
    size,
    size,
    (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 5;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w * 0.43, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w * 0.34, 0, Math.PI * 2);
      ctx.stroke();
    },
    THREE.NoColorSpace,
  );
}
