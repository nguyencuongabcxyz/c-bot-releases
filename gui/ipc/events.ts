// What main tells this window (Rust emit_to / emit), typed by gui/types/ipc.ts Events.
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { Events } from '@/types/ipc';

/** Hear an event; the function returned stops listening. */
export function on<E extends keyof Events>(event: E, cb: (payload: Events[E]) => void): () => void {
  const off = getCurrentWebviewWindow().listen<Events[E]>(event, (e) => cb(e.payload));
  return () => void off.then((stop) => stop());
}
