import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openWorkspaceCatalog } from '../src/business/workspace-catalog.mjs'

test('discovery returns only stable, opaque ids for real first-level project directories', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'deva-projects-')); t.after(() => rm(tmp,{ recursive:true,force:true }))
  const root = join(tmp,'workspaces'); const data = join(tmp,'data'); await mkdir(root); await mkdir(data)
  await mkdir(join(root,'文档')); await mkdir(join(root,'.private')); await writeFile(join(root,'a.txt'),'file'); await symlink(data,join(root,'shortcut'))
  const catalog = openWorkspaceCatalog({ root, privateRoots:[data] }); t.after(() => catalog.close())
  const [item] = catalog.list(); assert.equal(item.name,'文档'); assert.match(item.id,/^w_[a-f0-9]{32}$/); assert.equal(Object.keys(item).length,2)
  assert.equal(catalog.list().length,1); assert.equal(catalog.resolveRoot(item.id),join(root,'文档')); assert.equal(catalog.resolveRoot(data),undefined)
  await rename(join(root,'文档'),join(root,'.previous')); await mkdir(join(root,'文档'))
  assert.equal(catalog.resolveRoot(item.id),undefined); assert.notEqual(catalog.list()[0].id,item.id)
  await rename(root,join(tmp,'moved')); await symlink(data,root); assert.throws(() => catalog.list())
})

test('no root means no granted projects; system/private/relative roots and root aliases are rejected', async t => {
  assert.deepEqual(openWorkspaceCatalog({}).list(),[])
  const tmp = await mkdtemp(join(tmpdir(),'deva-projects-')); t.after(() => rm(tmp,{recursive:true,force:true}))
  const secret = join(tmp,'state'); await mkdir(secret); await symlink(secret,join(tmp,'alias'))
  for(const path of ['/','/proc','.',tmp,secret,join(tmp,'alias')]) assert.throws(() => openWorkspaceCatalog({root:path,privateRoots:[secret]}))
  const sibling = join(tmp,'allowed'); await mkdir(sibling); const catalog = openWorkspaceCatalog({root:sibling,privateRoots:[secret]});catalog.close();catalog.close()
  assert.throws(() => catalog.list())
})
