import { useI18n } from '../renderer/src/i18n/i18n'

const serverNames: Readonly<Record<string, string>> = {
  aix: 'AIX', android: 'Android', cygwin: 'Cygwin', darwin: 'macOS', freebsd: 'FreeBSD', haiku: 'Haiku',
  linux: 'Linux', netbsd: 'NetBSD', openbsd: 'OpenBSD', sunos: 'SunOS', win32: 'Windows'
}
export function getServerPlatformLabel(platform: string, locale: string): string {
  const key = platform.toLowerCase()
  const zh = locale === 'zh-CN'
  const name = Object.hasOwn(serverNames, key) ? serverNames[key] : zh ? '未知' : 'Unknown'
  return zh ? `服务端平台：${name}` : `Server platform: ${name}`
}

export function ServerPlatformLabel({ platform }: { platform: string }): React.JSX.Element {
  const { locale } = useI18n()
  const label = getServerPlatformLabel(platform, locale)
  return <span className="wb-client-shell__server-platform" data-testid="workbench-server-platform" title={label}>{label}</span>
}
