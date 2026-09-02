// 思考球（"组织"风格）点阵动画 — 自研 Canvas 2D 实现。
// 视觉规格参考 sd-design ThinkingOrb 的 composing 状态文档
// (https://sd-design.js.org/components/thinking-orb/)：
// 多条点阵带沿着一个大圆行进，波形沿带传播，整体朝向固定（不翻滚），
// 深度只用点的大小与灰度表达。纯 2D 绘制，无滤镜。
// 注：sd-design 组件源码为 AGPL-3.0，未直接搬用；此处为独立实现。

interface OrbDot {
  x: number;
  y: number;
  z: number;
  r: number;
  white: number;
  a: number;
}

/** 单位球面上的均匀方向（Fibonacci 格）。 */
function fibDir(i: number, n: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (2 * (i + 0.5)) / n;
  const rad = Math.sqrt(1 - y * y);
  const a = i * golden;
  return [rad * Math.cos(a), y, rad * Math.sin(a)];
}

/** 偏航 + 相机俯仰的正交投影。 */
function makeProj(yaw: number, tilt: number, cx: number, cy: number) {
  const st = Math.sin(tilt);
  const ct = Math.cos(tilt);
  const sy = Math.sin(yaw);
  const cyw = Math.cos(yaw);
  return (x: number, y: number, z: number): [number, number, number] => {
    const x1 = x * cyw + z * sy;
    const z1 = -x * sy + z * cyw;
    const y1 = y * ct - z1 * st;
    const z2 = y * st + z1 * ct;
    return [cx + x1, cy - y1, z2];
  };
}

/**
 * 绘制一帧 "组织" 思考球：固定朝向的大圆上多条点阵带，
 * 两组行波沿带传播产生起伏；背后一层稀薄的幽灵球面衬托体积感。
 */
export function drawComposingOrb(
  ctx: CanvasRenderingContext2D,
  size: number,
  t: number,
  dark: boolean,
): void {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.78;
  const tilt = 0.3;
  const pt = makeProj(0, tilt, cx, cy);
  // 点半径按 300px 基准帧亚线性缩放，小尺寸下保持可读
  const rs = (size / 300) ** 0.6;

  const dots: OrbDot[] = [];

  // 幽灵球面
  const ghostN = 38;
  for (let i = 0; i < ghostN; i++) {
    const d = fibDir(i, ghostN);
    const [px, py, z] = pt(d[0] * R, d[1] * R, d[2] * R);
    const depth = (z / R + 1) / 2;
    dots.push({ x: px, y: py, z, r: 0.8 * rs, white: 0.78, a: 0.1 + 0.22 * depth });
  }

  // 点阵带：朝向固定的大圆平面（u,v 为平面基，n 为法线）
  const ta = 0.55; // 带平面相对相机的固定倾角
  const ux = 1;
  const uy = 0;
  const uz = 0;
  const vx = 0;
  const vy = Math.cos(ta);
  const vz = Math.sin(ta);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;

  const lanes = 4;
  const segs = 22;
  for (let w = 0; w < lanes; w++) {
    const laneOff = (w - (lanes - 1) / 2) * 0.075;
    const edge = Math.abs(w - (lanes - 1) / 2) / Math.max(1, (lanes - 1) / 2);
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * 2 * Math.PI;
      // 行波：两组沿带传播的正弦叠加
      const wob = 0.16 * Math.sin(a * 3 - t * 1.7 + w * 0.22) + 0.07 * Math.sin(a * 5 + t * 1.1);
      const off = laneOff + wob;
      const x = ux * Math.cos(a) + vx * Math.sin(a) + nx * off;
      const y = uy * Math.cos(a) + vy * Math.sin(a) + ny * off;
      const z = uz * Math.cos(a) + vz * Math.sin(a) + nz * off;
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      const [px, py, zr] = pt((x / l) * R, (y / l) * R, (z / l) * R);
      const depth = (zr / R + 1) / 2;
      dots.push({
        x: px,
        y: py,
        z: zr,
        r: (1.1 + 1.7 * depth) * (1 - 0.25 * edge) * rs,
        white: 0.52 - 0.44 * depth + 0.18 * edge,
        a: 0.4 + 0.6 * depth,
      });
    }
  }

  // 远→近排序；深色底上灰度取反，近处亮点
  dots.sort((a, b) => a.z - b.z);
  for (const d of dots) {
    if (d.a < 0.02) continue;
    const wv = Math.min(1, Math.max(0, d.white));
    const g = Math.round((dark ? 1 - wv : wv) * 255);
    ctx.fillStyle = `rgba(${g},${g},${g},${d.a})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(0.3, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
}
