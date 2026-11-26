import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InteractionCheckError } from './e2e-client-interactions-fixture.mjs'

/** Synthetic UI fixtures only. No screenshot capability is exposed by the shipped workbench. */
export async function captureClientInteraction({browser,origin}, phase) {
  if (process.env.DEVA_QA_CLIENT_CAPTURE !== '1') return
  const check = (ok, reason) => { if (!ok) throw new InteractionCheckError(`Client visual check: ${reason}`) }
  check(['selection-menu','quoted-draft'].includes(phase) && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin),'fixed fixture and phase required')
  const shape = await browser.execute(`
    const [origin,phase]=arguments;
    if(location.origin!==origin || location.pathname!=='/' || location.search || location.hash || document.querySelector('input[type="password"],dialog[open]'))return null;
    const v=(selector)=>{const e=document.querySelector(selector);if(!e || !e.getClientRects().length)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
    const chat=document.querySelector('[data-testid="workbench-chat"]');
    const msg=chat?.querySelector('[data-role="assistant"] [data-testid="workbench-message-text"]');
    if(msg?.textContent!=='Signal CaféMistral belongs to chat A.')return null;
    if(phase==='selection-menu' && (!document.querySelector('[data-testid="workbench-selection-copy"]') || !document.querySelector('[data-testid="workbench-selection-quote"]')))return null;
    if(phase==='quoted-draft' && (document.querySelector('[data-testid="workbench-quote-draft"] .cf-quotebar__text')?.textContent!=='CaféMistral' ||
        chat.querySelector('.cf-draft__input')?.textContent!=='Keep *the exact original body*.'))return null;
    const element=v(phase==='selection-menu'?'[data-testid="workbench-selection-menu"]':'[data-testid="workbench-quote-draft"]');
    return element && {w:innerWidth,h:innerHeight,element};
  `,origin,phase)
  check(shape && shape.element.x>=0 && shape.element.y>=0 && shape.element.x+shape.element.w<=shape.w+2 && shape.element.y+shape.element.h<=shape.h+2,'target visible inside the synthetic viewport')
  const repo=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');let dir=repo
  for(const component of ['test-results','client-interactions']){dir=join(dir,component);await mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e});const s=await lstat(dir);check(s.isDirectory()&&s.uid===process.geteuid()&&await realpath(dir)===dir,'owned fixture output')}
  const encoded=await browser.fixtureScreenshot();check(typeof encoded==='string' && encoded.length>1024 && encoded.length<4*1024*1024,'bounded screenshot')
  const png=Buffer.from(encoded,'base64');check(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && png.readUInt32BE(16)===shape.w && png.readUInt32BE(20)===shape.h,'real viewport PNG')
  await writeFile(join(dir,`${phase}.png`),png,{flag:'wx',mode:0o600})
}
