'use strict'
/* global ExtensionAPI, ExtensionCommon, Services, Cc, Ci */
/**
 * browserUI - privileged Experiment API, runs in the browser process.
 * Only loads where extensions.experiments.enabled = true (LibreWolf, Developer Edition, Nightly)
 * and the add-on is installed unsigned. Sidebery feature-detects it (services/browser-ui.bg.ts).
 *
 * Sidebar side: the pref sidebar.position_start, which Firefox's own "Move Sidebar to Right/Left" toggles.
 *
 * Auto-hide: only while Sidebery's panel is the one shown in #sidebar-box, the box gets
 * [sidebery-autohide] and takes no layout space; autohide.css slides the panel over the page.
 * This script decides WHEN ([sidebery-open]), the CSS only animates:
 * - pointer enters the box (the 2px edge strip, the open panel or the hover zone): open, cancel any close
 * - pointer leaves: close after max(buffer, pull-out) ms, so a slide-out in progress always finishes
 * - a popup (context menu...), a drag, a resize or keyboard focus inside the panel keeps it open
 * - parity with the stock sidebar: resize handle on the inner edge (double-click resets), reveals on
 *   keyboard shortcuts that show/switch the sidebar, on keyboard focus and on drag-over
 *
 * Auto-hide toolbar: toolbar.css hides the toolbox; a transparent strip over the top window edge
 * (above the page and the sidebar) reveals it, see the end of toolbar.css.
 */

const POS_PREF = 'sidebar.position_start'
const XHTML = 'http://www.w3.org/1999/xhtml'
const MIN_WIDTH = 160
const MAX_WIDTH_RATIO = 0.8

// ponytail: ltr locales only; in rtl locales position_start means the right side
const getSide = () => (Services.prefs.getBoolPref(POS_PREF, true) ? 'left' : 'right')

