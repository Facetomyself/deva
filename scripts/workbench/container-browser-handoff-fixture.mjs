import { inflateSync } from 'node:zlib'
import { check } from './container-client-interactions-docker.mjs'

export const siteId = 'hosted-handoff-form'
export const siteLabel = 'Hosted browser handoff form'
export const formPath = '/form'
export const fixturePort = 18791
export const fixtureSocket = '/tmp/deva-handoff-fixture.sock'
export const field = '访客 Café — 合成收据'
export const colors = Object.freeze({ ready: [25, 88, 153], focused: [153, 75, 21], typed: [102, 44, 153], done: [29, 137, 77] })
export const swatchX = i => 20 + 30 * i

// This function and the constants above are the entire fixture program sent to the
// isolated container. No checkout mount, caller-supplied HTML, shell or URL is used.
export async function serveFixture({ host, port, peer, socket } = {}) {
  const { randomBytes } = await import('node:crypto')
  const { createServer } = await import('node:http')
  const { createServer: unixServer, isIPv4 } = await import('node:net')
  const { networkInterfaces } = await import('node:os')
  const { chmod, unlink, lstat } = await import('node:fs/promises')
  const { once } = await import('node:events')
  if (!host) {
    const addresses = Object.values(networkInterfaces()).flat().filter(a => a.family === 'IPv4' && !a.internal)
    if (addresses.length !== 1) throw Error('FIXTURE_INTERFACE')
    host = addresses[0].address
  }
  const state = { documents: 0, posts: 0, receipts: 0, credentialHeaders: 0, failure: false, nonce: null }
  let origin
  function documentHtml(nonce) {
    const bytes = Buffer.from(nonce, 'hex')
    const swatches = [colors.ready, ...Array.from({ length: 4 }, (_, i) => [...bytes.subarray(i * 3, i * 3 + 3)])]
      .map((rgb, i) => `<b ${i ? '' : 'id="phase"'} style="position:absolute;top:10px;left:${swatchX(i) - 10}px;width:20px;height:20px;background:rgb(${rgb})"></b>`).join('')
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic receipt</title><link rel="icon" href="data:,">
<style>body{margin:0;background:#f3f6fa;color:#162b40;font:22px sans-serif}h1,p{text-align:center;margin-top:20vh}
label,input,button{position:absolute;left:50%;transform:translate(-50%,-50%);font:inherit}label{top:43%}input{top:50%;width:320px;height:40px}button{top:60%;padding:8px 24px}</style>
${swatches}<h1>Confirm a synthetic name</h1><form method="post" action="/confirm" autocomplete="off">
<label for="name">Confirmation name</label><input id="name" name="name" maxlength="80" required>
<input type="hidden" name="nonce" value="${nonce}"><button disabled>Confirm</button></form><p hidden>Fixture confirmed</p>
<script>
const colors=${JSON.stringify(colors)},expected=${JSON.stringify(field)};
const input=document.querySelector('#name'),button=document.querySelector('button'),form=document.querySelector('form');
const show=phase=>document.querySelector('#phase').style.backgroundColor='rgb('+colors[phase].join(',')+')';
input.addEventListener('focus',e=>{if(e.isTrusted&&button.disabled)show('focused')});
input.addEventListener('input',e=>{if(e.isTrusted){button.disabled=input.value!==expected;show(button.disabled?'focused':'typed')}});
form.addEventListener('submit',async e=>{e.preventDefault();if(!e.isTrusted||button.disabled||input.value!==expected)return;
  button.disabled=true;
  const result=await fetch('/confirm',{method:'POST',body:new URLSearchParams(new FormData(form)),mode:'same-origin',credentials:'same-origin',redirect:'error',cache:'no-store'});
  if(result.status===204){form.reset();form.hidden=true;document.querySelector('h1').hidden=true;document.querySelector('p').hidden=false;show('done')}
});</script></html>`
  }
  const server = createServer({ headersTimeout: 5000, requestTimeout: 5000 }, async (req, res) => {
    const finish = (status, headers = {}, body) => res.writeHead(status, {
      connection: 'close', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers
    }).end(body)
    if (!peer || req.socket.remoteAddress !== peer) { finish(403); return }
    if (req.method === 'POST') state.posts++
    if (['cookie', 'authorization', 'x-deva-csrf', 'proxy-authorization'].some(h => req.headers[h] !== undefined)) {
      state.credentialHeaders++; finish(400); return
    }
    if (req.headers.host !== new URL(origin).host) { state.failure = true; finish(400); return }
    if (req.method === 'GET' && req.url === formPath) {
      if (++state.documents !== 1) { state.failure = true; finish(409); return }
      state.nonce = randomBytes(12).toString('hex')
      const page = documentHtml(state.nonce)
      finish(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page) }, page)
    } else if (req.method === 'GET' && req.url === '/favicon.ico') finish(204)
    else if (req.method === 'POST' && req.url === '/confirm') {
      try {
        if (req.headers.origin !== origin || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw Error()
        const chunks = []; let size = 0
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          if ((size += chunk.length) > 1024) throw Error()
          chunks.push(chunk)
        }
        const body = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
        if (state.documents !== 1 || state.posts !== 1 || state.receipts !== 0 || [...body].length !== 2 ||
            body.get('nonce') !== state.nonce || body.get('name') !== field) throw Error()
        state.receipts++; finish(204)
      } catch { state.failure = true; if (!res.destroyed) finish(400) }
    } else { state.failure = true; finish(404) }
  })
  server.listen({ host, port }); await once(server, 'listening')
  origin = `http://${host}:${server.address().port}`
  let control
  if (socket) {
    control = unixServer({ allowHalfOpen: true }, conn => {
      let input = ''
      conn.setEncoding('utf8'); conn.setTimeout(3000, () => conn.destroy())
      conn.on('error', () => {})
      conn.on('data', chunk => { input += chunk; if (input.length > 64) conn.destroy() })
      conn.on('end', () => {
        if (!peer && input.startsWith('bind:') && isIPv4(input.slice(5)) && input.slice(5) !== host) peer = input.slice(5)
        else if (input !== 'status') { conn.end('{}'); return }
        conn.end(JSON.stringify({ origin, peerBound: !!peer, ...state }))
      })
    })
    process.umask(0o177)
    control.listen(socket); await once(control, 'listening'); await chmod(socket, 0o600)
  }
  return { origin, snapshot: () => ({ ...state }), async close() {
    await Promise.all([
      new Promise(resolve => { server.close(resolve); server.closeAllConnections() }),
      ...(control ? [new Promise(resolve => control.close(resolve))] : [])
    ])
    // libuv may already have removed a Unix server path on close.
    if (socket && (await lstat(socket).catch(error => { if (error.code !== 'ENOENT') throw error }))?.isSocket()) await unlink(socket)
  } }
}

export const fixtureProgram = `const fixturePort=${fixturePort},fixtureSocket=${JSON.stringify(fixtureSocket)},field=${JSON.stringify(field)},colors=${JSON.stringify(colors)},formPath=${JSON.stringify(formPath)};
const swatchX=${swatchX.toString()}; const serveFixture=${serveFixture.toString()};
const fixture=await serveFixture({port:fixturePort,socket:fixtureSocket});
let stopping=false; for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(!stopping){stopping=true;void fixture.close().catch(()=>{process.exitCode=1})}});`

export const fixtureQuery = `import {createConnection} from 'node:net';import{lstat}from'node:fs/promises';
const path=${JSON.stringify(fixtureSocket)},s=await lstat(path);if(!s.isSocket()||s.uid!==1000||(s.mode&0o7777)!==0o600)process.exit(3);
const input=process.argv[1]?'bind:'+process.argv[1]:'status';const c=createConnection(path,()=>c.end(input));
c.setTimeout(4000,()=>c.destroy(Error()));let out='';c.on('data',b=>{out+=b;if(out.length>1024)c.destroy(Error())});
c.on('end',()=>process.stdout.write(out));c.on('error',()=>{process.exitCode=1});`

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decode the top rows of bounded RGB/RGBA Chromium PNGs, independent of their size/hash. */
export function pngSamples(bytes) {
  const valid = ok => check(ok, 'CHROMIUM_PNG_INVALID')
  valid(bytes.length >= 45 && bytes.length <= 4 * 1024 * 1024 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a' &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) === 1024 &&
    bytes.readUInt32BE(20) === 768 && bytes[24] === 8 && [2, 6].includes(bytes[25]) && bytes[26] === 0 && bytes[27] === 0 && bytes[28] === 0)
  const bpp = bytes[25] === 2 ? 3 : 4, stride = 1024 * bpp, size = (stride + 1) * 768
  const blocks = []
  let ended = false
  for (let start = 33; start + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(start), end = start + length + 12, type = bytes.toString('ascii', start + 4, start + 8)
    valid(end <= bytes.length)
    if (type === 'IDAT') blocks.push(bytes.subarray(start + 8, end - 4))
    if (type === 'IEND') { valid(length === 0 && end === bytes.length); ended = true; break }
    start = end
  }
  valid(ended && blocks.length > 0)
  let raw
  try { raw = inflateSync(Buffer.concat(blocks), { maxOutputLength: size }) } catch { valid(false) }
  valid(raw.length === size)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y <= 20; y++) {
    const start = y * (stride + 1), row = raw.subarray(start + 1, start + 1 + stride), filter = raw[start]
    valid(filter <= 4)
    for (let x = 0; filter !== 0 && x < stride; x++) {
      const a = x < bpp ? 0 : row[x - bpp], b = previous[x], c = x < bpp ? 0 : previous[x - bpp]
      const delta = filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c)
      row[x] += delta
    }
    previous = row
  }
  return Array.from({ length: 5 }, (_, i) => [...previous.subarray(swatchX(i) * bpp, swatchX(i) * bpp + 3)])
}

export function matchesFrame(bytes, nonce, phase) {
  check(/^[a-f0-9]{24}$/.test(nonce), 'FIXTURE_NONCE_INVALID')
  const id = Buffer.from(nonce, 'hex')
  const expected = [colors[phase], ...Array.from({ length: 4 }, (_, i) => [...id.subarray(i * 3, i * 3 + 3)])]
  return pngSamples(bytes).every((sample, i) => sample.every((value, j) => Math.abs(value - expected[i][j]) <= 2))
}
