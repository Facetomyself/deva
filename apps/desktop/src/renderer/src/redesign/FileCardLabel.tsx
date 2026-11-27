import type { ReactNode } from 'react'

/** The filename and file-type label shared by desktop attachments and the headless text preview. */
export function FileCardLabel({ icon, name, meta }: { icon: ReactNode; name: ReactNode; meta?: string }): React.JSX.Element {
  return <>
    <span className="cf-fcard__ico" aria-hidden="true">{icon}</span>
    <span className="cf-fcard__txt">
      <span className="cf-fcard__name">{name}</span>
      {meta && <span className="cf-fcard__meta">{meta}</span>}
    </span>
  </>
}
