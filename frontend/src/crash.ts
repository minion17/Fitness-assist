// Crash reports from the Mini App to the owner (via /api/client-error).
import { ApiError, api, postJson, tg } from './telegram'

const sent = new Set<string>()

/** Send a crash report once per message per session; never throws. */
export function reportCrash(message: string, stack = '', where = '') {
  if (!tg?.initData || sent.has(message)) return  // outside Telegram there is no account to report from
  sent.add(message)
  api('/api/client-error', postJson({ message: message.slice(0, 500), stack: stack.slice(0, 1500), where: where.slice(0, 120) })).catch(() => {})
}

export function watchCrashes() {
  window.addEventListener('error', (e) => reportCrash(String(e.message), e.error?.stack ?? '', location.hash))
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    if (r instanceof ApiError) return  // a failed request is shown on screen already
    reportCrash(String(r?.message ?? r), r?.stack ?? '', 'promise')
  })
}
