import { useState } from 'react'
import { AlarmClock, Cog, MessageCircle, Smartphone, Users } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { ProfilePanel } from './ProfilePanel'
import { Avatar } from './shell-common'

/** 图标栏的 tab：对话 / 角色 / 定时任务 / 机器人。 */
export type RailTab = 'chats' | 'roster' | 'tasks' | 'bots'

/* ============================ 最左：图标导航栏（微信式） ============================ */
/**
 * 窄图标栏：顶部当前用户头像，中部「对话 / 角色」切换（点击切左栏列表列），底部设置入口。
 * 把原先挤在列表列顶部的文字 tab 与底部的用户/设置脚移到这里，列表列因而只承载列表本身。
 */
export function IconRail({
  tab,
  onTab,
  listCollapsed,
  onChatsHover,
  onChatsLeave,
  onOpenSettings,
  chatAlert,
  unavailable,
  library
}: {
  tab: RailTab
  /** 点亮着的「对话」图标也回调（由调用方切换会话列表的收起 / 展开）。 */
  onTab: (t: RailTab) => void
  /** 对话页的会话列表已收起：「对话」图标的提示改为「展开会话列表」，红点也显示在它上面。 */
  listCollapsed: boolean
  /** 悬停 / 离开「对话」图标（收起时据此浮出列表）。 */
  onChatsHover?: () => void
  onChatsLeave?: () => void
  onOpenSettings: () => void
  /** 其他对话有新消息或待你处理 → 按钮上显示红点。 */
  chatAlert: boolean
  /** Explanation for features that this host does not expose. Omitted on desktop. */
  unavailable?: string
  library?: { openProfile: () => void; openRoster: () => void }
}): React.JSX.Element {
  const { t } = useI18n()
  const [profileOpen, setProfileOpen] = useState(false)
  // 亮着的「对话」图标点了是收起 / 展开，提示写明，免得点了以为列表丢了。
  const chatsLabel =
    tab !== 'chats' ? t('cf.tabChats') : listCollapsed ? t('cf.expandList') : t('cf.collapseList')
  return (
    <nav className="cf-iconrail">
      <button
        type="button"
        className="cf-iconrail__me"
        title={library ? t('cf.profile.open') : unavailable ?? t('cf.profile.open')}
        disabled={!!unavailable && !library}
        data-testid={library ? 'workbench-profile' : undefined}
        aria-label={t('cf.profile.open')}
        onClick={library?.openProfile ?? (() => setProfileOpen(true))}
      >
        <Avatar user size={34} />
      </button>
      {profileOpen && !unavailable && <ProfilePanel onClose={() => setProfileOpen(false)} />}
      <button
        className={`cf-navbtn${tab === 'chats' ? ' is-active' : ''}`}
        title={chatsLabel}
        aria-label={chatsLabel}
        aria-current={tab === 'chats'}
        aria-expanded={tab === 'chats' ? !listCollapsed : undefined}
        onClick={() => onTab('chats')}
        onMouseEnter={onChatsHover}
        onMouseLeave={onChatsLeave}
      >
        <MessageCircle size={20} />
        {/* 看不到会话列表时（不在对话页，或列表已收起），在导航按钮上提示其他对话的动静。 */}
        {(tab !== 'chats' || listCollapsed) && chatAlert && (
          <span className="cf-navbtn__dot" aria-hidden="true" />
        )}
      </button>
      <button
        className={`cf-navbtn${tab === 'roster' ? ' is-active' : ''}`}
        title={library ? t('cf.tabRoster') : unavailable ?? t('cf.tabRoster')}
        disabled={!!unavailable && !library}
        data-testid={library ? 'workbench-roster' : undefined}
        aria-label={t('cf.tabRoster')}
        aria-current={tab === 'roster'}
        onClick={library?.openRoster ?? (() => onTab('roster'))}
      >
        <Users size={20} />
      </button>
      <button
        className={`cf-navbtn${tab === 'tasks' ? ' is-active' : ''}`}
        title={unavailable ?? t('cf.tabTasks')}
        disabled={!!unavailable}
        aria-label={t('cf.tabTasks')}
        aria-current={tab === 'tasks'}
        onClick={() => onTab('tasks')}
      >
        <AlarmClock size={20} />
      </button>
      <div className="cf-spacer" />
      <button
        className={`cf-navbtn${tab === 'bots' ? ' is-active' : ''}`}
        title={unavailable ?? t('bots.title')}
        disabled={!!unavailable}
        aria-label={t('bots.title')}
        aria-current={tab === 'bots'}
        onClick={() => onTab('bots')}
      >
        <Smartphone size={20} />
      </button>
      <button
        className="cf-navbtn"
        title={t('cf.settings')}
        aria-label={t('cf.settings')}
        data-testid={unavailable ? "workbench-settings" : undefined}
        onClick={onOpenSettings}
      >
        <Cog size={20} />
      </button>
    </nav>
  )
}
