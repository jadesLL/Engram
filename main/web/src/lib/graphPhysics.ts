/** Fixed 60 Hz integration keeps force feedback consistent on high-refresh displays. */
export function createGraphClock(step: () => void) {
  const interval = 1000 / 60;
  let previous: number | null = null;
  let elapsed = 0;
  return {
    reset() { previous = null; elapsed = 0; },
    advance(now: number) {
      elapsed += previous === null ? interval : Math.min(50, Math.max(0, now - previous));
      previous = now;
      while (elapsed + 1e-6 >= interval) { elapsed -= interval; step(); }
    },
  };
}

export interface ForceNode {
  x: number; y: number; vx: number; vy: number; r: number; deg: number; fixed: boolean;
}
export interface ForceLink { a: ForceNode; b: ForceNode }
export interface GraphForces { repulsion: number; linkDist: number; spring: number; gravity: number }

/** Soft collision impulses preserve momentum instead of moving positions after integration. */
export function stepGraphForces(nodes: ForceNode[], links: ForceLink[], forces: GraphForces, alpha: number) {
  const reach = 240;
  const cells = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const key = `${Math.floor(n.x / reach)}:${Math.floor(n.y / reach)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(i); else cells.set(key, [i]);
  });
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const gx = Math.floor(a.x / reach); const gy = Math.floor(a.y / reach);
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      for (const j of cells.get(`${gx + ox}:${gy + oy}`) || []) {
        if (j <= i) continue;
        const b = nodes[j];
        let dx = b.x - a.x; let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= reach) continue;
        // Deterministic separation of coincident nodes avoids random force changes each frame.
        if (distance < 0.01) {
          const angle = (i * 0.754877666 + j * 0.569840296) * Math.PI * 2;
          dx = Math.cos(angle); dy = Math.sin(angle); distance = 1;
        }
        const taper = (1 - distance / reach) ** 2;
        const repel = forces.repulsion * alpha * (a.r + b.r) * 0.02 * taper / Math.max(100, distance * distance);
        const gap = a.r + b.r + 10;
        const overlap = Math.max(0, gap - distance);
        const collision = overlap * 0.12 / Math.sqrt(1 + Math.max(a.deg, b.deg));
        const impulse = repel + collision;
        const fx = dx / distance * impulse; const fy = dy / distance * impulse;
        if (!a.fixed) { a.vx -= fx; a.vy -= fy; }
        if (!b.fixed) { b.vx += fx; b.vy += fy; }
      }
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
    n.vx = (n.vx - n.x * forces.gravity * alpha * 0.12) * 0.82;
    n.vy = (n.vy - n.y * forces.gravity * alpha * 0.12) * 0.82;
    const speed = Math.hypot(n.vx, n.vy);
    if (speed > 4.5) { n.vx *= 4.5 / speed; n.vy *= 4.5 / speed; }
    maxSpeed = Math.max(maxSpeed, Math.hypot(n.vx, n.vy));
    n.x += n.vx; n.y += n.vy;
  }
  return maxSpeed;
}
