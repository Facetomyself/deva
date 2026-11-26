import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitFor } from './webdriver-local.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/,'')
const name='Task inspection visual check'
const assert = (condition, check) => { if (!condition) throw Error(`${name}: ${check}`) }

async function output() {
  let path = repo
  assert(await realpath(path) === path, 'repository root')
  for (const part of ['test-results','task-inspection']) {
    path=join(path,part)
    await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e})
    const st=await lstat(path)
    assert(st.isDirectory() && !st.isSymbolicLink() && st.uid===process.geteuid() && await realpath(path)===path,'fixture output directory')
  }
  return path
}

async function layoutData(browser, origin, layout) {
  return waitFor(()=>browser.execute(`
    const [origin, layout]=arguments;
    if (location.origin !== origin || location.pathname !== '/' || location.hash || location.search || document.querySelector('input[type="password"]')) return null;
    const q=s=>document.querySelector(s);
    const panel=q('[data-testid="workbench-tasks-panel"]'); const task=panel?.querySelector('[data-testid="workbench-task-detail"][data-status="active"]');
    const list=panel?.querySelector('.wb-tasks__list'), body=panel?.querySelector('.wb-tasks__body'), detail=panel?.querySelector('.wb-tasks__detail');
    const nav=q('.cf-iconrail'), entry=nav?.querySelector('[data-testid="workbench-tasks-toggle"]');
    if(!list || !body || !detail || !task || !nav || !entry || !['true','page'].includes(entry.getAttribute('aria-current')) || entry.disabled ||
      task.querySelector('h3')?.textContent!=='QA archive reminder' || list.querySelectorAll('[data-task-id]').length!==2 ||
      document.querySelector('.wb-chat .cf-rail__top')?.getClientRects().length) return null;
    const r=el=>{const b=el.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),right:Math.round(b.right),bottom:Math.round(b.bottom),width:Math.round(b.width),height:Math.round(b.height)}};
    const p=r(panel), l=r(list), d=r(detail), n=r(nav);
    if(!p.width || p.height<250 || !l.width || !d.width || l.height<30 || d.height<100) return null;
    // A mechanically valid one-column grid can still leave half of a small screen unused
    // if the conversation list remains mounted. Check the actual rail-to-viewport geometry.
    if(n.width<36 || n.width>88 || Math.abs(n.right-p.x)>2 || Math.abs(p.right-innerWidth)>2 || p.width<innerWidth-n.width-4) return null;
    if((layout==='wide' && (innerWidth<1000 || l.right>d.x+2)) || (layout==='compact' && (innerWidth>610 || Math.abs(d.x-l.x)>2 || d.y<l.bottom-2))) return null;
    return {viewport:{width:innerWidth,height:innerHeight},navigation:n,panel:p,list:l,detail:d,
      overflow:Math.max(0,p.right-innerWidth,-p.x,l.right-p.right,d.right-p.right), grid:getComputedStyle(body).gridTemplateColumns};
  `,origin,layout),`${layout} task list and detail use the expected shared layout`,{timeout:4500})
}

/** Called only with the autonomous QA fixture after explicit row selection and public/private
 * shape checks, never on login screens or user data. No screenshot feature in the product. */
export async function captureTaskInspectionLayouts({browser,origin}) {
  if (process.env.DEVA_QA_LAYOUT_CAPTURE !== '1') return
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin),'only the local synthetic fixture may be recorded')
  const dir=await output(), geometry={}
  try {
    for (const layout of ['wide','compact']) {
      await browser.fixtureViewport(layout)
      await browser.executeAsync(`const done=arguments[arguments.length-1]; document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))));`)
      const data=await layoutData(browser,origin,layout)
      assert(data.overflow<=2,`${layout} panel fits the viewport`)
      const text=await browser.fixtureScreenshot()
      assert(typeof text==='string' && text.length>=1024 && text.length<4*1024*1024,'bounded screen capture')
      const png=Buffer.from(text,'base64')
      assert(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && png.subarray(12,16).toString()==='IHDR','PNG signature and header')
      const width=png.readUInt32BE(16), height=png.readUInt32BE(20)
      assert(width>=data.viewport.width-16 && width<=data.viewport.width*2+2 && height>=data.viewport.height-2 && height<=data.viewport.height*2+2,'actual screenshot dimensions')
      await writeFile(join(dir,`tasks-${layout}.png`),png,{flag:'wx',mode:0o600})
      geometry[layout]={...data,image:{width,height}}
    }
    await writeFile(join(dir,'layout.json'),JSON.stringify(geometry,null,2)+'\n',{flag:'wx',mode:0o600})
  } finally { await browser.fixtureViewport('wide') }
}
