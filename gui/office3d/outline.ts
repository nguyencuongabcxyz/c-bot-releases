// The ink outline round everything in the office: the scene drawn a second time, each mesh's
// back faces pushed out a little and filled with the ink colour.
//
// A port of three's OutlineEffect (examples/jsm/effects/OutlineEffect.js, three r187, MIT,
// © three.js authors), the same shaders and the same per-material outlineParameters
// (thickness, color, alpha, visible, keepAlive). One change: three's never forgets an object or
// a material it has drawn (it only blanks their entries) and walks them all every frame, so a
// robot window got a little slower with every antic's props. Here what a frame records is
// cleared after it, and an outline material no longer used is disposed.
import * as THREE from 'three';

/** How each material's outline is drawn (on material.userData.outlineParameters). */
type OutlineParameters = {
  thickness?: number;
  color?: [number, number, number];
  alpha?: number;
  visible?: boolean;
  keepAlive?: boolean;
};
type Options = {
  defaultThickness?: number;
  defaultColor?: [number, number, number];
  defaultAlpha?: number;
  defaultKeepAlive?: boolean;
};
// (what of a material the outline copies; the displacement fields only some materials have)
type Original = THREE.Material & {
  displacementMap?: THREE.Texture | null;
  displacementScale?: number;
  displacementBias?: number;
  wireframe?: boolean;
  fog?: boolean;
};
// (three's program cache reads displacementMap off any material: the outline sets it too)
type OutlineMaterial = THREE.ShaderMaterial & { displacementMap?: THREE.Texture | null };
type Outlined = THREE.Mesh<THREE.BufferGeometry, Original | Original[]>;

/** Frames an outline material may go unused before it's disposed (three's removeThresholdCount). */
export const UNUSED_FRAMES = 60;

/** Outline materials by the material they outline: made on first use, disposed once unused for
 *  UNUSED_FRAMES sweeps (one sweep a frame) unless kept alive. */
export function outlineCache<K, M>(make: () => M, dispose: (m: M) => void, keepAlive = false) {
  const entries = new Map<K, { material: M; used: boolean; keepAlive: boolean; count: number }>();
  return {
    get(key: K): M {
      let e = entries.get(key);
      if (!e) {
        e = { material: make(), used: true, keepAlive, count: 0 };
        entries.set(key, e);
      }
      e.used = true;
      return e.material;
    },
    keepAlive(key: K, on: boolean) {
      const e = entries.get(key);
      if (e) e.keepAlive = on;
    },
    /** After a frame: what it didn't use counts towards going. */
    sweep() {
      for (const [key, e] of entries) {
        if (e.used) {
          e.used = false;
          e.count = 0;
        } else if (++e.count > UNUSED_FRAMES && !e.keepAlive) {
          entries.delete(key);
          dispose(e.material);
        }
      }
    },
    get size() {
      return entries.size;
    },
  };
}

const VERTEX = [
  '#include <common>',
  '#include <uv_pars_vertex>',
  '#include <displacementmap_pars_vertex>',
  '#include <fog_pars_vertex>',
  '#include <morphtarget_pars_vertex>',
  '#include <skinning_pars_vertex>',
  '#include <logdepthbuf_pars_vertex>',
  '#include <clipping_planes_pars_vertex>',
  'uniform float outlineThickness;',
  'vec4 calculateOutline( vec4 pos, vec3 normal, vec4 skinned ) {',
  '	float thickness = outlineThickness;',
  '	const float ratio = 1.0;',
  '	vec4 pos2 = projectionMatrix * modelViewMatrix * vec4( skinned.xyz + normal, 1.0 );',
  // (subtract pos2 from pos: a BackSide objectNormal is negative)
  '	vec4 norm = normalize( pos - pos2 );',
  '	return pos + norm * thickness * pos.w * ratio;',
  '}',
  'void main() {',
  '	#include <uv_vertex>',
  '	#include <beginnormal_vertex>',
  '	#include <morphnormal_vertex>',
  '	#include <skinbase_vertex>',
  '	#include <skinnormal_vertex>',
  '	#include <begin_vertex>',
  '	#include <morphtarget_vertex>',
  '	#include <skinning_vertex>',
  '	#include <displacementmap_vertex>',
  '	#include <project_vertex>',
  '	vec3 outlineNormal = - objectNormal;', // (the outline is always drawn with BackSide)
  '	gl_Position = calculateOutline( gl_Position, outlineNormal, vec4( transformed, 1.0 ) );',
  '	#include <logdepthbuf_vertex>',
  '	#include <clipping_planes_vertex>',
  '	#include <fog_vertex>',
  '}',
].join('\n');

const FRAGMENT = [
  '#include <common>',
  '#include <fog_pars_fragment>',
  '#include <logdepthbuf_pars_fragment>',
  '#include <clipping_planes_pars_fragment>',
  'uniform vec3 outlineColor;',
  'uniform float outlineAlpha;',
  'void main() {',
  '	#include <clipping_planes_fragment>',
  '	#include <logdepthbuf_fragment>',
  '	gl_FragColor = vec4( outlineColor, outlineAlpha );',
  '	#include <tonemapping_fragment>',
  '	#include <colorspace_fragment>',
  '	#include <fog_fragment>',
  '	#include <premultiplied_alpha_fragment>',
  '}',
].join('\n');

