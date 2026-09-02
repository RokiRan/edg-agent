import { useEffect, useRef } from 'react';
import { drawComposingOrb } from '../../lib/orb';

/** 思考球（"组织"风格点阵动画）。rAF 驱动；系统减少动态时绘制静态代表帧。 */
export function ThinkingOrb({ size = 20 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const drawFrame = (time: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawComposingOrb(ctx, size, time, true);
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      drawFrame(0.6);
      return;
    }

    // 与参考实现一致的速度基调（composing 预设 20px 档 ≈ 3.1 倍速）
    const speed = size <= 20 ? 3.12 : 2.34;
    let raf = 0;
    let running = true;
    const loop = () => {
      drawFrame((performance.now() / 1000) * speed);
      if (running) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-state="composing"
      style={{ width: size, height: size }}
    />
  );
}
