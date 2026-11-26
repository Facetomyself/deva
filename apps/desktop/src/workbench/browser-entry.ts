import { captureClaim } from './transport'

// Clear the credential before the slower React/UI chunk or any network request starts.
const handoff = { claim: captureClaim(window.location, window.history) }
window.addEventListener('pageshow', (event) => {
  // A restored page may have an obsolete session or settings revision from before navigation.
  if (event.persisted) window.location.reload()
})

void import('./first-use')
  .then(({ mountFirstUse }) => mountFirstUse(handoff))
  .catch(() => {
    handoff.claim = undefined
    const status = document.querySelector('#root [role="status"]')
    if (!status) return
    status.setAttribute('role', 'alert')
    status.textContent = 'Deva Web failed to load. Reload the page to try again. / 页面载入失败。请刷新重试。'
  })
