/** Fixed 60 Hz integration keeps force feedback consistent on high-refresh displays. */
export function createGraphClock(step: () => void) {
  const interval = 1000 / 60;
  let previous: number | null = null;
  let elapsed = 0;
  return {
    reset() { previous = null; elapsed = 0; },
    /** 返回本次推进实际跑了几个物理步（高刷屏上会有 0 步的帧，调用方据此跳过重绘）。 */
    advance(now: number) {
      elapsed += previous === null ? interval : Math.min(50, Math.max(0, now - previous));
      previous = now;
      let ticks = 0;
      while (elapsed + 1e-6 >= interval) { elapsed -= interval; step(); ticks++; }
      return ticks;
    },
  };
}

export interface ForceNode {
  x: number; y: number; vx: number; vy: number; r: number; deg: number; fixed: boolean;
}
export interface ForceLink { a: ForceNode; b: ForceNode }
export interface GraphForces { repulsion: number; linkDist: number; spring: number; gravity: number }

interface QuadCell {
  cx: number;
  cy: number;
  half: number;
  mass: number;
  comX: number;
  comY: number;
  count: number;
  leafIndex: number;
  bucket: number[] | null;
  children: (QuadCell | null)[] | null;
}

const BH_THETA = 0.8;
const BH_MAX_DEPTH = 16;

function createQuad(cx: number, cy: number, half: number): QuadCell {
  return { cx, cy, half, mass: 0, comX: 0, comY: 0, count: 0, leafIndex: -1, bucket: null, children: null };
}

function insertQuad(q: QuadCell, idx: number, nodes: ForceNode[], depth: number) {
  const n = nodes[idx];
  const m = Math.max(0.5, n.r * 0.1);
  const nextMass = q.mass + m;
  q.comX = (q.comX * q.mass + n.x * m) / nextMass;
  q.comY = (q.comY * q.mass + n.y * m) / nextMass;
  q.mass = nextMass;

  if (q.count === 0) {
    q.count = 1;
    q.leafIndex = idx;
    return;
  }
  q.count++;

  if (depth >= BH_MAX_DEPTH || q.half < 0.01) {
    if (!q.bucket) {
      q.bucket = q.leafIndex >= 0 ? [q.leafIndex, idx] : [idx];
      q.leafIndex = -1;
    } else {
      q.bucket.push(idx);
    }
    return;
  }

  if (!q.children) q.children = [null, null, null, null];
  if (q.leafIndex >= 0) {
    const oldIdx = q.leafIndex;
    q.leafIndex = -1;
    placeInChild(q, oldIdx, nodes, depth);
  }
  placeInChild(q, idx, nodes, depth);
}

function placeInChild(q: QuadCell, idx: number, nodes: ForceNode[], depth: number) {
  const n = nodes[idx];
  const east = n.x >= q.cx ? 1 : 0;
  const south = n.y >= q.cy ? 1 : 0;
  const slot = east + south * 2;
  const subHalf = q.half * 0.5;
  let child = q.children![slot];
  if (!child) {
    child = createQuad(
      q.cx + (east ? subHalf : -subHalf),
      q.cy + (south ? subHalf : -subHalf),
      subHalf,
    );
    q.children![slot] = child;
  }
  insertQuad(child, idx, nodes, depth + 1);
}

function applyPairRepel(i: number, j: number, nodes: ForceNode[], forces: GraphForces, alpha: number) {
  if (i === j) return;
  const a = nodes[i];
  if (a.fixed) return;
  const b = nodes[j];
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let distance = Math.hypot(dx, dy);
  // Deterministic symmetric separation of coincident nodes avoids random force changes each frame.
  if (distance < 0.01) {
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const sign = i < j ? 1 : -1;
    const angle = (lo * 0.754877666 + hi * 0.569840296) * Math.PI * 2;
    dx = Math.cos(angle) * sign;
    dy = Math.sin(angle) * sign;
    distance = 1;
  }
  const repel = forces.repulsion * alpha * (a.r + b.r) * 0.02 / Math.max(100, distance * distance + 120);
  const gap = a.r + b.r + 10;
  const overlap = Math.max(0, gap - distance);
  const collision = overlap * 0.12 / Math.sqrt(1 + Math.max(a.deg, b.deg));
  const impulse = repel + collision;
  a.vx -= (dx / distance) * impulse;
  a.vy -= (dy / distance) * impulse;
}

function evalQuadRepel(i: number, q: QuadCell, nodes: ForceNode[], forces: GraphForces, alpha: number) {
  if (q.count === 0) return;
  if (q.leafIndex >= 0) {
    applyPairRepel(i, q.leafIndex, nodes, forces, alpha);
    return;
  }
  if (q.bucket) {
    for (const j of q.bucket) applyPairRepel(i, j, nodes, forces, alpha);
    return;
  }
  const a = nodes[i];
  const dx = q.comX - a.x;
  const dy = q.comY - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance > 1 && (q.half * 2) / distance < BH_THETA) {
    const impulse = (forces.repulsion * alpha * q.mass * 0.18) / (distance * distance + 180);
    a.vx -= (dx / distance) * impulse;
    a.vy -= (dy / distance) * impulse;
    return;
  }
  if (q.children) {
    for (const child of q.children) {
      if (child) evalQuadRepel(i, child, nodes, forces, alpha);
    }
  }
}

/**
 * Barnes-Hut O(n log n) 全局斥力 + 软碰撞 + 连线弹簧；
 * 不连通星团与孤立点相互排开，不再在 240px 外失去斥力被向心力压成一团。
 */
export function stepGraphForces(nodes: ForceNode[], links: ForceLink[], forces: GraphForces, alpha: number) {
  if (nodes.length > 1) {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const half = Math.max(1, Math.max(maxX - minX, maxY - minY) * 0.5 + 1);
    const root = createQuad((minX + maxX) * 0.5, (minY + maxY) * 0.5, half);
    for (let i = 0; i < nodes.length; i++) insertQuad(root, i, nodes, 0);
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].fixed) evalQuadRepel(i, root, nodes, forces, alpha);
    }
  }
  for (const { a, b } of links) {
    const dx = b.x - a.x; const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1;
    // Normalize stiffness by degree so a dense hub cannot kick its neighbors back and forth.
    const impulse = (distance - forces.linkDist) * forces.spring * alpha / Math.max(1, a.deg, b.deg);
    const fx = dx / distance * impulse; const fy = dy / distance * impulse;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  }
  let maxSpeed = 0;
  for (const n of nodes) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    // 孤立节点减小中心拉力，使其自然分布在核心星系外环而不是挤进主团簇
    const gravScale = n.deg === 0 ? 0.45 : 1;
    n.vx = (n.vx - n.x * forces.gravity * gravScale * alpha * 0.12) * 0.82;
    n.vy = (n.vy - n.y * forces.gravity * gravScale * alpha * 0.12) * 0.82;
    const speed = Math.hypot(n.vx, n.vy);
    if (speed > 4.5) { n.vx *= 4.5 / speed; n.vy *= 4.5 / speed; }
    maxSpeed = Math.max(maxSpeed, Math.hypot(n.vx, n.vy));
    n.x += n.vx; n.y += n.vy;
  }
  return maxSpeed;
}
