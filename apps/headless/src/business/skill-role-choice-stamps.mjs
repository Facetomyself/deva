import { openSync } from 'node:fs'
import { resolve } from 'node:path'
import { HttpError } from '../http/policy.mjs'
import { DIRECTORY, PATH, close, fdPath, mountId, openAbsoluteDirectory, sameInode, stat } from '../files/workspace-files-fd.mjs'

const conflict = () => new HttpError(409,'skill_conflict')
const sameMode = (a,b) => sameInode(a,b) && a.mode===b.mode && a.uid===b.uid && a.gid===b.gid
const sameSnapshot = (a,b) => sameMode(a,b) && a.nlink===b.nlink && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs

/** A short-lived selection proof for the caller's serialized preference operation. No
 * persona text or external workspace is reread while publishing native role preferences. */
export function skillRoleChoiceVerifier(dataDir, parentInfo, roleInfo, files) {
  const rootPath=resolve(dataDir)
  return () => {
    let parent,roles
    try {
      parent=openAbsoluteDirectory(rootPath)
      const mount=mountId(parent)
      if(!sameMode(parentInfo,stat(parent))) throw conflict()
      roles=openSync(fdPath(parent,'personas'),DIRECTORY)
      if(mountId(roles)!==mount || !sameSnapshot(roleInfo,stat(roles))) throw conflict()
      for(const {id,info} of files){
        let fd
        try {
          fd=openSync(fdPath(roles,id+'.md'),PATH)
          const current=stat(fd)
          if(!current.isFile() || current.nlink!==1n || !sameSnapshot(info,current) || mountId(fd)!==mount) throw conflict()
        } finally {close(fd)}
      }
      if(!sameSnapshot(roleInfo,stat(roles))) throw conflict()
      return true
    } catch {throw conflict()} finally {close(roles);close(parent)}
  }
}
