import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphClock, stepGraphForces, type ForceNode } from './graphPhysics.ts';

const forces = { repulsion: 1500, linkDist: 104, spring: 0.18, gravity: 0.026 };
const node = (x: number, y = 0): ForceNode => ({ x, y, vx: 0, vy: 0, r: 10, deg: 1, fixed: false });

test('dragged node stays at the pointer while connected neighbors move smoothly', () => {
  const a = node(-52); const b = node(52);
  a.fixed = true; a.x -= 100;
  const speeds: number[] = [];
  for (let i = 0; i < 60; i++) speeds.push(stepGraphForces([a, b], [{ a, b }], forces, 0.25));
  assert.equal(a.x, -152);
  assert.equal(a.vx, 0);
  assert.ok(b.x < 40, 'the neighbor must react to the stretched link');
  assert.ok(Math.max(...speeds) <= 4.5 + 1e-6);
  assert.ok(speeds[0] < 4.5, 'dragging should not immediately kick neighbors to their speed limit');
});

test('release preserves inertia then cools to a stable layout', () => {
  const a = node(-152); const b = node(52); a.fixed = true;
  for (let i = 0; i < 45; i++) stepGraphForces([a, b], [{ a, b }], forces, 0.25);
  a.fixed = false;
  let alpha = 0.25; let speed = 0;
  const before = b.x;
  for (let i = 0; i < 300; i++) {
    speed = stepGraphForces([a, b], [{ a, b }], forces, alpha);
    alpha *= 0.975;
  }
  assert.notEqual(b.x, before);
  assert.ok(alpha < 0.004 && speed < 0.035);
  assert.ok(Number.isFinite(a.x) && Number.isFinite(b.x));
});

test('coincident dense hubs separate without random position kicks or excessive speed', () => {
  const nodes = Array.from({ length: 150 }, () => ({ ...node(0), deg: 12 }));
  const links = nodes.flatMap((a, i) => [1, 7, 19].map((offset) => ({ a, b: nodes[(i + offset) % nodes.length] })));
  for (let frame = 0; frame < 240; frame++) {
    const previous = nodes.map((n) => ({ x: n.x, y: n.y }));
    stepGraphForces(nodes, links, forces, Math.pow(0.975, frame));
    nodes.forEach((n, i) => {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
      assert.ok(Math.hypot(n.x - previous[i].x, n.y - previous[i].y) <= 4.5 + 1e-6);
    });
  }
  assert.ok(Math.max(...nodes.map((n) => Math.hypot(n.x, n.y))) > 30);
});

test('60 Hz and 120 Hz displays integrate the same amount of physics', () => {
  const count = (hz: number) => {
    let ticks = 0;
    const clock = createGraphClock(() => ticks++);
    for (let i = 0; i <= hz * 2; i++) clock.advance(i * 1000 / hz);
    return ticks;
  };
  assert.equal(count(60), count(120));
  let ticks = 0;
  const clock = createGraphClock(() => ticks++);
  clock.advance(0); clock.advance(5000);
  assert.equal(ticks, 4, 'a background tab cannot cause a long catch-up frame');
  clock.reset(); clock.advance(10000);
  assert.equal(ticks, 5);
});