this.browserUI = class extends ExtensionAPI {
  onShutdown() {
    if (this.wins) this.setAutohide({ sidebar: false, toolbar: false })
  }

  /** Same id Firefox gives the sidebar_action (ext-sidebarAction makeWidgetId) */
  get sidebarCommand() {
    const id = this.extension.id.toLowerCase().replace(/[^a-z0-9_-]/g, '_')
    return `${id}-sidebar-action`
  }

  init() {
    if (this.wins) return
    this.wins = new Map() // window -> { detach, update }
    this.widthListeners = new Set()
    this.sheet = this.extension.baseURI.resolve('experiments/browser-ui/autohide.css')
    this.toolbarSheet = this.extension.baseURI.resolve('experiments/browser-ui/toolbar.css')
    this.onWindowOpened = (subject, topic) => {
      if (topic !== 'domwindowopened') return
      subject.addEventListener('load', () => this.attach(subject), { once: true })
    }
  }

  setAutohide(conf) {
    this.init()
    const wasEnabled = !!(this.conf?.sidebar || this.conf?.toolbar)
    this.conf = conf

    if (!conf.sidebar && !conf.toolbar) {
      if (!wasEnabled) return
      Services.ww.unregisterNotification(this.onWindowOpened)
      for (const w of this.wins.values()) w.detach()
      this.wins.clear()
      return
    }

    if (wasEnabled) {
      for (const w of this.wins.values()) w.update()
      return
    }

    // The add-on can start while a window is still loading (slow session restore): wait for it
    for (const win of Services.wm.getEnumerator('navigator:browser')) {
      if (win.document.readyState === 'complete') this.attach(win)
      else win.addEventListener('load', () => this.attach(win), { once: true })
    }
    Services.ww.registerNotification(this.onWindowOpened)
  }

  attach(win) {
    if (this.wins.has(win) || !(this.conf?.sidebar || this.conf?.toolbar)) return
    const doc = win.document
    if (doc.documentElement.getAttribute('windowtype') !== 'navigator:browser') return
    const box = doc.getElementById('sidebar-box')
    if (!box) return

    const utils = win.windowUtils
    utils.loadSheetUsingURIString(this.sheet, utils.USER_SHEET)

    let timer = null
    let hovered = false
    let popups = 0
    let resizing = false
    let focusHold = false
    const attachedAt = Date.now()

    const active = () => box.hasAttribute('sidebery-autohide')
    const dragging = () => {
      try {
        const ds = Cc['@mozilla.org/widget/dragservice;1'].getService(Ci.nsIDragService)
        return !!ds.getCurrentSession(win)
      } catch {
        return false
      }
    }
    const cancel = () => {
      if (timer !== null) win.clearTimeout(timer)
      timer = null
    }
    const tryClose = () => {
      timer = null
      if (hovered && !box.matches(':hover')) hovered = false // a missed mouseleave must not keep it open
      if (hovered || popups > 0 || resizing || focusHold || dragging()) {
        timer = win.setTimeout(tryClose, 250)
        return
      }
      box.removeAttribute('sidebery-open')
    }
    const scheduleClose = () => {
      cancel()
      timer = win.setTimeout(tryClose, Math.max(this.conf.buffer, this.conf.pullOut))
    }
    // Show without the mouse, then close after the buffer unless something holds it open
    const reveal = () => {
      if (!active()) return
      cancel()
      box.setAttribute('sidebery-open', '')
      scheduleClose()
    }

    const onEnter = () => {
      if (!active()) return
      hovered = true
      cancel()
      box.setAttribute('sidebery-open', '')
    }
    const onLeave = () => {
      hovered = false
      if (active()) scheduleClose()
    }
    const onPopupShown = () => {
      popups++
      cancel()
    }
    const onPopupHidden = () => {
      popups = Math.max(0, popups - 1)
      if (!popups && !hovered && box.hasAttribute('sidebery-open')) scheduleClose()
    }
    const onFocusIn = () => {
      if (hovered || !active()) return
      focusHold = true
      reveal()
    }
    const onFocusOut = () => {
      focusHold = false
      if (!hovered && active()) scheduleClose()
    }

    // Applies only while Sidebery's panel is the one in the box. Keyboard shortcuts and menu items
    // show or switch the sidebar by changing these attributes (ignore the session restore at startup).
    const sync = () => {
      const ours =
        this.conf.sidebar &&
        box.getAttribute('sidebarcommand') === this.sidebarCommand &&
        !box.hidden
      if (ours) box.setAttribute('sidebery-autohide', '')
      else {
        box.removeAttribute('sidebery-autohide')
        box.removeAttribute('sidebery-open')
      }
      return ours
    }
    const mo = new win.MutationObserver(() => {
      if (sync() && Date.now() - attachedAt > 5000) reveal()
    })
    mo.observe(box, { attributes: true, attributeFilter: ['hidden', 'sidebarcommand'] })

    // An auto-hidden toolbox (position: fixed, toolbar.css or userChrome.css) overlays the top of the window.
    // Everything below follows the timing of the toolbox's own opacity transition, whatever made it
    // show or hide, so it moves in sync with it.
    const toolbox = doc.getElementById('navigator-toolbox')
    const browserEl = doc.getElementById('browser')
    let toolboxH = 0
    let toolboxShown = false
    const toolboxFixed = () => win.getComputedStyle(toolbox).position === 'fixed'
    const pushOn = () => !!this.conf.toolbar && this.conf.toolbarPage === 'push' && toolboxFixed()

    // Page: "overlay" leaves it under the toolbox, "push" moves the whole browser area (page and sidebar)
    // down while the toolbox is shown. It slides with a transform (no re-layout per frame, the bottom goes
    // past the window edge for a moment), and once the slide ends the transform is swapped for a real
    // margin in the same frame, so the page gets its bottom back with one resize. Hiding swaps back first.
    let pushTarget = 0 // px the area is moving to
    let pushMargin = false // the shown state is laid out as a margin
    const setPushStyle = (transform, margin, transition = 'none') => {
      browserEl.style.setProperty('transition', transition, 'important')
      browserEl.style.setProperty('transform', transform, 'important')
      browserEl.style.setProperty('margin-top', margin, 'important')
    }
    const resetPush = () => {
      pushTarget = 0
      pushMargin = false
      for (const p of ['transition', 'transform', 'margin-top']) browserEl.style.removeProperty(p)
    }
    const push = (shown, t) => {
      if (!pushOn()) {
        if (pushTarget || pushMargin) resetPush()
        return
      }
      const transition = `transform ${t.duration}ms ${t.easing} ${t.delay}ms`
      if (shown) {
        if (pushMargin) return
        pushTarget = toolboxH
        setPushStyle(`translateY(${toolboxH}px)`, '0px', transition)
      } else {
        if (pushMargin) {
          // margin -> equal transform, invisible: the top stays where it is, the bottom grows past the edge
          setPushStyle(`translateY(${toolboxH}px)`, '0px')
          browserEl.getBoundingClientRect()
          pushMargin = false
        }
        pushTarget = 0
        setPushStyle('translateY(0px)', '0px', transition)
      }
    }
    const onPushEnd = e => {
      if (e.target !== browserEl || e.propertyName !== 'transform') return
      if (pushTarget) {
        setPushStyle('none', `${pushTarget}px`)
        pushMargin = true
      } else if (!pushMargin) resetPush()
    }
    browserEl.addEventListener('transitionend', onPushEnd)

    // Sidebar top: "overlap" ignores the toolbox, "below" always leaves room for it, "follow" moves
    // with it. Not needed while the page itself is pushed.
    const setTop = (dur = 0, ease = 'linear', delay = 0) => {
      const mode = this.conf.top
      const room =
        toolboxFixed() && !pushOn() && (mode === 'below' || (mode === 'follow' && toolboxShown))
      box.style.setProperty('--sidebery-ah-top', `${room ? toolboxH : 0}px`)
      box.style.setProperty('--sidebery-ah-top-dur', `${dur}ms`)
      box.style.setProperty('--sidebery-ah-top-ease', ease)
      box.style.setProperty('--sidebery-ah-top-delay', `${delay}ms`)
    }
    // Layout height, not affected by the toolbox's rotate transform; includes the menu bar when it is on
    const ro = new win.ResizeObserver(entries => {
      toolboxH = Math.round(entries[0].borderBoxSize[0].blockSize)
      setTop()
      if (pushMargin) setPushStyle('none', `${toolboxH}px`)
    })
    ro.observe(toolbox)
    const onToolboxTransition = e => {
      if (e.target !== toolbox || e.propertyName !== 'opacity') return
      const anim = toolbox.getAnimations().find(a => a.transitionProperty === 'opacity')
      if (!anim) return
      const frames = anim.effect.getKeyframes()
      toolboxShown = parseFloat(frames[frames.length - 1].opacity) > 0.5
      const t = anim.effect.getTiming()
      if (this.conf.top === 'follow') setTop(t.duration, t.easing, t.delay)
      push(toolboxShown, t)
    }
    toolbox.addEventListener('transitionrun', onToolboxTransition)

    // Auto-hide toolbar: reveal strip, see toolbar.css
    const root = doc.documentElement
    let trigger = null
    let tbTimer = null
    const tbCheck = () => {
      tbTimer = null
      // Keep forcing it while the pointer is on the toolbox (or still on its way, see the first delay)
      if (toolbox.matches(':hover')) tbTimer = win.setTimeout(tbCheck, 100)
      else root.removeAttribute('sidebery-toolbar-reveal')
    }
    const onTrigger = () => {
      root.setAttribute('sidebery-toolbar-reveal', '')
      if (tbTimer !== null) win.clearTimeout(tbTimer)
      // the toolbox needs ~115ms to show and get under the pointer
      tbTimer = win.setTimeout(tbCheck, 400)
    }
    const setToolbar = on => {
      if (on === !!trigger) return
      if (on) {
        utils.loadSheetUsingURIString(this.toolbarSheet, utils.USER_SHEET)
        trigger = doc.createElementNS(XHTML, 'div')
        trigger.id = 'sidebery-toolbar-trigger'
        trigger.addEventListener('mouseenter', onTrigger)
        toolbox.after(trigger)
      } else {
        if (tbTimer !== null) win.clearTimeout(tbTimer)
        tbTimer = null
        trigger.remove()
        trigger = null
        root.removeAttribute('sidebery-toolbar-reveal')
        root.style.removeProperty('--sidebery-tb-trigger')
        try {
          utils.removeSheetUsingURIString(this.toolbarSheet, utils.USER_SHEET)
        } catch {
          // window is already closed
        }
      }
    }

    // Settings
    const update = () => {
      setToolbar(!!this.conf.toolbar)
      if (trigger) root.style.setProperty('--sidebery-tb-trigger', `${this.conf.toolbarTrigger}px`)
      sync()
      box.style.setProperty('--sidebery-ah-width', `${this.conf.width}px`)
      box.style.setProperty('--sidebery-ah-pull-out', `${this.conf.pullOut}ms`)
      box.style.setProperty('--sidebery-ah-pull-in', `${this.conf.pullIn}ms`)
      box.setAttribute('sidebery-anim', this.conf.anim)
      setTop()
      if (!pushOn()) resetPush()
    }
    update()

    // Resize handle on the inner edge of the panel
    const handle = doc.createElementNS(XHTML, 'div')
    handle.id = 'sidebery-resizer'
    box.appendChild(handle)
    let lastW = 0
    const onDown = e => {
      if (e.button !== 0) return
      resizing = true
      cancel()
      handle.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
    const onMove = e => {
      if (!resizing) return
      const atEnd = box.hasAttribute('sidebar-positionend') || box.hasAttribute('positionend')
      const raw = atEnd ? win.innerWidth - e.clientX : e.clientX
      lastW = Math.round(Math.min(Math.max(raw, MIN_WIDTH), win.innerWidth * MAX_WIDTH_RATIO))
      box.style.setProperty('--sidebery-ah-width', `${lastW}px`)
    }
    const onUp = e => {
      if (!resizing) return
      resizing = false
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {
        // already released
      }
      if (lastW) for (const cb of this.widthListeners) cb(lastW)
      scheduleClose()
    }
    const onReset = () => {
      for (const cb of this.widthListeners) cb(0)
    }

    handle.addEventListener('pointerdown', onDown)
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
    handle.addEventListener('dblclick', onReset)
    box.addEventListener('dragenter', reveal)
    box.addEventListener('focus', onFocusIn, true) // focus does not bubble, capture it
    box.addEventListener('blur', onFocusOut, true)
    box.addEventListener('mouseenter', onEnter)
    box.addEventListener('mouseleave', onLeave)
    doc.addEventListener('popupshown', onPopupShown, true)
    doc.addEventListener('popuphidden', onPopupHidden, true)

    const detach = () => {
      cancel()
      mo.disconnect()
      handle.remove()
      box.removeEventListener('dragenter', reveal)
      box.removeEventListener('focus', onFocusIn, true)
      box.removeEventListener('blur', onFocusOut, true)
      box.removeEventListener('mouseenter', onEnter)
      box.removeEventListener('mouseleave', onLeave)
      doc.removeEventListener('popupshown', onPopupShown, true)
      doc.removeEventListener('popuphidden', onPopupHidden, true)
      setToolbar(false)
      resetPush()
      browserEl.removeEventListener('transitionend', onPushEnd)
      ro.disconnect()
      toolbox.removeEventListener('transitionrun', onToolboxTransition)
      box.removeAttribute('sidebery-autohide')
      box.removeAttribute('sidebery-open')
      box.removeAttribute('sidebery-anim')
      for (const p of ['width', 'pull-out', 'pull-in', 'top', 'top-dur', 'top-ease', 'top-delay']) {
        box.style.removeProperty(`--sidebery-ah-${p}`)
      }
      try {
        utils.removeSheetUsingURIString(this.sheet, utils.USER_SHEET)
      } catch {
        // window is already closed
      }
    }
    win.addEventListener('unload', () => this.wins.delete(win), { once: true })
    this.wins.set(win, { detach, update })
  }

  getAPI(context) {
    return {
      browserUI: {
        getSidebarSide: async () => getSide(),
        setSidebarSide: async side => {
          if (getSide() !== side) Services.prefs.setBoolPref(POS_PREF, side === 'left')
        },
        setAutohide: async conf => this.setAutohide(conf),

        onSidebarSideChanged: new ExtensionCommon.EventManager({
          context,
          name: 'browserUI.onSidebarSideChanged',
          register: fire => {
            const observer = () => fire.async(getSide())
            Services.prefs.addObserver(POS_PREF, observer)
            return () => Services.prefs.removeObserver(POS_PREF, observer)
          },
        }).api(),

        onAutohideWidthChanged: new ExtensionCommon.EventManager({
          context,
          name: 'browserUI.onAutohideWidthChanged',
          register: fire => {
            this.init()
            const cb = width => fire.async(width)
            this.widthListeners.add(cb)
            return () => this.widthListeners.delete(cb)
          },
        }).api(),
      },
    }
  }
}
