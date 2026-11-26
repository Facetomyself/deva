import type { DevaApi } from '../shared/host-api'

declare global {
  interface Window {
    deva: DevaApi
  }
}

export {}
