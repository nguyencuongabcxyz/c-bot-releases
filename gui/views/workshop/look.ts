// The look, in the editor: its tabs (Shape, Colours, Outfit), the parts as rows of tiles, the
// themed looks, presets, random and Undo, and the preview you can turn round by dragging.
// (workshop.ts calls createLook.)
import { COLORS } from './choices';
import { GIRL_HAIR, KIT_COLOURS, KIT_DEFAULT, KIT_PRESETS, KIT_SLOTS, LOOKS, ON_ITS_BACK, WEAR_SLOTS } from './kit';
import type { Look, Parts, WearSlot } from './kit';
import { KIT_ICONS, WEAR_ICONS } from './kit-icons';
import type { Draft } from './types';
import { $ } from '@/lib/dom';
import { onDrag } from '@/lib/drag';
import { officeData, type Reaction } from '@/office3d/protocol';
import type { Kit } from '@/types/model';

/** What it uses of the Workshop. */
export type LookNeeds = {
  readonly draft: Draft;
  update(patch: Partial<Draft>): void;
  wiggle(cls?: Reaction): void;
};

export function createLook(shop: LookNeeds) {
  const kitHistory: { kit: Required<Kit>; color: string; accessory: string }[] = []; // earlier { kit, color, accessory }s, for Undo

  // the look's own tabs: Shape (a part for each slot), Colours, Outfit, Size and desk
  let lookTab = 'shape';
  for (const b of document.querySelectorAll<HTMLElement>('.look-tabs button'))
    b.addEventListener('click', () => {
      lookTab = b.dataset.look ?? lookTab; // (every look tab has its data-look)
      renderKit();
    });

  // A slot: its name, then its parts as a row of tiles that scrolls sideways (and stays
  // scrolled where it was when the look redraws)
  const rowScroll = new Map<string, number>();
  function tileRow(
    key: string,
    label: string,
    parts: Parts,
    icons: Parts | undefined,
    value: string | undefined,
    onPick: (part: string) => void,
  ) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.innerHTML = '<h3></h3><div class="tile-row" role="radiogroup"></div>';
    $('h3', slot).textContent = label;
    const row = slot.lastChild as HTMLElement; // (the tile row, just put in)
    for (const [part, name] of Object.entries(parts)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kit-tile';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(value === part));
      b.innerHTML = icons?.[part] || WEAR_ICONS.none;
      b.append(name);
      b.addEventListener('click', () => onPick(part));
      row.append(b);
    }
    row.addEventListener('scroll', () => rowScroll.set(key, row.scrollLeft));
    requestAnimationFrame(() => (row.scrollLeft = rowScroll.get(key) || 0));
    return slot;
  }

  function renderKit() {
    const kit = { ...KIT_DEFAULT, ...(shop.draft.kit || {}) };
    shop.draft.kit = kit;
    const presets = $('#kit-presets');
    presets.innerHTML = '';
    for (const [key, [label]] of Object.entries(KIT_PRESETS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => applyPreset(key));
      presets.append(b);
    }
    for (const b of document.querySelectorAll<HTMLElement>('.look-tabs button'))
      b.setAttribute('aria-selected', String(b.dataset.look === lookTab));
    for (const s of document.querySelectorAll<HTMLElement>('.look-pane')) s.hidden = s.dataset.look !== lookTab;
    $<HTMLButtonElement>('#kit-undo').disabled = !kitHistory.length;
    if (lookTab === 'shape') {
      const box = $('#look-shape');
      box.innerHTML = '';
      for (const slot of ['head', 'face', 'top', 'body', 'arms', 'base'] as const) {
        const [label, parts] = KIT_SLOTS[slot];
        box.append(tileRow(slot, label, parts, KIT_ICONS[slot], kit[slot], (p) => setKit({ [slot]: p })));
      }
    } else if (lookTab === 'colours') renderKitColours(kit);
    else if (lookTab === 'outfit') renderOutfit(kit);
  }

  function renderKitColours(kit: Required<Kit>) {
    const box = $('#kit-colours');
    box.innerHTML = '';
    const row = (
      label: string,
      key: 'second' | 'accent' | 'eye' | 'cloth' | 'hair',
      { auto }: { auto?: string } = {},
    ) => {
      const r = document.createElement('div');
      r.className = 'slot';
      r.innerHTML = '<h3></h3><div class="swatches"></div>';
      $('h3', r).textContent = label;
      const sw = r.lastChild as HTMLElement; // (the swatches, just put in)
      if (auto) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'auto';
        b.textContent = auto;
        b.setAttribute('aria-checked', String(!kit[key]));
        b.addEventListener('click', () => setKit({ [key]: '' }));
        sw.append(b);
      }
      for (const col of KIT_COLOURS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.background = col;
        b.title = col;
        b.setAttribute('aria-checked', String((kit[key] || '').toLowerCase() === col));
        b.addEventListener('click', () => setKit({ [key]: col }));
        sw.append(b);
      }
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.value = kit[key] || '#7ff3ff';
      custom.title = 'Any colour';
      custom.addEventListener('change', () => setKit({ [key]: custom.value }));
      sw.append(custom);
      box.append(r);
    };
    row('Arms and legs', 'second');
    row('Lights', 'accent');
    row('Eyes', 'eye', { auto: 'Like its brain' });
    row('Clothes', 'cloth');
    row('Hair', 'hair');
    const finish = $('#finish-row');
    finish.innerHTML = '';
    const [label, parts] = KIT_SLOTS.finish;
    finish.append(tileRow('finish', label, parts, KIT_ICONS.finish, kit.finish, (p) => setKit({ finish: p })));
  }

  // the Outfit tab: themed looks, the hat (the Accessory, rendered with the editor), then the rest
  function renderOutfit(kit: Required<Kit>) {
    const looks = $('#looks');
    looks.innerHTML = '';
    for (const [theme, pair] of LOOKS) {
      const label = document.createElement('span');
      label.textContent = theme;
      const row = document.createElement('div');
      row.className = 'pair';
      for (const [name, who, look] of pair) {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = `A ${who}'s ${theme.toLowerCase()} look`;
        b.textContent = name;
        const tag = document.createElement('small');
        tag.textContent = ` · ${who}`;
        b.append(tag);
        b.addEventListener('click', () => wearLook(look, who));
        row.append(b);
      }
      looks.append(label, row);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear';
    clear.textContent = 'Take it all off';
    clear.addEventListener('click', () =>
      wearLook({ accessory: 'none', clothes: 'none', neck: 'none', extra: 'none', specs: 'none' }),
    );
    looks.append(document.createElement('span'), clear);
    const rows = $('#wear-rows');
    rows.innerHTML = '';
    for (const [slot, [label, parts]] of Object.entries(WEAR_SLOTS))
      rows.append(
        tileRow(slot, label, parts, WEAR_ICONS[slot as WearSlot], kit[slot as WearSlot] || 'none', (p) => {
          setKit({ [slot]: p });
          if (ON_ITS_BACK.includes(p)) peekBack();
        }),
      );
  }

  // a themed look: its hat goes in the Accessory; a girl's look does her hair if it isn't done
  function wearLook(look: Look, who?: string) {
    const { accessory, top, ...wear } = look;
    const patch: Kit = { ...wear };
    if (top && !GIRL_HAIR.includes(shop.draft.kit.top)) patch.top = top;
    if (who === 'boy' && GIRL_HAIR.includes(shop.draft.kit.top)) patch.top = 'spiky';
    kitHistory.push({ kit: { ...shop.draft.kit }, color: shop.draft.color, accessory: shop.draft.accessory });
    shop.update({ kit: { ...shop.draft.kit, ...patch }, ...(accessory ? { accessory } : {}) });
  }

  // The preview faces you. Hold and drag it to turn it round (to see a cape, wings…); let go
  // and it turns back to face you. Picking something worn on its back shows it for a moment.
  const preview = $('#preview');
  const previewState = officeData(preview);
  let backTimer = 0;
  let turned = 0; // how far round it is, radians
  const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  function setTurn(a: number) {
    turned = wrapAngle(a);
    previewState.facing = Math.abs(turned) < 0.01 ? 'camera' : turned.toFixed(3);
  }
  onDrag(preview, () => {
    clearTimeout(backTimer);
    const from = turned;
    let moved = false; // (only sideways counts: more than 4 px)
    return {
      move: ({ dx }) => {
        if (Math.abs(dx) > 4) moved = true;
        if (!moved) return;
        preview.classList.add('turning');
        previewState.facingDrag = '1';
        setTurn(from + dx * 0.012);
      },
      end: () => {
        preview.classList.remove('turning');
        delete previewState.facingDrag;
        // (a click, not a drag, still makes it wiggle)
        if (moved) {
          preview.dataset.dragged = '1';
          setTimeout(() => delete preview.dataset.dragged, 0);
        }
        setTurn(0);
      },
    };
  });
  function peekBack() {
    clearTimeout(backTimer);
    setTurn(Math.PI - 0.001);
    backTimer = setTimeout(() => setTurn(0), 2600);
  }

  // a change to the build (Undo can take it back)
  function setKit(patch: Kit, { color }: { color?: string | null } = {}) {
    kitHistory.push({ kit: { ...shop.draft.kit }, color: shop.draft.color, accessory: shop.draft.accessory });
    if (kitHistory.length > 50) kitHistory.shift();
    shop.update({ kit: { ...shop.draft.kit, ...patch }, ...(color ? { color } : {}) });
  }
  function applyPreset(key: string) {
    const [, parts, color] = KIT_PRESETS[key];
    // (a preset is a new robot; it keeps what it's wearing)
    const wear = Object.fromEntries(Object.keys(WEAR_SLOTS).map((s) => [s, shop.draft.kit[s as WearSlot] || 'none']));
    setKit({ ...KIT_DEFAULT, ...parts, ...wear, cloth: shop.draft.kit.cloth, hair: shop.draft.kit.hair }, { color });
  }
  const any = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  $('#kit-random').addEventListener('click', () => {
    const kit: Record<string, string> = {};
    for (const [slot, [, parts]] of Object.entries(KIT_SLOTS)) kit[slot] = any(Object.keys(parts));
    kit.second = any(KIT_COLOURS);
    kit.accent = any(KIT_COLOURS.filter((c) => c !== kit.second));
    kit.eye = Math.random() < 0.5 ? '' : any(['#7ff3ff', '#7bed9f', '#ff9ecf', '#ffd34d', '#c4a8ff']);
    // (and now and then an outfit too)
    if (Math.random() < 0.4)
      for (const [slot, [, parts]] of Object.entries(WEAR_SLOTS))
        kit[slot] = Math.random() < 0.6 ? any(Object.keys(parts)) : 'none';
    setKit(kit, { color: any(COLORS) });
    shop.wiggle('spin');
  });
  $('#kit-undo').addEventListener('click', () => {
    const last = kitHistory.pop();
    if (last)
      shop.update({ kit: last.kit, color: last.color, ...(last.accessory ? { accessory: last.accessory } : {}) });
  });
  return { renderKit };
}
export type LookApi = ReturnType<typeof createLook>;
