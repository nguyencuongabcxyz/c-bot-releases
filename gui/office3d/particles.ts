// What floats off the robot and its desk (steam, z's, hearts, stars…): a sprite each, rising,
// growing and fading over its life.
import * as THREE from 'three';
import type { ParticleKind, ParticleOpts } from './antics/types';
import { noOutline, spriteTexture } from './materials';

/** A particle in flight (emit). */
type Particle = {
  s: THREE.Sprite;
  life: number;
  age: number;
  vel: THREE.Vector3;
  size: number;
  grow: number;
  spin: number;
  gravity: number;
};

const KINDS: ParticleKind[] = [
  'steam',
  'z',
  'heart',
  'sweat',
  'bulb',
  'question',
  'doc',
  'crumb',
  'star',
  'squeak',
  'note',
  'ball',
  'bolt',
  'haha',
];

export function createParticles(world: THREE.Group) {
  const particles: Particle[] = [];
  const textures = Object.fromEntries(KINDS.map((k) => [k, spriteTexture(k)]));
  function emit(
    kind: ParticleKind,
    pos: THREE.Vector3,
    { life = 1.2, vel = new THREE.Vector3(0, 0.4, 0), size = 0.14, grow = 1, spin = 0, gravity = 0 }: ParticleOpts = {},
  ) {
    const mat = noOutline(new THREE.SpriteMaterial({ map: textures[kind], transparent: true, depthWrite: false }));
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(size);
    world.add(s);
    particles.push({ s, life, age: 0, vel, size, grow, spin, gravity });
  }

  /** Each particle on through its life; gone at the end of it. */
  function tick(dt: number) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      const life = p.age / p.life;
      if (life >= 1) {
        world.remove(p.s);
        p.s.material.dispose();
        particles.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.s.position.addScaledVector(p.vel, dt);
      p.s.scale.setScalar(p.size * (1 + (p.grow - 1) * life) * Math.min(1, p.age * 8));
      p.s.material.opacity = life < 0.7 ? 1 : 1 - (life - 0.7) / 0.3;
      p.s.material.rotation = Math.sin(p.age * 4) * 0.2 * p.spin;
    }
  }

  return {
    emit,
    tick,
    /** how many are in flight */
    get count() {
      return particles.length;
    },
  };
}
export type Particles = ReturnType<typeof createParticles>;
