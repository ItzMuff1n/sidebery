import { DEFAULT_SETTINGS } from 'src/defaults'
import * as Settings from 'src/services/settings.bg'
import * as Logs from 'src/services/logs'

/**
 * Bridge to the browserUI Experiment API (src/experiments/browser-ui), which reaches
 * the browser window itself. It exists only where privileged add-ons are allowed
 * (extensions.experiments.enabled = true); without it Sidebery works as usual:
 * the sidebar side is a manual setting and there is no auto-hide.
 */

type Side = 'left' | 'right'
interface Event<T> {
  addListener(cb: (arg: T) => void): void
}
interface AutohideConf {
  enabled: boolean
  width?: number
  pullOut?: number
  pullIn?: number
  buffer?: number
  anim?: string
  top?: string
}
interface BrowserUIAPI {
  getSidebarSide(): Promise<Side>
  setSidebarSide(side: Side): Promise<void>
  setAutohide(conf: AutohideConf): Promise<void>
  onSidebarSideChanged: Event<Side>
  onAutohideWidthChanged: Event<number>
}

const api = (browser as unknown as { browserUI?: BrowserUIAPI }).browserUI

export const available = !!api

let appliedSide: Side | undefined
let appliedAutohide = ''

/**
 * Sync the sidebar side both ways and apply auto-hide.
 * At startup Firefox's side wins: it is what the user sees.
 */
export async function load(): Promise<void> {
  if (!api) return
  Logs.info('BrowserUI.load')

  api.onSidebarSideChanged.addListener(side => {
    appliedSide = side
    if (Settings.state.sidebarSide === side) return
    Settings.state.sidebarSide = side
    Settings.saveSettings()
  })

  api.onAutohideWidthChanged.addListener(width => {
    Settings.state.autohideWidth = width || DEFAULT_SETTINGS.autohideWidth
    Settings.saveSettings()
  })

  appliedSide = await api.getSidebarSide()
  if (Settings.state.sidebarSide !== appliedSide) {
    Settings.state.sidebarSide = appliedSide
    Settings.saveSettings()
  }

  apply()
}

/**
 * Push changed settings to the browser. Called after every settings update.
 */
export function apply(): void {
  if (!api || !appliedSide) return
  const s = Settings.state

  if (s.sidebarSide !== appliedSide) {
    appliedSide = s.sidebarSide
    api.setSidebarSide(s.sidebarSide)
  }

  const conf: AutohideConf = { enabled: s.autohide }
  if (s.autohide) {
    conf.width = toInt(s.autohideWidth, DEFAULT_SETTINGS.autohideWidth)
    conf.pullOut = toInt(s.autohidePullOut, DEFAULT_SETTINGS.autohidePullOut)
    conf.pullIn = toInt(s.autohidePullIn, DEFAULT_SETTINGS.autohidePullIn)
    conf.buffer = toInt(s.autohideBuffer, DEFAULT_SETTINGS.autohideBuffer)
    conf.anim = s.autohideAnim
    conf.top = s.autohideTop
  }
  const json = JSON.stringify(conf)
  if (json === appliedAutohide) return
  appliedAutohide = json
  api.setAutohide(conf)
}

// Number fields of the settings page can store strings
function toInt(value: number | string, or: number): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n >= 0 ? n : or
}
