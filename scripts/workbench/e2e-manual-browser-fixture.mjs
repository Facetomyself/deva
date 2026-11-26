import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'

export const siteId = 'manual-fixture'
export const siteLabel = 'Manual browser fixture'
export const formPath = '/form'
export const viewport = Object.freeze({ width: 1024, height: 768 })
const colors = Object.freeze({ ready: [25, 88, 153], focused: [153, 75, 21], typed: [102, 44, 153], done: [29, 137, 77] })
const swatchX = i => 20 + i * 30

// Both interactive steps deliberately occupy the viewport centre in turn. The stock
// WebDriver helper's W3C element click hits the actual displayed image at that point.
function documentHtml(nonce, expected) {
  const swatches = frameSamples(nonce, 'ready').map(([x, , rgb], i) =>
    `<span class="swatch" ${i === 0 ? 'id="phase"' : ''} style="left:${x - 10}px;background:rgb(${rgb})"></span>`).join('')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Manual browser fixture</title><link rel="icon" href="data:,">
    <style>
      body { margin:0; background:#f3f6fa; color:#162b40; font:22px system-ui,sans-serif }
      h1, #receipt { position:absolute; text-align:center; width:100%; top:22%; margin:0 }
      .swatch { position:absolute; top:10px; width:20px; height:20px }
      label, input, button { position:absolute; left:50%; transform:translate(-50%,-50%); }
      label { top:calc(50% - 45px) } input { top:50%; width:320px; height:40px; font:inherit; padding:0 10px }
      button { top:calc(50% + 72px); height:42px; font:inherit; padding:0 24px }
      form[data-ready] label { top:calc(50% - 115px) }
      form[data-ready] input { top:calc(50% - 70px) }
      form[data-ready] button { top:50% }
    </style>
    ${swatches}<h1>Confirm a synthetic name</h1>
    <form method="post" action="/confirm" autocomplete="off">
      <label for="name">Confirmation name</label><input id="name" name="name" type="text" maxlength="80" required>
      <input type="hidden" name="nonce" value="${nonce}"><button disabled type="submit">Confirm</button>
    </form><p id="receipt" hidden>Fixture confirmed</p>
    <script>
      const colors = ${JSON.stringify(colors)}, expected = ${JSON.stringify(expected)};
      const phase = document.querySelector('#phase'), form = document.querySelector('form');
      const input = document.querySelector('#name'), button = document.querySelector('button');
      const show = key => { phase.style.backgroundColor = 'rgb(' + colors[key].join(',') + ')'; };
      input.addEventListener('focus', event => { if (event.isTrusted && button.disabled) show('focused'); });
      input.addEventListener('input', event => {
        if (!event.isTrusted) return;
        const ready = input.value === expected;
        form.toggleAttribute('data-ready', ready); button.disabled = !ready;
        show(ready ? 'typed' : 'focused');
      });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!event.isTrusted || button.disabled || input.value !== expected) return;
        const body = new URLSearchParams(new FormData(form));
        button.disabled = true;
        try {
          const reply = await fetch('/confirm', { method:'POST', body, mode:'same-origin', redirect:'error',
            credentials:'omit', cache:'no-store', referrerPolicy:'same-origin' });
          if (reply.status !== 204) return;
          form.reset(); form.hidden = true;
          document.querySelector('h1').hidden = true;
          document.querySelector('#receipt').hidden = false;
          show('done');
        } catch { /* Keep the panel unconfirmed. */ }
      });
    </script></html>`
}

/** Plain RGB challenge pixels. The random document identity survives release and reclaim. */
export function frameSamples(nonce, phase) {
  const identity = Buffer.from(nonce, 'hex')
  return [colors[phase], ...Array.from({ length: 4 }, (_, i) => [...identity.subarray(i * 3, i * 3 + 3)])]
    .map((rgb, i) => [swatchX(i), 20, rgb])
}

async function readForm(request) {
  let bytes = 0
  const parts = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 1024) throw new Error('FORM_LIMIT')
    parts.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(parts).toString('utf8'))
}

/** One isolated page identity per document response; no cookies or persistent/shared account state. */
export async function startManualFixture() {
  const name = `Fixture User ${randomBytes(6).toString('hex')}`
  const documents = new Map()
  let confirmations = 0, failure
  const server = createServer({ headersTimeout: 8000, requestTimeout: 8000 }, (req, res) => {
    const fail = (status, kind) => {
      failure ??= kind
      if (!res.destroyed) res.writeHead(status, { connection: 'close' }).end()
    }
    const address = server.address()
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${address.port}`) {
      return fail(400, 'FIXTURE_NETWORK_SCOPE')
    }
    if (req.headers.cookie !== undefined || req.headers.authorization !== undefined || req.headers['x-deva-csrf'] !== undefined) {
      return fail(400, 'FIXTURE_CREDENTIAL_LEAK')
    }
    if (req.url === formPath && req.method === 'GET') {
      if (documents.size >= 8) return fail(409, 'FIXTURE_DOCUMENT_LIMIT')
      const nonce = randomBytes(12).toString('hex')
      documents.set(nonce, { confirmed: false })
      const body = documentHtml(nonce, name)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', connection: 'close'
      }).end(body)
    } else if (req.url === '/confirm' && req.method === 'POST') {
      if (req.headers.origin !== `http://127.0.0.1:${address.port}` ||
          !/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
        return fail(400, 'FIXTURE_FORM_ORIGIN')
      }
      void readForm(req).then(form => {
        const doc = documents.get(form.get('nonce'))
        if (!doc || doc.confirmed || confirmations !== 0 || form.get('name') !== name || [...form].length !== 2) {
          return fail(400, 'FIXTURE_FORM_MISMATCH')
        }
        doc.confirmed = true
        confirmations++
        res.writeHead(204, { 'cache-control': 'no-store', connection: 'close' }).end()
      }, () => fail(400, 'FIXTURE_FORM_READ'))
    } else if (req.url === '/favicon.ico' && req.method === 'GET') {
      res.writeHead(204, { connection: 'close' }).end()
    } else fail(404, 'FIXTURE_UNEXPECTED_REQUEST')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return Object.freeze({
    origin: `http://127.0.0.1:${server.address().port}`,
    name,
    get failure() { return failure },
    get documents() { return [...documents.keys()] },
    confirmed: nonce => documents.get(nonce)?.confirmed === true,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
      documents.clear()
    })
  })
}