const isOutlined = (o: THREE.Object3D): o is Outlined =>
  'isMesh' in o &&
  !!o.isMesh &&
  'material' in o &&
  o.material !== undefined &&
  !!(o as Outlined).geometry?.attributes.normal; // (isMesh just checked)

/** The outline effect: render(scene, camera) instead of the renderer's own. */
export class OutlineEffect {
  readonly render: (scene: THREE.Scene, camera: THREE.Camera) => void;

  constructor(renderer: THREE.WebGLRenderer, o: Options = {}) {
    const uniforms = {
      outlineThickness: { value: o.defaultThickness ?? 0.003 },
      outlineColor: { value: new THREE.Color().fromArray(o.defaultColor ?? [0, 0, 0]) },
      outlineAlpha: { value: o.defaultAlpha ?? 1 },
    };
    const make = (): OutlineMaterial => {
      const m = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, THREE.UniformsLib.displacementmap, uniforms]),
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        side: THREE.BackSide,
      });
      m.type = 'OutlineEffect';
      return m;
    };
    const cache = outlineCache<Original, OutlineMaterial>(make, (m) => m.dispose(), o.defaultKeepAlive ?? false);
    // what this frame swapped out, put back after it (and forgotten: cleared every frame)
    const originals = new Map<THREE.Material, Original>();
    const beforeRenders = new Map<THREE.Object3D, THREE.Object3D['onBeforeRender']>();

    const outlineOf = (original: Original) => {
      const m = cache.get(original);
      originals.set(m, original);
      updateMaterial(m, original, cache);
      return m;
    };
    const onBeforeRender: THREE.Object3D['onBeforeRender'] = (_r, _s, _c, _g, material) => {
      const original = originals.get(material);
      if (original) updateUniforms(material as OutlineMaterial, original); // (only outline materials get here)
    };
    const swapIn = (obj: THREE.Object3D) => {
      if (!isOutlined(obj)) return;
      obj.material = Array.isArray(obj.material) ? obj.material.map(outlineOf) : outlineOf(obj.material);
      beforeRenders.set(obj, obj.onBeforeRender);
      obj.onBeforeRender = onBeforeRender;
    };
    const swapBack = (obj: THREE.Object3D) => {
      if (!isOutlined(obj)) return;
      const back = (m: THREE.Material) => originals.get(m) ?? m;
      obj.material = Array.isArray(obj.material) ? obj.material.map(back) : back(obj.material);
      const before = beforeRenders.get(obj);
      if (before) obj.onBeforeRender = before;
    };

    const renderOutline = (scene: THREE.Scene, camera: THREE.Camera) => {
      const autoClear = renderer.autoClear;
      const autoUpdate = scene.matrixWorldAutoUpdate;
      const background = scene.background;
      const shadows = renderer.shadowMap.enabled;
      scene.matrixWorldAutoUpdate = false;
      scene.background = null;
      renderer.autoClear = false;
      renderer.shadowMap.enabled = false;
      scene.traverse(swapIn);
      renderer.render(scene, camera);
      scene.traverse(swapBack);
      originals.clear();
      beforeRenders.clear();
      cache.sweep();
      scene.matrixWorldAutoUpdate = autoUpdate;
      scene.background = background;
      renderer.autoClear = autoClear;
      renderer.shadowMap.enabled = shadows;
    };
    this.render = (scene, camera) => {
      // (three's draws the scene with autoClear set to its own, never-set autoClear: off. The
      // canvas isn't kept between frames, so it starts each one empty anyway.)
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
      renderOutline(scene, camera);
    };
  }
}

function updateUniforms(material: OutlineMaterial, original: Original) {
  const p: OutlineParameters | undefined = original.userData.outlineParameters;
  const u = material.uniforms;
  u.outlineAlpha.value = original.opacity;
  if (p) {
    if (p.thickness !== undefined) u.outlineThickness.value = p.thickness;
    if (p.color !== undefined) u.outlineColor.value.fromArray(p.color);
    if (p.alpha !== undefined) u.outlineAlpha.value = p.alpha;
  }
  if (original.displacementMap) {
    u.displacementMap.value = original.displacementMap;
    u.displacementScale.value = original.displacementScale;
    u.displacementBias.value = original.displacementBias;
  }
}

function updateMaterial(
  material: OutlineMaterial,
  original: Original,
  cache: { keepAlive(key: Original, on: boolean): void },
) {
  if (material.name === 'invisible') return;
  const p: OutlineParameters | undefined = original.userData.outlineParameters;
  material.fog = !!original.fog;
  material.toneMapped = original.toneMapped;
  material.premultipliedAlpha = original.premultipliedAlpha;
  material.displacementMap = original.displacementMap;
  if (p) {
    material.visible = original.visible === false ? false : (p.visible ?? true);
    material.transparent = p.alpha !== undefined && p.alpha < 1 ? true : original.transparent;
    if (p.keepAlive !== undefined) cache.keepAlive(original, p.keepAlive);
  } else {
    material.transparent = original.transparent;
    material.visible = original.visible;
  }
  if (original.wireframe === true || original.depthTest === false) material.visible = false;
  if (original.clippingPlanes) {
    material.clipping = true;
    material.clippingPlanes = original.clippingPlanes;
    material.clipIntersection = original.clipIntersection;
    material.clipShadows = original.clipShadows;
  }
  // (the outline recompiles when the original does; three's types make version read-only, but
  // that's what its own OutlineEffect does)
  (material as { version: number }).version = original.version;
}
