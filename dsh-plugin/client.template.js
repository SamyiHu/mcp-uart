/**
 * UART panel —DSH carrier (source).
 *
 * `dsh-plugin/client.js` is GENERATED from this file by
 * `scripts/build-dsh-client.mjs`, which inlines src/hub/public/uart-ui.js at the
 * marker below. The standalone Hub page loads that same file directly, so the
 * console stays one implementation with two carriers.
 *
 * Why inline instead of a dynamic module load: the Desktop client runs on the `dsh-app://`
 * scheme, where dynamic module imports are refused.
 *
 * Placement: the console can live in the main panel (default) or in a floating
 * window on `shell.overlay`; the choice persists per client.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-uart',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    //__UART_UI__

    const NS = '@local/dsh-uart'
    const PANEL_ID = 'uart'
    const FLOAT_ID = 'uart-float'
    const DOCK_ID = 'uart-dock'
    const DOCK_OPEN_KEY = 'dsh-uart.dock-open'
    const DOCK_CHIP_KEY = 'dsh-uart.dock-chip'
    const DECODE_KEY = 'dsh-uart.decode'
    const DECODE_ENCODING_KEY = 'dsh-uart.decode-encoding'
    const FOLLOW_KEY = 'dsh-uart.dock-follow'
    const ROUTE = 'uart'

    const zh = { nav: '串口', title: '串口调试', float: '悬浮窗', dock: '停靠到工作区', close: '关闭', parkedTitle: '串口控制台在悬浮窗中', parkedBody: '关闭悬浮窗，或点「停靠到工作区」把控制台放回这里。', openFloat: '打开悬浮窗', settingsTitle: '串口控制台', settingsBody: '选择控制台显示的位置。改动会立即生效，并记住到下次启动。', optionPanel: '工作区面板', optionPanelBody: '控制台占用串口面板的主区域。', optionFloat: '悬浮球', optionFloatBody: '右下角显示一个串口圆球：鼠标碰上去展开成胶囊，点击展开完整控制台。', optionDockChip: '底栏状态条', optionDockChipBody: '在输入框下方显示一行串口状态（连接、波特率、帧率），点「展开」以悬浮窗打开控制台。', optionAgentTool: 'Agent 工具', optionAgentToolBody: '允许 Agent 调用串口工具（uart_serial / uart_dut / uart_view）。关闭后模型侧没有任何串口工具，面板照常可用。', optionDockFollow: '自动滚到最新', optionDockFollowBody: '底栏预览有新数据时自动滚到底部；向上翻看旧数据时暂停，滚回底部后恢复。', decodeTitle: '数据解码', decodeBody: '底栏预览按这个偏好显示接收数据；编码只影响显示，不会重连串口。', decodeAuto: '自动', decodeText: '文本', decodeHex: 'HEX', optionCurrent: '当前' }
    const en = { nav: 'UART', title: 'Serial console', float: 'Float', dock: 'Dock to panel', close: 'Close', parkedTitle: 'The console is in a floating window', parkedBody: 'Close the floating window, or dock it back into this panel.', openFloat: 'Open floating window', settingsTitle: 'Serial console', settingsBody: 'Choose where the console lives. Changes apply immediately and are remembered across launches.', optionPanel: 'Workspace panel', optionPanelBody: 'The console fills the UART panel area.', optionFloat: 'Floating orb', optionFloatBody: 'A small serial orb sits at the bottom right: hover it for a capsule, click it to open the full console.', optionDock: 'Composer dock', optionDockBody: 'The console sits under the message box, usable while you chat.', optionDockChip: 'Dock status row', optionDockChipBody: 'Shows one compact serial line under the composer (link, baud, frame rate); Expansion opens the console right there.', optionAgentTool: 'Agent tools', optionAgentToolBody: 'Lets the Agent call the serial tools (uart_serial / uart_dut / uart_view). Off removes every serial tool from the model; the panel keeps working.', optionDockFollow: 'Follow newest data', optionDockFollowBody: 'Scrolls the dock preview to the newest frame. Pauses while you scroll up, resumes when you return to the bottom.', decodeTitle: 'Data decoding', decodeBody: 'The dock preview decodes received bytes with this preference. The encoding only affects display; it never reconnects the port.', decodeAuto: 'Auto', decodeText: 'Text', decodeHex: 'HEX', optionCurrent: 'Current' }

    // ── placement store (panel | float) ────────────────────────────────────
    const MODE_KEY = 'dsh-uart.display-mode'
    const RECT_KEY = 'dsh-uart.float-rect'
    const FLOAT_STATE_KEY = 'dsh-uart.float-state'
    const BUBBLE_POS_KEY = 'dsh-uart.bubble-pos'

    function readStorage(key, fallback) {
      try {
        return window.localStorage.getItem(key) ?? fallback
      } catch {
        return fallback
      }
    }
    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* private mode: the choice simply does not persist */
      }
    }

    const storedMode = readStorage(MODE_KEY, 'panel')
    const placement = {
      // panel = workspace page · float = orb/window · dock = under the composer
      // 'dock' was a third placement in an earlier build; the console now opens
      // as the floating window instead, so an old stored value maps to panel.
      mode: storedMode === 'float' ? 'float' : 'panel',
      listeners: new Set(),
    }

    /**
     * Whether the compact status chip sits in the composer dock row.
     *
     * Independent of `placement`: like the oscilloscope chip it can sit in the
     * bottom row while the console itself lives in the panel or the orb, and it
     * can be switched off entirely for people who do not want a permanent row.
     */
    const dockChip = {
      enabled: readStorage(DOCK_CHIP_KEY, '1') !== '0',
      listeners: new Set(),
    }
    function setDockChip(next) {
      if (dockChip.enabled === next) return
      dockChip.enabled = next
      writeStorage(DOCK_CHIP_KEY, next ? '1' : '0')
      for (const listener of [...dockChip.listeners]) listener()
    }
    function useDockChip() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        dockChip.listeners.add(listener)
        return () => dockChip.listeners.delete(listener)
      }, [])
      return [dockChip.enabled, setDockChip]
    }

    /** Auto-scroll the dock preview to the newest frame (default on). */
    const dockFollow = {
      enabled: readStorage(FOLLOW_KEY, '1') !== '0',
      listeners: new Set(),
    }
    function setDockFollow(next) {
      if (dockFollow.enabled === next) return
      dockFollow.enabled = next
      writeStorage(FOLLOW_KEY, next ? '1' : '0')
      for (const listener of [...dockFollow.listeners]) listener()
    }
    function useDockFollow() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        dockFollow.listeners.add(listener)
        return () => dockFollow.listeners.delete(listener)
      }, [])
      return [dockFollow.enabled, setDockFollow]
    }
    function setMode(next) {
      if (placement.mode === next) return
      placement.mode = next
      writeStorage(MODE_KEY, next)
      // Entering floating mode always lands on the orb, never straight into the
      // full window: the orb is the resting state of that mode.
      if (next === 'float') setFloatState('bubble')
      for (const listener of [...placement.listeners]) listener()
    }
    function useMode() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        placement.listeners.add(listener)
        return () => placement.listeners.delete(listener)
      }, [])
      return [placement.mode, setMode]
    }

    /** Resting shape of floating mode: a small orb, or the full console window. */
    const floatShape = {
      state: readStorage(FLOAT_STATE_KEY, 'bubble') === 'window' ? 'window' : 'bubble',
      listeners: new Set(),
    }
    function setFloatState(next) {
      if (floatShape.state === next) return
      floatShape.state = next
      writeStorage(FLOAT_STATE_KEY, next)
      for (const listener of [...floatShape.listeners]) listener()
    }
    function useFloatState() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        floatShape.listeners.add(listener)
        return () => floatShape.listeners.delete(listener)
      }, [])
      return [floatShape.state, setFloatState]
    }

    const BUBBLE_SIZE = 44
    const BUBBLE_GAP_RIGHT = 24
    const BUBBLE_GAP_BOTTOM = 96
    /**
     * Keep every floating surface below the host's own title/status bar.
     *
     * The overlay layer starts at the very top of the window, so a window
     * dragged to y=0 puts its title bar under DSH's chrome —the ✕and 鍋滈潬
     * buttons become unclickable and the window cannot be closed.
     */
    const TOP_SAFE = 56

    function clampBubble(next) {
      const maxX = Math.max(8, window.innerWidth - BUBBLE_SIZE - 8)
      const maxY = Math.max(TOP_SAFE, window.innerHeight - BUBBLE_SIZE - 8)
      return { x: Math.min(Math.max(next.x, 8), maxX), y: Math.min(Math.max(next.y, TOP_SAFE), maxY) }
    }

    /**
     * Position is stored as a fraction of the viewport, not as pixels.
     *
     * With absolute pixels, resizing the DSH window left the orb at its old
     * coordinate: shrinking pushed it into the corner, growing left it floating
     * in the middle. A fraction keeps it in the same place relative to the
     * window at any size.
     */
    function bubbleFromFraction(fx, fy) {
      return clampBubble({ x: fx * window.innerWidth, y: fy * window.innerHeight })
    }

    function fractionFromBubble(bubble) {
      return {
        fx: Math.min(1, Math.max(0, bubble.x / Math.max(1, window.innerWidth))),
        fy: Math.min(1, Math.max(0, bubble.y / Math.max(1, window.innerHeight))),
      }
    }

    /**
     * Position is a viewport fraction, rendered as a percentage.
     *
     * Storing pixels meant a window resize left the orb at its old coordinate
     * (clamped into the corner when shrinking). A percentage of the viewport is
     * resolved by CSS on every layout, so the orb keeps its relative place with
     * no resize listener at all.
     */
    function loadBubblePos() {
      try {
        const parsed = JSON.parse(readStorage(BUBBLE_POS_KEY, 'null'))
        if (parsed && Number.isFinite(parsed.fx) && Number.isFinite(parsed.fy)) {
          return { fx: clampFraction(parsed.fx), fy: clampFraction(parsed.fy) }
        }
        // Legacy absolute position: convert once so the orb does not jump.
        if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
          const fraction = fractionFromBubble(parsed)
          writeStorage(BUBBLE_POS_KEY, JSON.stringify(fraction))
          return fraction
        }
      } catch {
        /* fall through to the default corner */
      }
      return {
        fx: 1 - (BUBBLE_SIZE + BUBBLE_GAP_RIGHT) / Math.max(1, window.innerWidth),
        fy: 1 - (BUBBLE_SIZE + BUBBLE_GAP_BOTTOM) / Math.max(1, window.innerHeight),
      }
    }

    function clampFraction(value) {
      return Math.min(1, Math.max(0, value))
    }

    function loadRect() {
      const known = (() => {
        try {
          const parsed = JSON.parse(readStorage(RECT_KEY, 'null'))
          if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y) && Number.isFinite(parsed.w) && Number.isFinite(parsed.h)) return parsed
        } catch {
          /* fall through to the default rect */
        }
        return null
      })()
      const fallback = { x: Math.max(24, window.innerWidth - 820), y: 96, w: 760, h: 560 }
      const wanted = known ?? fallback
      // A rect saved on another monitor (or before the window shrank) must not
      // reopen off-screen: clamp it into the current viewport on every launch.
      const w = Math.min(Math.max(wanted.w, 420), Math.max(420, window.innerWidth - 16))
      const height = Math.min(Math.max(wanted.h, 260), Math.max(260, window.innerHeight - 16))
      const x = Math.min(Math.max(wanted.x, 8), Math.max(8, window.innerWidth - w - 8))
      const y = Math.min(Math.max(wanted.y, TOP_SAFE), Math.max(TOP_SAFE, window.innerHeight - 96))
      return { x, y, w, h: height }
    }

    // ── host panel info (browser URL + origin) ─────────────────────────────
    function apiPath(path) {
      const relative = String(path).replace(/^\/+/, '')
      return new URL(relative, document.baseURI).pathname
    }

    let panelInfoRequest = null
    function panelInfo() {
      if (panelInfoRequest === null) {
        panelInfoRequest = fetch(apiPath(`${ROUTE}/api/panel`), { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
      }
      return panelInfoRequest
    }
    function usePanelInfo() {
      const [info, setInfo] = useState(null)
      useEffect(() => {
        let live = true
        panelInfo().then((value) => {
          if (live) setInfo(value)
        })
        return () => {
          live = false
        }
      }, [])
      return info
    }

    // ── shared console mount ───────────────────────────────────────────────
    /** Header action as a real DOM node —the console builds plain DOM, not React. */
    function domAction(label, title, onClick) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'uart-link'
      button.textContent = label
      button.title = title
      button.addEventListener('click', onClick)
      return button
    }
    function ConsoleMount({ locale, actions, dense = false }) {
      const hostRef = useRef(null)
      const info = usePanelInfo()
      const externalUrl = info?.hubUrl ?? undefined

      useEffect(() => {
        if (hostRef.current === null) return undefined
        const ui = createUartUi({
          root: hostRef.current,
          apiBase: `${ROUTE}/`,
          locale,
          externalUrl,
          actions,
          dense,
        })
        return () => ui.destroy()
      }, [locale, externalUrl, actions, dense])

      return h('div', { ref: hostRef, style: { width: '100%', height: '100%', minHeight: 0, minWidth: 0, flex: '1 1 auto', alignSelf: 'stretch' } })
    }

    function LinkButton({ onClick, children, title }) {
      return h(
        'button',
        {
          type: 'button',
          title,
          onClick,
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            font: 'inherit',
            fontSize: '11px',
            height: '22px',
            padding: '0 8px',
            borderRadius: '6px',
            cursor: 'pointer',
          },
        },
        children,
      )
    }

    // ── floating window ────────────────────────────────────────────────────
    /** Stable empty action list: a fresh array would remount the console on every render. */
    const NO_ACTIONS = []

    /**
     * Resting orb: hover/focus peels it open into a capsule, a click (not a
     * drag) opens the full console. Nothing here is persisted except the
     * position and the resulting shape.
     */
    function BubbleOrb({ locale }) {
      const zhLocale = String(locale).toLowerCase().startsWith('zh')
      const [peek, setPeek] = useState(false)
      const [pos, setPos] = useState(loadBubblePos)
      const measureRef = useRef(null)
      // 132px is a sensible first paint; the effect below replaces it with the
      // real content width once the measurer has been laid out.
      const [measuredWidth, setMeasuredWidth] = useState(132)
      const hoverTimer = useRef(0)
      const drag = useRef(null)
      const posRef = useRef(pos)
      posRef.current = pos
      // Pixel position for this layout pass; the stored state is a fraction.
      const pixelPos = useRef({ x: pos.fx * window.innerWidth, y: pos.fy * window.innerHeight })
      pixelPos.current = { x: pos.fx * window.innerWidth, y: pos.fy * window.innerHeight }

      const clearHover = () => {
        if (hoverTimer.current !== 0) {
          clearTimeout(hoverTimer.current)
          hoverTimer.current = 0
        }
      }
      const open = () => {
        clearHover()
        setFloatState('window')
      }
      const enter = () => {
        // Touch devices have no hover phase; a tap goes straight to the window.
        if (typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches) return
        clearHover()
        setPeek(true)
      }
      const leave = () => {
        clearHover()
        hoverTimer.current = setTimeout(() => setPeek(false), 200)
      }

      useEffect(() => () => clearHover(), [])

      // Size the capsule to its content: icon + label + arrow + 14px padding on
      // both sides. Measured instead of hardcoded so zh/en and font scaling all
      // fit exactly, with no empty strip on the right.
      useEffect(() => {
        const node = measureRef.current
        if (node === null) return
        const width = node.getBoundingClientRect().width
        if (width > 0) setMeasuredWidth(Math.ceil(width + 28))
      }, [locale])

      const onPointerDown = useCallback((event) => {
        if (event.button !== 0) return
        event.preventDefault()
        // Drag in pixels (the pointer works in pixels), store fractions.
        const origin = {
          x: posRef.current.fx * window.innerWidth,
          y: posRef.current.fy * window.innerHeight,
        }
        const start = { x: event.clientX, y: event.clientY, from: origin, moved: false, current: origin }
        drag.current = start
        const move = (moveEvent) => {
          const dx = moveEvent.clientX - start.x
          const dy = moveEvent.clientY - start.y
          // A 4px dead zone separates "drag the orb" from "open the console".
          if (!start.moved && Math.hypot(dx, dy) > 4) start.moved = true
          if (!start.moved) return
          start.current = clampBubble({ x: start.from.x + dx, y: start.from.y + dy })
          setPos(fractionFromBubble(start.current))
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          const finished = drag.current
          drag.current = null
          if (finished === null || !finished.moved) {
            open()
            return
          }
          // Persist as a viewport fraction so the orb tracks the window size.
          writeStorage(BUBBLE_POS_KEY, JSON.stringify(fractionFromBubble(finished.current)))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }, [])

      const label = zhLocale ? 'UART 串口' : 'UART serial'
      const capsuleWidth = measuredWidth
      // Percentages resolve against the viewport on every layout, so the orb
      // keeps its relative place when the host window is resized. clamp() keeps
      // it fully on screen and below the title bar.
      const leftCss = `clamp(8px, ${(pos.fx * 100).toFixed(3)}%, calc(100% - ${BUBBLE_SIZE + 8}px))`
      const topCss = `clamp(${TOP_SAFE}px, ${(pos.fy * 100).toFixed(3)}%, calc(100% - ${BUBBLE_SIZE + 8}px))`
      // Anchor the EDGE that stays put: growing towards the cursor's side would
      // move the button out from under the pointer and make hover flicker.
      const roomRight = window.innerWidth - (pixelPos.current.x + BUBBLE_SIZE) - 8
      const anchor = roomRight < capsuleWidth - BUBBLE_SIZE
        ? { right: `${Math.max(8, roomRight)}px` }
        : { left: leftCss }

      // Invisible copy of the expanded content, used to size the capsule to its
      // text instead of a fixed width with dead space on the right.
      const measurer = h(
        'span',
        {
          ref: measureRef,
          'aria-hidden': 'true',
          style: {
            position: 'absolute',
            left: '-9999px',
            top: '0',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          },
        },
        h('span', { style: { display: 'flex', flex: 'none' } }, h(UartIcon, { size: 22 })),
        h(
          'span',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '2px' } },
          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, label),
          h('span', { style: { fontSize: '12px' } }, '›'),
        ),
      )

      return h(
        'button',
        {
          type: 'button',
          'aria-label': label,
          'aria-expanded': peek ? 'true' : 'false',
          title: zhLocale ? 'UART 串口 — 点击打开控制台' : 'UART serial — click to open the console',
          onPointerEnter: enter,
          onPointerLeave: leave,
          onFocus: enter,
          onBlur: leave,
          onPointerDown,
          onClick: (event) => {
            // Keyboard activation arrives here without a pointer sequence.
            if (event.detail === 0) open()
          },
          style: {
            position: 'fixed',
            ...anchor,
            top: topCss,
            height: `${BUBBLE_SIZE}px`,
            width: peek ? `${capsuleWidth}px` : `${BUBBLE_SIZE}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: peek ? 'flex-start' : 'center',
            gap: '8px',
            padding: peek ? '0 14px' : '0',
            borderRadius: '999px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.22)',
            cursor: drag.current !== null && drag.current.moved ? 'grabbing' : 'pointer',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            zIndex: 20,
            // Only width animates: a padding/left transition makes the button
            // walk under the pointer, which is what made it look possessed.
            transition: 'width 160ms cubic-bezier(0.2, 0.8, 0.2, 1)',
            touchAction: 'none',
            userSelect: 'none',
          },
        },
        h('span', { style: { display: 'flex', flex: 'none', color: 'var(--dsw-alias-brand-primary, #1f6feb)' } }, h(UartIcon, { size: 22 })),
        measurer,
        // `display:none` (not opacity:0) while collapsed: a still-laid-out label
        // is wider than the 44px orb, and centred overflow pushed the logo out
        // of the clipped box —that is why the orb looked empty.
        h(
          'span',
          {
            style: {
              display: peek ? 'flex' : 'none',
              alignItems: 'center',
              gap: '6px',
              marginLeft: '2px',
              pointerEvents: 'none',
            },
          },
          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, label),
          h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '›'),
        ),
      )
    }

    function FloatingWindow({ locale }) {
      const zhLocale = String(locale).toLowerCase().startsWith('zh')
      const [rect, setRect] = useState(loadRect)
      const drag = useRef(null)
      const boxRef = useRef(null)

      const clamp = useCallback((next) => {
        const w = Math.min(Math.max(next.w, 420), window.innerWidth - 16)
        const ht = Math.min(Math.max(next.h, 260), window.innerHeight - 16)
        return {
          w,
          h: ht,
          x: Math.min(Math.max(next.x, 8), window.innerWidth - w - 8),
          // Never above the host chrome: the title bar (and its ✕ must stay
          // reachable even if the window is dragged to the very top.
          y: Math.min(Math.max(next.y, TOP_SAFE), Math.max(TOP_SAFE, window.innerHeight - Math.min(ht, 96))),
        }
      }, [])

      const onPointerDown = useCallback(
        (event) => {
          if (event.button !== 0) return
          if (event.target instanceof Element && event.target.closest('button') !== null) return
          event.preventDefault()
          const start = { x: event.clientX, y: event.clientY, rect }
          drag.current = start
          const move = (moveEvent) => {
            const base = drag.current
            if (!base) return
            setRect(clamp({ ...base.rect, x: base.rect.x + (moveEvent.clientX - base.x), y: base.rect.y + (moveEvent.clientY - base.y) }))
          }
          const up = () => {
            drag.current = null
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            setRect((current) => {
              writeStorage(RECT_KEY, JSON.stringify(current))
              return current
            })
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        },
        [clamp, rect],
      )

      // Persist a resize made with the native handle.
      useEffect(() => {
        const node = boxRef.current
        if (node === null || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver(() => {
          const next = { x: node.offsetLeft, y: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight }
          writeStorage(RECT_KEY, JSON.stringify(next))
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      // Shrinking the host window must not leave the console half off-screen.
      useEffect(() => {
        const onResize = () => setRect((current) => clamp(current))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [clamp])

      const dock = () => setMode('panel')
      const collapse = () => setFloatState('bubble')

      return h(
        'div',
        {
          ref: boxRef,
          style: {
            position: 'fixed',
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.w}px`,
            height: `${rect.h}px`,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-primary)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '12px',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.28)',
            overflow: 'hidden',
            zIndex: 19,
            resize: 'both',
            minWidth: '380px',
            minHeight: '240px',
          },
        },
        h(
          'div',
          {
            onPointerDown,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              height: '40px',
              flex: 'none',
              padding: '0 10px 0 12px',
              cursor: 'grab',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-2)',
              userSelect: 'none',
            },
          },
          h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--dsw-alias-brand-primary)' } }),
          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, zhLocale ? '串口调试' : 'Serial console'),
          h('span', { style: { flex: '1 1 auto' } }),
          h(LinkButton, { onClick: dock, title: zhLocale ? '停靠到工作区' : 'Dock to panel' }, zhLocale ? '停靠' : 'Dock'),
          h(LinkButton, { onClick: collapse, title: zhLocale ? '收起为右下角圆球' : 'Collapse to the orb' }, '×'),
        ),
        h('div', { style: { flex: '1 1 auto', minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' } }, h(ConsoleMount, { locale, actions: NO_ACTIONS, dense: true })),
      )
    }

    // ── panel carrier ──────────────────────────────────────────────────────
    function PanelHost({ locale }) {
      const zhLocale = String(locale).toLowerCase().startsWith('zh')
      const [mode, setModeNow] = useMode()
      const actions = useRef(null)
      if (actions.current === null) {
        actions.current = [
          domAction(zhLocale ? '悬浮窗' : 'Float', zhLocale ? '在悬浮窗中打开' : 'Open in a floating window', () => setMode('float')),
        ]
      }

      if (mode === 'float') {
        return h(
          'div',
          { style: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' } },
          h(
            'div',
            { style: { maxWidth: '420px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '8px' } },
            h(
              'div',
              { style: { fontSize: '13px', fontWeight: 600 } },
              zhLocale ? '控制台已收起为右下角圆球' : 'The console is collapsed into the orb at the bottom right',
            ),
            h(
              'div',
              { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
              zhLocale ? '点右下角圆球展开控制台；也可以直接停靠回这里。' : 'Click the orb at the bottom right to open it, or dock it back here.',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => setModeNow('panel'),
                style: {
                  alignSelf: 'center',
                  marginTop: '4px',
                  height: '28px',
                  padding: '0 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: '12px',
                  cursor: 'pointer',
                },
              },
              zhLocale ? '停靠到工作区' : 'Dock to panel',
            ),
          ),
        )
      }

      return h(ConsoleMount, { locale, actions: actions.current })
    }

    function FloatSlot({ locale }) {
      const [mode] = useMode()
      const [shape] = useFloatState()
      if (mode !== 'float') return null
      return shape === 'window' ? h(FloatingWindow, { locale }) : h(BubbleOrb, { locale })
    }

    // ── dock under the composer ────────────────────────────────────────────
    /**
     * Decode preference for the dock preview.
     *
     * The Hub already decodes with the connection's encoding, but the preview
     * must show what *you* want to read: text, raw HEX, or auto (text when it
     * looks printable). Encoding is applied client-side from the raw bytes, so
     * switching to GBK here needs no reconnect.
     */
    const decodePref = {
      format: readStorage(DECODE_KEY, 'auto'),
      encoding: readStorage(DECODE_ENCODING_KEY, 'utf8'),
      listeners: new Set(),
    }
    function setDecodePref(patch) {
      Object.assign(decodePref, patch)
      writeStorage(DECODE_KEY, decodePref.format)
      writeStorage(DECODE_ENCODING_KEY, decodePref.encoding)
      for (const listener of [...decodePref.listeners]) listener()
    }
    function useDecodePref() {
      const [, bump] = useState(0)
      useEffect(() => {
        const listener = () => bump((value) => value + 1)
        decodePref.listeners.add(listener)
        return () => decodePref.listeners.delete(listener)
      }, [])
      return decodePref
    }

    function bytesOfHex(hex) {
      const out = []
      for (let i = 0; i + 1 < hex.length; i += 2) {
        const value = Number.parseInt(hex.slice(i, i + 2), 16)
        if (!Number.isNaN(value)) out.push(value)
      }
      return Uint8Array.from(out)
    }

    function decodeFrameText(frame, pref) {
      const raw = String(frame.raw ?? '')
      if (pref.format === 'hex') return raw.replace(/(..)/g, '$1 ').trim()
      let text = frame.data
      try {
        const decoder = new TextDecoder(pref.encoding === 'utf8' ? 'utf-8' : pref.encoding)
        text = decoder.decode(bytesOfHex(raw))
      } catch {
        /* keep the Hub's decoding */
      }
      if (pref.format === 'text') return text
      // auto: printable ratio decides, so binary frames show as HEX instead of dots
      const chars = [...text]
      const printable = chars.filter((c) => c >= ' ' && c !== '\uFFFD').length
      return chars.length > 0 && printable / chars.length >= 0.85 ? text : raw.replace(/(..)/g, '$1 ').trim()
    }

    /**
     * Status chip + expandable console in the composer dock.
     *
     * The chip is ALWAYS present (like the oscilloscope chip in the same row):
     * it answers "is the link alive" at a glance without owning screen space.
     * Clicking it opens a compact receive card; 灞曞紑 moves the console here.
     */
    function DockSlot({ locale, openPanel }) {
      const zhLocale = String(locale).toLowerCase().startsWith('zh')
      const [mode] = useMode()
      const [chipEnabled] = useDockChip()
      const [status, setStatus] = useState({ connected: false, label: '', rate: 0 })
      const [peek, setPeek] = useState(false)
      const [previewFrames, setPreviewFrames] = useState([])
      const decode = useDecodePref()
      const [ports, setPorts] = useState([])
      const [selectedPort, setSelectedPort] = useState('')
      const [baud, setBaud] = useState(115200)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const previewRef = useRef(null)
      const followPreview = useRef(true)
      const [follow] = useDockFollow()

      const applyStatus = (data) => {
        const active = data?.active ?? null
        setStatus({
          connected: Boolean(active),
          label: active ? `${active.config?.path ?? ''} · ${active.config?.baudRate ?? ''}` : zhLocale ? '未连接' : 'not connected',
          rate: 0,
        })
      }

      const loadPorts = async () => {
        try {
          const response = await fetch(apiPath(`${ROUTE}/api/ports`), { credentials: 'same-origin' })
          const data = await response.json()
          const list = Array.isArray(data?.ports) ? data.ports : []
          setPorts(list)
          setSelectedPort((current) => current || list[0]?.path || '')
        } catch {
          setPorts([])
        }
      }

      const connect = async () => {
        if (selectedPort === '') return
        setBusy(true)
        setError('')
        try {
          const response = await fetch(apiPath(`${ROUTE}/api/connect`), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: selectedPort, baudRate: baud, encoding: decodePref.encoding, protocol: 'line' }),
          })
          const data = await response.json()
          if (!data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
          const statusResponse = await fetch(apiPath(`${ROUTE}/api/status`), { credentials: 'same-origin' })
          applyStatus(await statusResponse.json())
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      const disconnect = async () => {
        setBusy(true)
        setError('')
        try {
          await fetch(apiPath(`${ROUTE}/api/disconnect`), { method: 'POST', credentials: 'same-origin' })
          setStatus({ connected: false, label: zhLocale ? '未连接' : 'not connected', rate: 0 })
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      // Port list only matters while the card shows the connect row.
      useEffect(() => {
        if (peek && !status.connected) loadPorts()
      }, [peek, status.connected])

      // Lightweight receive preview: only polled while the card is open.
      useEffect(() => {
        if (!peek) return undefined
        followPreview.current = true
        let stopped = false
        const load = async () => {
          try {
            const response = await fetch(apiPath(`${ROUTE}/api/frames?limit=12`), { credentials: 'same-origin' })
            const data = await response.json()
            if (!stopped) setPreviewFrames(Array.isArray(data?.frames) ? data.frames : [])
          } catch {
            if (!stopped) setPreviewFrames([])
          }
        }
        load()
        const timer = setInterval(load, 1500)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [peek])

      // Keep the newest frame in view. `followPreview` is the per-open "I am
      // reading older data right now" flag; `follow` is the user's setting.
      useEffect(() => {
        const node = previewRef.current
        if (node === null) return
        if (!follow || !followPreview.current) return
        node.scrollTop = node.scrollHeight
      }, [previewFrames, follow])

      useEffect(() => {
        if (!chipEnabled) return undefined
        let stopped = false
        let lastSeq = null
        let lastAt = Date.now()

        const tick = async () => {
          try {
            const response = await fetch(apiPath(`${ROUTE}/api/status`), { credentials: 'same-origin' })
            if (!response.ok) throw new Error(String(response.status))
            const data = await response.json()
            const active = data?.active ?? null
            const seq = Number(data?.seq ?? 0)
            const now = Date.now()
            const elapsed = Math.max(0.2, (now - lastAt) / 1000)
            const rate = lastSeq === null ? 0 : Math.max(0, Math.round((seq - lastSeq) / elapsed))
            lastSeq = seq
            lastAt = now
            if (stopped) return
            setStatus({
              connected: Boolean(active),
              label: active ? `${active.config?.path ?? ''} · ${active.config?.baudRate ?? ''}` : zhLocale ? '未连接' : 'not connected',
              rate,
            })
          } catch {
            if (!stopped) setStatus({ connected: false, label: zhLocale ? 'Hub 离线' : 'hub offline', rate: 0 })
          }
        }

        tick()
        const timer = setInterval(tick, 2000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [chipEnabled, zhLocale])

      if (!chipEnabled) return null

      // 灞曞紑 opens the console the same way the orb does —a floating window on
      // top of the app —instead of pushing the composer row down.
      const toggle = () => {
        setMode('float')
        setFloatState('window')
      }

      const goPanel = () => {
        setMode('panel')
        openPanel()
      }

      const dot = h('span', {
        style: {
          width: '5px',
          height: '5px',
          borderRadius: '50%',
          flex: 'none',
          background: status.connected ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
          opacity: status.connected ? 1 : 0.45,
        },
      })

      const preview = peek
        ? h(
            'div',
            {
              style: {
                position: 'absolute',
                right: '0',
                bottom: 'calc(100% + 6px)',
                width: '400px',
                maxWidth: 'calc(100vw - 32px)',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '12px',
                background: 'var(--dsw-alias-bg-layer-1)',
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
                overflow: 'hidden',
                zIndex: 5,
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
              h('span', { style: { display: 'flex', color: 'var(--dsw-alias-brand-primary)' } }, h(UartIcon, { size: 14 })),
              h('span', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, zhLocale ? '串口接收' : 'Serial receive'),
              h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, status.label),
              h('span', { style: { flex: '1 1 auto' } }),
              status.connected
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: disconnect,
                      disabled: busy,
                      style: { border: '0', background: 'transparent', padding: '0', cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' },
                    },
                    zhLocale ? '断开' : 'Disconnect',
                  )
                : h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, zhLocale ? '未连接' : 'Offline'),
            ),
            // Connect without opening the console: the chip is the one place the
            // link can be brought up when the panel is not on screen.
            status.connected
              ? null
              : h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                  h(
                    'select',
                    {
                      value: selectedPort,
                      onChange: (event) => setSelectedPort(event.target.value),
                      style: { flex: '1 1 auto', minWidth: 0, height: '26px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: '11.5px', padding: '0 6px' },
                    },
                    ports.length === 0 ? h('option', { value: '' }, zhLocale ? '没有可用串口' : 'No port') : null,
                    ...ports.map((port) => h('option', { value: port.path, key: port.path }, port.path)),
                  ),
                  h(
                    'select',
                    {
                      value: String(baud),
                      onChange: (event) => setBaud(Number(event.target.value)),
                      style: { height: '26px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: '11.5px', padding: '0 4px' },
                    },
                    ...[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((value) => h('option', { value: String(value), key: String(value) }, String(value))),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: connect,
                      disabled: busy || ports.length === 0,
                      style: {
                        flex: 'none',
                        height: '26px',
                        padding: '0 12px',
                        borderRadius: '6px',
                        border: '0',
                        background: 'var(--dsw-alias-brand-primary)',
                        color: '#fff',
                        fontSize: '11.5px',
                        cursor: ports.length === 0 || busy ? 'default' : 'pointer',
                        opacity: ports.length === 0 || busy ? 0.55 : 1,
                      },
                    },
                    busy ? (zhLocale ? '连接中…' : 'Connecting…') : zhLocale ? '连接' : 'Connect',
                  ),
                ),
            error
              ? h('div', { style: { padding: '6px 12px', fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)', borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, error)
              : null,
            h(
              'div',
              {
                ref: previewRef,
                // Follow the newest frame unless the reader scrolled up to look
                // at something older; scrolling back to the bottom resumes it.
                onScroll: (event) => {
                  const node = event.currentTarget
                  followPreview.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
                },
                style: { maxHeight: '220px', overflowY: 'auto', padding: '6px 0' },
              },
              previewFrames.length === 0
                ? h('div', { style: { padding: '14px 12px', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' } }, zhLocale ? '还没有接收数据' : 'No data yet')
                : previewFrames.map((frame, index) =>
                    h(
                      'div',
                      { key: `${frame.seq ?? index}`, style: { display: 'flex', gap: '8px', padding: '2px 12px', fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' } },
                      h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } }, timeOf(frame.timestamp)),
                      h('span', { style: { flex: 'none', color: frame.direction === 'tx' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-success-primary)' } }, frame.direction === 'tx' ? 'TX' : 'RX'),
                      h('span', { style: { minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)' } }, decodeFrameText(frame, decodePref)),
                    ),
                  ),
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)', fontSize: '11px' } },
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, zhLocale ? '解码' : 'Decode'),
              ...['auto', 'text', 'hex'].map((value) =>
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setDecodePref({ format: value }),
                    style: {
                      border: '0',
                      background: 'transparent',
                      padding: '0',
                      cursor: 'pointer',
                      fontSize: '11px',
                      color: decodePref.format === value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
                      fontWeight: decodePref.format === value ? 600 : 400,
                    },
                  },
                  value === 'auto' ? (zhLocale ? '自动' : 'Auto') : value === 'text' ? (zhLocale ? '文本' : 'Text') : 'HEX',
                ),
              ),
              h('span', { style: { flex: '1 1 auto' } }),
              h(
                'button',
                { type: 'button', onClick: goPanel, style: { border: '0', background: 'transparent', padding: '0', cursor: 'pointer', fontSize: '11px', color: 'var(--dsw-alias-brand-primary)' } },
                zhLocale ? '打开面板' : 'Open panel',
              ),
            ),
          )
        : null

      return h(
        'div',
        { style: { position: 'relative', marginTop: '2px', minWidth: 0 } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              minHeight: '20px',
              padding: '0 6px',
              borderRadius: '6px',
              background: peek ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '11px',
              lineHeight: '18px',
            },
          },
          // The serial mark, not a bare dot: the row must read as "serial" at a
          // glance, the same way the oscilloscope chip carries its own glyph.
          h('span', { style: { display: 'flex', flex: 'none', color: 'var(--dsw-alias-brand-primary)' } }, h(UartIcon, { size: 12 })),
          dot,
          h(
            'button',
            {
              type: 'button',
              onClick: () => setPeek((value) => !value),
              title: zhLocale ? '查看最近的接收数据' : 'Recent received data',
              style: { border: '0', background: 'transparent', padding: '0', cursor: 'pointer', color: 'inherit', fontSize: '11px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
            },
            status.label,
          ),
          status.connected && status.rate > 0 ? h('span', { style: { whiteSpace: 'nowrap', opacity: 0.75 } }, `${status.rate}/s`) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            LinkButton,
            { onClick: toggle, title: zhLocale ? '以悬浮窗打开控制台' : 'Open the console as a floating window' },
            zhLocale ? '展开' : 'Expand',
          ),
          h(LinkButton, { onClick: goPanel, title: zhLocale ? '打开工作区面板' : 'Open the workspace panel' }, zhLocale ? '面板' : 'Panel'),
        ),
        preview,
      )
    }

    function timeOf(timestamp) {
      const text = String(timestamp ?? '')
      const match = text.match(/T(\d{2}:\d{2}:\d{2})\.?(\d{0,3})/)
      return match ? `${match[1]}.${(match[2] || '000').padEnd(3, '0').slice(0, 3)}` : text.slice(11, 23)
    }

    // ── settings section ───────────────────────────────────────────────────
    /** One placement choice; radio semantics carried by aria-pressed. */
    function PlacementCard({ active, title, body, badge, onSelect }) {
      return h(
        'button',
        {
          type: 'button',
          // Stable marker: the settings page also contains aria-pressed buttons
          // (the decode format row), so tests and tooling need a way to tell
          // the placement cards apart.
          'data-uart-placement': 'true',
          'aria-pressed': active ? 'true' : 'false',
          onClick: onSelect,
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: '4px',
            padding: '10px 12px',
            textAlign: 'left',
            font: 'inherit',
            cursor: 'pointer',
            borderRadius: '10px',
            border: active ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l1)',
            background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        h(
          'span',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600 } },
          h('span', {
            style: {
              width: '10px',
              height: '10px',
              flex: 'none',
              borderRadius: '50%',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: active ? 'var(--dsw-alias-brand-primary)' : 'transparent',
            },
          }),
          title,
          badge === undefined
            ? null
            : h(
                'span',
                {
                  style: {
                    fontSize: '10px',
                    fontWeight: 500,
                    padding: '1px 6px',
                    borderRadius: '999px',
                    color: 'var(--dsw-alias-label-secondary)',
                    background: 'var(--dsw-alias-bg-layer-2)',
                  },
                },
                badge,
              ),
        ),
        h('span', { style: { fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-label-secondary)' } }, body),
      )
    }

    /** Preference row: title + description on the left, pill switch on the right. */
    function ToggleRow({ title, description, checked, onChange }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            padding: '10px 0',
            borderTop: '1px solid var(--dsw-alias-border-l1)',
          },
        },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 auto', minWidth: 0 } },
          h('span', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, title),
          h('span', { style: { fontSize: '11.5px', lineHeight: '1.5', color: 'var(--dsw-alias-label-secondary)' } }, description),
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            onClick: () => onChange(!checked),
            style: {
              flex: 'none',
              width: '36px',
              height: '20px',
              padding: '2px',
              borderRadius: '999px',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: checked ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-2)',
              cursor: 'pointer',
              transition: 'background 120ms ease',
            },
          },
          h('span', {
            style: {
              display: 'block',
              width: '14px',
              height: '14px',
              borderRadius: '50%',
              background: checked ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-label-secondary)',
              transform: `translateX(${checked ? '16px' : '0'})`,
              transition: 'transform 120ms ease',
            },
          }),
        ),
      )
    }

    function UartSettingsSection({ locale, t: tr }) {
      const [mode] = useMode()
      const [chip, setChip] = useDockChip()
      const [follow, setFollow] = useDockFollow()
      const [agent, setAgent] = useAgentTool()
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '2px' } },
        h('div', { style: { fontSize: '14px', fontWeight: 600 } }, tr('settingsTitle')),
        h(
          'div',
          { style: { fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)' } },
          tr('settingsBody'),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          h(PlacementCard, {
            active: mode === 'panel',
            title: tr('optionPanel'),
            body: tr('optionPanelBody'),
            badge: mode === 'panel' ? tr('optionCurrent') : undefined,
            onSelect: () => setMode('panel'),
          }),
          h(PlacementCard, {
            active: mode === 'float',
            title: tr('optionFloat'),
            body: tr('optionFloatBody'),
            badge: mode === 'float' ? tr('optionCurrent') : undefined,
            onSelect: () => setMode('float'),
          }),
        ),
        h(ToggleRow, {
          title: tr('optionAgentTool'),
          description: tr('optionAgentToolBody'),
          checked: agent,
          onChange: setAgent,
        }),
        h(ToggleRow, {
          title: tr('optionDockChip'),
          description: tr('optionDockChipBody'),
          checked: chip,
          onChange: setChip,
        }),
        h(ToggleRow, {
          title: tr('optionDockFollow'),
          description: tr('optionDockFollowBody'),
          checked: follow,
          onChange: setFollow,
        }),
        h(DecodeRow, { tr }),
      )
    }

    /** Agent-tool switch: server-owned preference, so Host and settings agree. */
    function useAgentTool() {
      const [enabled, setEnabled] = useState(true)
      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const response = await fetch(apiPath(`${ROUTE}/agent`), { credentials: 'same-origin' })
            const data = await response.json()
            if (!cancelled && typeof data?.enabled === 'boolean') setEnabled(data.enabled)
          } catch {
            /* keep the default until the host answers */
          }
        })()
        return () => { cancelled = true }
      }, [])
      const update = useCallback(async (next) => {
        setEnabled(next)
        try {
          const response = await fetch(apiPath(`${ROUTE}/agent`), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          })
          const data = await response.json()
          if (typeof data?.enabled === 'boolean') setEnabled(data.enabled)
        } catch {
          setEnabled(!next)
        }
      }, [])
      return [enabled, update]
    }

    /** Decode preference: how received bytes are shown, and in which encoding. */
    function DecodeRow({ tr }) {
      const decode = useDecodePref()
      const formats = [
        { value: 'auto', label: tr('decodeAuto') },
        { value: 'text', label: tr('decodeText') },
        { value: 'hex', label: tr('decodeHex') },
      ]
      const encodings = ['utf8', 'gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'latin1']
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('span', { style: { fontSize: '12.5px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, tr('decodeTitle')),
          h('span', { style: { fontSize: '11.5px', lineHeight: '1.5', color: 'var(--dsw-alias-label-secondary)' } }, tr('decodeBody')),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
          ...formats.map((item) =>
            h(
              'button',
              {
                type: 'button',
                key: item.value,
                'aria-pressed': decode.format === item.value ? 'true' : 'false',
                onClick: () => setDecodePref({ format: item.value }),
                style: {
                  height: '24px',
                  padding: '0 10px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '11.5px',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: decode.format === item.value ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  color: decode.format === item.value ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                  fontWeight: decode.format === item.value ? 600 : 400,
                },
              },
              item.label,
            ),
          ),
          h('span', { style: { width: '8px' } }),
          h(
            'select',
            {
              value: decode.encoding,
              onChange: (event) => setDecodePref({ encoding: event.target.value }),
              style: {
                height: '24px',
                borderRadius: '6px',
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '11.5px',
                padding: '0 6px',
              },
            },
            ...encodings.map((value) => h('option', { value, key: value }, value)),
          ),
        ),
      )
    }

    /**
     * The one serial mark, used by the sidebar row, the orb and its capsule.
     * Keeping a single component is deliberate: two different marks in the same
     * product read as two different features.
     */
    function UartIcon({ size = 16 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', { x: 1.2, y: 2.2, width: 13.6, height: 11.6, rx: 2.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, opacity: 0.55 }),
        h('path', { d: 'M3.2 10.4h2.1V6.2h2.3v4.2h2.2V6.2h2.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
        const t = ctx.locale.bind(NS)
        const localeId = () => {
          try {
            const snapshot = ctx.locale.getLocale()
            return String(snapshot?.id ?? snapshot?.locale ?? 'zh')
          } catch {
            return 'zh'
          }
        }

        /**
         * Ask the host to actually show our panel.
         *
         * Changing the plugin's own placement state only decides what the
         * sidebar entry renders later; it does not move the UI. `layout.selectPanel`
         * is the navigation call that does.
         */
        const openPanel = () => {
          try {
            const layout = ctx.get('layout')
            layout?.selectPanel?.('uart')
          } catch {
            /* host without the layout service: nothing to navigate */
          }
        }
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 34, label: () => t('nav'), locale: NS },
            (owner = {}) => h(UartIcon, { size: owner.size ?? 16 }),
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ locale: localeId() }) },
            PanelHost,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: FLOAT_ID, order: 40, locale: NS, inject: () => ({ locale: localeId() }) },
            FloatSlot,
          ),
        )
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: DOCK_ID, order: 20, locale: NS, inject: () => ({ locale: localeId(), openPanel }) },
            DockSlot,
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'uart-console', order: 55, label: () => t('nav'), locale: NS, inject: () => ({ locale: localeId(), t }) },
            UartSettingsSection,
          ),
        )
        // Same settings surface on the plugin own page (Settings -> Plugins -> UART),
        // so the switches are reachable from where the plugin is installed.
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            { name: 'settings.plugins.tab', id: 'uart-settings', order: 40, label: () => t('nav'), locale: NS, inject: () => ({ locale: localeId(), t }) },
            UartSettingsSection,
          ),
        )
      },
    }
  },
})
