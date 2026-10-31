// The relay's rooms, against `bun run dev` running (wrangler dev on 127.0.0.1:8787), or a deployed one:
// RELAY=wss://<its host> bun run test
const base = (process.env.RELAY || 'ws://127.0.0.1:8787') + '/room/';
const id = crypto.randomUUID().replaceAll('-', '');
const open = (u) => new Promise((res, rej) => { const w = new WebSocket(u); w.binaryType = 'arraybuffer'; w.q = []; w.waiting = []; w.onmessage = (m) => (w.waiting.length ? w.waiting.shift()(m.data) : w.q.push(m.data)); w.onopen = () => res(w); w.onerror = (e) => rej(new Error('error ' + u)); });
const next = (w) => (w.q.length ? Promise.resolve(w.q.shift()) : new Promise((r) => w.waiting.push(r)));
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) process.exitCode = 1; };
// a guest with no host: refused
await open(base + id + '?as=guest').then(() => ok(false, 'guest without host refused'), () => ok(true, 'guest without host refused'));
const host = await open(base + id + '?as=host');
await open(base + id + '?as=host').then(() => ok(false, 'second host refused'), () => ok(true, 'second host refused'));
let m = next(host);
const guest = await open(base + id + '?as=guest');
const opened = JSON.parse(await m);
ok(opened.t === 'open' && opened.peer >= 1, 'host hears the guest come: ' + JSON.stringify(opened));
m = next(host); guest.send(new Uint8Array([1, 2, 3]));
const f = new Uint8Array(await m); const peer = new DataView(f.buffer).getUint32(0);
ok(peer === opened.peer && f.slice(4).join() === '1,2,3', 'guest bytes reach the host with its number');
m = next(guest); const out = new Uint8Array(6); new DataView(out.buffer).setUint32(0, peer); out.set([9, 8], 4); host.send(out);
ok(new Uint8Array(await m).join() === '9,8', 'host bytes reach that guest');
m = next(host); guest.send('text is not allowed');
ok(JSON.parse(await m).t === 'close', 'a guest sending text is closed, and the host told');
const g2 = await open(base + id + '?as=guest'); const p2 = JSON.parse(await next(host)).peer;
host.send(JSON.stringify({ t: 'close', peer: p2 }));
await new Promise((r) => setTimeout(r, 1000));
ok(g2.readyState >= 2, 'the host can close a guest');
await next(host); // (g2's close)
const g3 = await open(base + id + '?as=guest'); await next(host);
host.close();
await new Promise((r) => setTimeout(r, 1500));
ok(g3.readyState >= 2, 'guests go when the host leaves');
await open(base + id + '?as=guest').then(() => ok(false, 'nobody joins after the host left'), () => ok(true, 'nobody joins after the host left'));
process.exit();
