/**
 * UART console UI — the one front end.
 *
 * Loaded unchanged by both carriers:
 *   • the standalone Hub page  (src/hub/public/index.html → app.js → this file)
 *   • the DSH panel            (scripts/build-dsh-client.mjs inlines this file
 *                               into dsh-plugin/client.js, which mounts it)
 *
 * No framework, no build step, no bundler: one ESM module that builds its own
 * DOM. Colours come from DSH theme tokens when they exist and fall back to a
 * light/dark palette of the same shape when they do not, so the two carriers
 * differ only by the palette their host provides.
 *
 *   import { createUartUi } from './uart-ui.js'
 *   const ui = createUartUi({ root: element, apiBase: './', locale: 'zh' })
 *   ui.destroy()
 */
export function createUartUi({ root, apiBase = './', locale = 'zh', externalUrl = null, actions = [], dense = false } = {}) {
  if (!root) throw new Error('createUartUi needs a root element')

  const dict = String(locale).toLowerCase().startsWith('zh') ? ZH : EN
  const t = (key, params) => {
    const template = dict[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (_, name) => (params[name] === undefined ? '' : String(params[name])))
  }

  // Keep the query string: the SSE replay uses ?sinceSeq= to bound the backlog.
  const apiUrl = (path) => {
    const url = new URL(`${apiBase}${String(path).replace(/^\/+/, '')}`, document.baseURI)
    return url.pathname + url.search
  }

  // ── state ────────────────────────────────────────────────────────────────
  const state = {
    ports: [],
    connected: false,
    connectionId: null,
    ownsPort: false,
    hub: 'unknown',
    frames: [],
    filter: { dir: 'all', hex: '', text: '' },
    showAscii: true,
    showHex: true,
    follow: true,
    railWidth: 248,
    asciiWidth: 210,
    sendText: '',
    lineEnding: '\r\n',
    signals: { dtr: true, rts: true },
    busy: false,
    stream: null,
    lastSeq: 0,
    visibleCount: 0,
    /** Frames per second for the last 60 s, oldest first (telemetry strip). */
    rate: new Array(60).fill(0),
    rxTotal: 0,
    txTotal: 0,
    timer: null,
    tab: 'monitor',
    history: { frames: [], total: 0, text: '', hex: '', loaded: false, timer: 0 },
    dut: {
      available: false,
      profiles: [],
      profile: '',
      status: null,
      active: null,
      includeLowPower: false,
      running: false,
      connecting: false,
      steps: [],
      summary: null,
      total: 0,
      expanded: new Set(),
      query: '',
      timer: null,
    },
  }

  const refs = {}

  // ── helpers ──────────────────────────────────────────────────────────────
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
      else if (key === 'value') node.value = value
      else if (key === 'checked' || key === 'disabled' || key === 'selected') node[key] = Boolean(value)
      else node.setAttribute(key, String(value))
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  const fmtTime = (iso) => {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return String(iso ?? '')
    const pad = (value, width = 2) => String(value).padStart(width, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  }
  const prettyHex = (raw) => String(raw ?? '').toUpperCase().replace(/(.{2})/g, '$1 ').trim()
  /**
   * Printable form of the DECODED text.
   *
   * This used to keep only 0x20-0x7E and dot everything else, which silently
   * destroyed every non-ASCII payload: a GBK/UTF-8 frame decoded to 中文 was
   * shown as "..". Keep any character the terminal can render (CJK, accented
   * letters, symbols) and only substitute real control characters.
   */
  const asciiOf = (text) => {
    let out = ''
    for (const character of String(text ?? '')) {
      const code = character.codePointAt(0)
      // C0/C1 controls, DEL, and the replacement char become dots.
      const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd
      out += control ? '.' : character
    }
    return out
  }
  const errorText = (error) => (error instanceof Error ? error.message : String(error))

  /** Clipboard write with a fallback for non-secure contexts / denied API. */
  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const area = document.createElement('textarea')
        area.value = text
        area.style.cssText = 'position:fixed;left:-9999px;top:0'
        document.body.append(area)
        area.select()
        document.execCommand('copy')
        area.remove()
      }
      notify({ tone: 'ok', text: t('copied', { count: text.length }) })
    } catch (error) {
      notify({ tone: 'error', text: t('copyFailed', { reason: errorText(error) }) })
    }
  }

  /**
   * Bytes → displayable text for the ASCII column.
   *
   * `frame.data` is already decoded by the backend using the connection's
   * encoding — but a connection opened with `encoding: "hex"` (the DUT profile
   * path does exactly that) hands back a HEX STRING, not text. Rendering that
   * verbatim printed hex twice and hid the actual message.
   *
   * So: when `data` is the same hex string as `raw`, decode `raw` to UTF-8 for
   * display. The HEX column keeps showing the true bytes.
   */
  const textOf = (frame) => {
    const data = String(frame?.data ?? '')
    const raw = String(frame?.raw ?? '')
    const looksHex = data.length > 0 && /^[0-9A-Fa-f]+$/.test(data) && data.length === raw.length
    if (!looksHex || raw.length % 2 !== 0) return asciiOf(data)
    try {
      const bytes = new Uint8Array(raw.length / 2)
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16)
      return asciiOf(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
    } catch {
      return asciiOf(data)
    }
  }

  async function readJson(path) {
    const response = await fetch(apiUrl(path), { headers: { accept: 'application/json' }, credentials: 'same-origin' })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
    return payload
  }

  async function postJson(path, body) {
    const response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
      credentials: 'same-origin',
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) throw new Error(payload?.error ?? `HTTP ${response.status}`)
    return payload
  }

  // ── styles ───────────────────────────────────────────────────────────────
  const STYLE_ID = 'uart-ui-style'
  function ensureStyle() {
    const existing = document.getElementById(STYLE_ID)
    if (existing) return existing
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.append(style)
    return style
  }

  // ── skeleton ─────────────────────────────────────────────────────────────
  ensureStyle()
  root.classList.add('uart-root')
  if (dense) root.classList.add('is-embedded')
  root.textContent = ''

  refs.chip = el('span', { class: 'uart-chip' }, el('span', { class: 'uart-dot' }), el('span', { text: '…' }))
  refs.session = el('span', { class: 'uart-chip', style: { display: 'none' } })

  // tabs -------------------------------------------------------------------
  refs.tabMonitor = el('button', { class: 'uart-tab is-active', type: 'button', text: t('tabMonitor'), onclick: () => setTab('monitor') })
  refs.tabDut = el('button', { class: 'uart-tab', type: 'button', text: t('tabDut'), onclick: () => setTab('dut') })
  refs.tabHistory = el('button', { class: 'uart-tab', type: 'button', text: t('tabHistory'), onclick: () => setTab('history') })
  refs.tabs = el('div', { class: 'uart-tabs' }, refs.tabMonitor, refs.tabDut, refs.tabHistory)

  const header = el(
    'div',
    { class: 'uart-header' },
    el(
      'div',
      { class: 'uart-heading' },
      el('h1', { class: 'uart-title', text: t('title') }),
      el('p', { class: 'uart-intro', text: t('intro') }),
    ),
    refs.tabs,
    el(
      'div',
      { class: 'uart-head-actions' },
      refs.chip,
      refs.session,
      el('a', {
        class: 'uart-link',
        href: externalUrl ?? apiUrl(''),
        target: '_blank',
        rel: 'noreferrer',
        text: t('openInBrowser'),
      }),
      el('button', { class: 'uart-link', type: 'button', text: t('refresh'), onclick: () => { loadPorts(); attachIfNeeded(true) } }),
      ...(Array.isArray(actions) ? actions : []),
    ),
  )

  refs.banner = el('div', { class: 'uart-banner', style: { display: 'none' } })
  /** Persistent ownership strip: the Agent holds the port, so inputs are locked. */
  refs.owner = el('div', { class: 'uart-banner is-agent', style: { display: 'none' } })

  // rail --------------------------------------------------------------------
  refs.port = el('input', {
    class: 'uart-input',
    id: 'uart-path',
    list: 'uart-port-list',
    placeholder: t('portPlaceholder'),
    'aria-label': t('sectionPort'),
    oninput: (event) => { state.port = event.target.value; sync() },
  })
  refs.portList = el('datalist', { id: 'uart-port-list' })
  refs.baud = el('select', { class: 'uart-select', id: 'uart-baud', onchange: (event) => { state.baud = event.target.value } })
  for (const rate of [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]) {
    refs.baud.append(el('option', { value: String(rate), text: String(rate) }))
  }
  refs.encoding = el('select', {
    class: 'uart-select',
    id: 'uart-encoding',
    onchange: (event) => {
      state.encoding = event.target.value
      applyEncoding()
    },
  })
  for (const encoding of ['utf8', 'ascii', 'latin1', 'gbk', 'hex', 'base64']) {
    refs.encoding.append(el('option', { value: encoding, text: encoding }))
  }
  refs.dataBits = el('select', { class: 'uart-select', id: 'uart-data-bits' })
  for (const bits of [8, 7, 6, 5]) refs.dataBits.append(el('option', { value: String(bits), text: String(bits) }))
  refs.parity = el('select', { class: 'uart-select', id: 'uart-parity' })
  for (const parity of ['none', 'even', 'odd', 'mark', 'space']) refs.parity.append(el('option', { value: parity, text: parity }))
  refs.stopBits = el('select', { class: 'uart-select', id: 'uart-stop-bits' })
  for (const bits of [1, 2]) refs.stopBits.append(el('option', { value: String(bits), text: String(bits) }))
  refs.protocol = el('select', {
    class: 'uart-select',
    id: 'uart-protocol',
    title: t('protocolHint'),
    onchange: (event) => {
      state.protocol = event.target.value
      applyProtocol()
    },
  })
  for (const protocol of ['line', 'raw', 'delimiter', 'modbus-rtu', 'hex-frame', 'slip']) {
    refs.protocol.append(el('option', { value: protocol, text: protocol }))
  }

  refs.connect = el('button', { class: 'uart-button is-primary is-block', type: 'button', text: t('connect'), onclick: connect })
  refs.stop = el('button', { class: 'uart-button is-block', type: 'button', text: t('stopMonitor'), onclick: stopMonitoring, style: { display: 'none' } })
  refs.close = el('button', { class: 'uart-button is-danger is-block', type: 'button', text: t('closePort'), style: { display: 'none' }, onclick: closePort })

  refs.dtr = el('div', { class: 'uart-seg' })
  refs.dtrBtns = [false, true].map((value) =>
    el('button', {
      class: 'uart-seg-button',
      type: 'button',
      text: value ? '1' : '0',
      onclick: () => setSignal({ dtr: value }),
    }),
  )
  refs.dtr.append(...refs.dtrBtns)
  refs.rts = el('div', { class: 'uart-seg' })
  refs.rtsBtns = [false, true].map((value) =>
    el('button', {
      class: 'uart-seg-button',
      type: 'button',
      text: value ? '1' : '0',
      onclick: () => setSignal({ rts: value }),
    }),
  )
  refs.rts.append(...refs.rtsBtns)
  refs.break = el('button', {
    class: 'uart-button is-block',
    type: 'button',
    text: t('breakPulse'),
    onclick: async () => {
      await setSignal({ break: true })
      setTimeout(() => setSignal({ break: false }), 60)
    },
  })

  const rail = el(
    'div',
    { class: 'uart-card uart-rail' },
    el(
      'div',
      { class: 'uart-group uart-port-group' },
      el('p', { class: 'uart-group-title', text: t('sectionPort') }),
      el('div', { class: 'uart-field uart-port-field' }, refs.port, refs.portList),
      // Baud and encoding side by side: two short values stacked wasted a third
      // of the rail's height for nothing.
      el(
        'div',
        { class: 'uart-row2' },
        el('div', { class: 'uart-field' }, el('label', { class: 'uart-label', for: 'uart-baud', text: t('baud') }), refs.baud),
        el('div', { class: 'uart-field' }, el('label', { class: 'uart-label', for: 'uart-encoding', text: t('encoding') }), refs.encoding),
      ),
      el(
        'details',
        { class: 'uart-advanced' },
        el('summary', { class: 'uart-summary', text: t('advanced') }),
        el(
          'div',
          { class: 'uart-row2', style: { marginTop: '8px' } },
          el('div', { class: 'uart-field' }, el('label', { class: 'uart-label', for: 'uart-data-bits', text: t('dataBits') }), refs.dataBits),
          el('div', { class: 'uart-field' }, el('label', { class: 'uart-label', for: 'uart-parity', text: t('parity') }), refs.parity),
          el('div', { class: 'uart-field' }, el('label', { class: 'uart-label', for: 'uart-stop-bits', text: t('stopBits') }), refs.stopBits),
          el('div', { class: 'uart-field' }, el('label', { class: 'uart-label', for: 'uart-protocol', text: t('protocol') }), refs.protocol),
        ),
      ),
      refs.connect,
      refs.stop,
      refs.close,
    ),
    el(
      'div',
      { class: 'uart-group uart-signal-group' },
      el('p', { class: 'uart-group-title', text: t('sectionSignal') }),
      el('div', { class: 'uart-signal-row' }, el('span', { class: 'uart-signal-name', text: t('dtr') }), refs.dtr),
      el('div', { class: 'uart-signal-row' }, el('span', { class: 'uart-signal-name', text: t('rts') }), refs.rts),
      refs.break,
    ),
  )

  // tape --------------------------------------------------------------------
  refs.dir = el('select', { class: 'uart-select', 'aria-label': t('filterAll'), onchange: (event) => { state.filter.dir = event.target.value; renderTape() } })
  refs.dir.append(
    el('option', { value: 'all', text: t('filterAll') }),
    el('option', { value: 'rx', text: t('filterRx') }),
    el('option', { value: 'tx', text: t('filterTx') }),
  )
  refs.filterHex = el('input', {
    class: 'uart-input',
    placeholder: t('filterHex'),
    oninput: (event) => { state.filter.hex = event.target.value; renderTape() },
  })
  refs.filterText = el('input', {
    class: 'uart-input',
    placeholder: t('filterText'),
    oninput: (event) => { state.filter.text = event.target.value; renderTape() },
  })
  refs.ascii = el('input', {
    type: 'checkbox',
    checked: true,
    onchange: (event) => { state.showAscii = event.target.checked; renderTape(); savePrefs() },
  })
  refs.hexToggle = el('button', {
    class: 'uart-hex-toggle',
    type: 'button',
    text: t('hex'),
    title: t('toggleHex'),
    onclick: () => { state.showHex = !state.showHex; syncHexToggle(); renderTape(); savePrefs() },
  })
  refs.follow = el('input', {
    type: 'checkbox',
    checked: true,
    onchange: (event) => { state.follow = event.target.checked },
  })
  refs.count = el('span', { class: 'uart-count', text: t('frameCount', { count: 0 }) })
  refs.copyAll = el('button', {
    class: 'uart-button',
    type: 'button',
    text: t('copyAll'),
    title: t('copyAllHint'),
    onclick: () => {
      const visible = state.frames.filter(passes)
      if (visible.length === 0) return
      copyText(visible.map((frame) => textOf(frame)).join('\n'))
    },
  })
  refs.clear = el('button', {
    class: 'uart-button',
    type: 'button',
    text: t('clear'),
    onclick: () => {
      state.frames = []
      state.lastSeq = 0
      state.rate.fill(0)
      state.rxTotal = 0
      state.txTotal = 0
      renderTape()
      renderTelemetry()
    },
  })

  refs.spark = el('svg', {
    class: 'uart-spark',
    viewBox: '0 0 120 24',
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  })
  refs.rateLabel = el('span', { class: 'uart-rate', text: '0/s' })
  // Direction totals, as text. A full-width RX bar used to sit here and read
  // like a progress bar ("is it 100% done?"), when it only meant "no TX yet".
  refs.rxCount = el('span', { class: 'uart-tally is-rx', text: t('tallyRx', { count: 0 }) })
  refs.txCount = el('span', { class: 'uart-tally is-tx', text: t('tallyTx', { count: 0 }) })
  refs.tally = el('span', { class: 'uart-tally-group' }, refs.rxCount, refs.txCount)

  const tapeHead = el(
    'div',
    { class: 'uart-tape-head' },
    el(
      'div',
      { class: 'uart-tape-row' },
      refs.dir,
      refs.filterHex,
      refs.filterText,
      el('span', { class: 'uart-spacer' }),
      refs.count,
      refs.copyAll,
      refs.clear,
    ),
    el(
      'div',
      { class: 'uart-tape-row uart-tape-meta' },
      refs.spark,
      refs.rateLabel,
      refs.tally,
      el('span', { class: 'uart-spacer' }),
      refs.hexToggle,
      el('label', { class: 'uart-toggle' }, refs.ascii, t('ascii')),
      el('label', { class: 'uart-toggle' }, refs.follow, t('follow')),
    ),
  )

  refs.tape = el('div', { class: 'uart-tape' })
  const tapeCard = el('div', { class: 'uart-card uart-tape-card' }, tapeHead, refs.tape)

  // composer ----------------------------------------------------------------
  refs.sendText = el('textarea', {
    class: 'uart-textarea',
    placeholder: t('sendPlaceholder'),
    oninput: (event) => { state.sendText = event.target.value; syncSend() },
    onkeydown: (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        send()
      }
    },
  })
  refs.lineEnding = el('select', { class: 'uart-select', id: 'uart-line-ending', style: { width: '80px' }, onchange: (event) => { state.lineEnding = event.target.value; syncSend() } })
  refs.lineEnding.append(el('option', { value: '\r\n', text: 'CRLF' }), el('option', { value: '\n', text: 'LF' }), el('option', { value: '', text: t('none') }))
  refs.send = el('button', { class: 'uart-button is-primary', type: 'button', text: t('send'), onclick: send, style: { width: '100%' } })

  const composer = el(
    'div',
    { class: 'uart-card uart-send-card' },
    el(
      'div',
      { class: 'uart-composer' },
      refs.sendText,
      el(
        'div',
        { class: 'uart-composer-side' },
        el('div', { class: 'uart-field', style: { flexDirection: 'row', alignItems: 'center', gap: '6px' } },
          el('label', { class: 'uart-label', for: 'uart-line-ending', text: t('lineEnding') }),
          refs.lineEnding,
        ),
        refs.send,
        el('span', { class: 'uart-hint', text: t('sendHint') }),
      ),
    ),
  )

  // dut ---------------------------------------------------------------------
  refs.dutProfile = el('select', { class: 'uart-select', id: 'uart-dut-profile', onchange: (event) => { state.dut.profile = event.target.value; selectDutProfile() } })
  refs.dutPort = el('input', { class: 'uart-input', list: 'uart-port-list', placeholder: t('portPlaceholder'), oninput: (event) => { state.dutPort = event.target.value; syncDut() } })
  refs.dutBaud = el('input', { class: 'uart-input', type: 'number', min: '110', step: '1', placeholder: t('dutBaudAuto'), oninput: (event) => { state.dutBaud = event.target.value } })
  refs.dutDesc = el('p', { class: 'uart-dut-desc' })
  refs.dutMeta = el('p', { class: 'uart-dut-meta' })
  refs.dutTarget = el('p', { class: 'uart-dut-target' })
  refs.dutConnect = el('button', { class: 'uart-button is-primary is-block', type: 'button', text: t('dutConnect'), onclick: connectDut })
  refs.dutDisconnect = el('button', { class: 'uart-button is-danger is-block', type: 'button', text: t('dutDisconnect'), style: { display: 'none' }, onclick: disconnectDut })
  refs.dutStatus = el('div', { class: 'uart-dut-kv' })
  refs.dutSummary = el('span', { class: 'uart-count' })
  refs.dutProgress = el('div', { class: 'uart-dut-progress', style: { display: 'none' } })
  refs.dutCopyReport = el('button', {
    class: 'uart-button is-quiet',
    type: 'button',
    text: t('dutCopyReport'),
    title: t('dutCopyReportHint'),
    onclick: () => {
      if (state.dut.steps.length === 0) return
      copyText(dutReport())
    },
  })
  refs.dutCmdSearch = el('input', {
    class: 'uart-input uart-cmd-search',
    placeholder: t('dutSearchCommands'),
    oninput: (event) => { state.dut.query = event.target.value; renderDutCommands() },
  })
  refs.dutLow = el('input', { type: 'checkbox', onchange: (event) => { state.dut.includeLowPower = event.target.checked } })
  // Hidden unless the selected profile declares low-power steps: a profile is
  // free to have none, and a checkbox that does nothing is worse than no checkbox.
  refs.dutLowLabel = el('label', { class: 'uart-toggle', style: { display: 'none' } }, refs.dutLow, t('dutLowPower'))
  refs.dutSmoke = el('button', { class: 'uart-button is-primary', type: 'button', text: t('dutRunSmoke'), onclick: runSmoke })
  refs.dutSteps = el('div', { class: 'uart-dut-steps' })
  refs.dutCmds = el('div', { class: 'uart-cmd-list' })
  refs.dutCmdsCount = el('span', { class: 'uart-count' })
  refs.dutBadges = new Map()

  const dutRail = el(
    'div',
    { class: 'uart-card uart-rail' },
    el(
      'div',
      { class: 'uart-group uart-dut-form' },
      el('p', { class: 'uart-group-title', text: t('dutSectionProfile') }),
      el('div', { class: 'uart-field' }, el('label', { class: 'uart-label', for: 'uart-dut-profile', text: t('dutProfile') }), refs.dutProfile),
      refs.dutDesc,
      refs.dutMeta,
      refs.dutTarget,
      el('div', { class: 'uart-field' }, el('label', { class: 'uart-label', text: t('dutPort') }), refs.dutPort),
      el('div', { class: 'uart-field' }, el('label', { class: 'uart-label', text: t('dutBaud') }), refs.dutBaud),
      refs.dutConnect,
      refs.dutDisconnect,
    ),
    el('div', { class: 'uart-group' }, el('p', { class: 'uart-group-title', text: t('dutSectionStatus') }), refs.dutStatus),
  )

  const dutSmokeCard = el(
    'div',
    { class: 'uart-card uart-dut-smoke' },
    el(
      'div',
      { class: 'uart-dut-head' },
      el('div', { class: 'uart-dut-title', text: t('dutSmoke') }),
      refs.dutSummary,
      el('span', { class: 'uart-spacer' }),
      refs.dutLowLabel,
      refs.dutCopyReport,
      refs.dutSmoke,
    ),
    refs.dutProgress,
    refs.dutSteps,
  )

  const dutCommandsCard = el(
    'div',
    { class: 'uart-card uart-dut-commands' },
    el(
      'div',
      { class: 'uart-dut-head' },
      el('div', { class: 'uart-dut-title', text: t('dutCommands') }),
      refs.dutCmdSearch,
      refs.dutCmdsCount,
    ),
    refs.dutCmds,
  )

  const dutBody = el(
    'div',
    { class: 'uart-body uart-dut-body', style: { display: 'none' } },
    dutRail,
    el('div', { class: 'uart-main' }, dutSmokeCard, dutCommandsCard),
  )

  // history -----------------------------------------------------------------
  refs.histDir = el('select', {
    class: 'uart-select',
    'aria-label': t('filterAll'),
    onchange: () => loadHistory(),
  })
  refs.histDir.append(
    el('option', { value: 'all', text: t('filterAll') }),
    el('option', { value: 'rx', text: t('filterRx') }),
    el('option', { value: 'tx', text: t('filterTx') }),
  )
  refs.histText = el('input', {
    class: 'uart-input',
    placeholder: t('filterText'),
    oninput: (event) => { state.history.text = event.target.value; scheduleHistory() },
  })
  refs.histHex = el('input', {
    class: 'uart-input',
    placeholder: t('filterHex'),
    oninput: (event) => { state.history.hex = event.target.value; scheduleHistory() },
  })
  refs.histCount = el('span', { class: 'uart-count', text: t('frameCount', { count: 0 }) })
  refs.histReload = el('button', { class: 'uart-button', type: 'button', text: t('refresh'), onclick: () => loadHistory() })
  refs.histCopy = el('button', {
    class: 'uart-button',
    type: 'button',
    text: t('copy'),
    title: t('copyAllHint'),
    onclick: () => {
      if (state.history.frames.length === 0) return
      copyText(state.history.frames.map((frame) => textOf(frame)).join('\n'))
    },
  })
  refs.histList = el('div', { class: 'uart-tape uart-history-list' })

  const historyBody = el(
    'div',
    // NOT plain `uart-body`: that class is a two-column grid for the monitor
    // page, so a single child landed in the 248px rail column and the history
    // view rendered as a thin strip on the left.
    { class: 'uart-body uart-history-body', style: { display: 'none' } },
    el(
      'div',
      { class: 'uart-card uart-tape-card', style: { flex: '1 1 auto', minWidth: 0 } },
      el(
        'div',
        { class: 'uart-tape-head' },
        refs.histDir,
        refs.histHex,
        refs.histText,
        el('span', { class: 'uart-spacer' }),
        refs.histCount,
        refs.histCopy,
        refs.histReload,
      ),
      el(
        'div',
        { class: 'uart-history-head' },
        el('span', { class: 'uart-time', text: t('histColTime') }),
        el('span', { class: 'uart-dir', text: t('histColDir') }),
        el('span', { class: 'uart-len', text: t('histColLen') }),
        el('span', { class: 'uart-ascii', text: t('histColText') }),
      ),
      refs.histList,
    ),
  )

  refs.railGrip = el('div', { class: 'uart-grip', title: t('dragDivider') })
  refs.body = el('div', { class: 'uart-body is-monitor' }, rail, refs.railGrip, el('div', { class: 'uart-main' }, tapeCard, composer))
  root.append(header, refs.owner, refs.banner, refs.body, dutBody, historyBody)

  // ── rendering ────────────────────────────────────────────────────────────
  function passes(frame) {
    const hex = state.filter.hex.replace(/\s+/g, '').toUpperCase()
    if (state.filter.dir !== 'all' && frame.direction !== state.filter.dir) return false
    if (hex.length > 0 && !String(frame.raw ?? '').toUpperCase().includes(hex)) return false
    if (state.filter.text.length > 0 && !String(frame.data ?? '').includes(state.filter.text)) return false
    return true
  }

  function frameRow(frame) {
    const isTx = frame.direction === 'tx'
    const hasHex = state.showHex
    const hasAscii = state.showAscii || !hasHex
    const row = el(
      'div',
      { class: `uart-frame ${isTx ? 'is-tx' : 'is-rx'}${hasHex ? ' has-hex' : ' no-hex'}${hasAscii ? ' has-ascii' : ' no-ascii'}` },
      el('span', { class: 'uart-time', text: fmtTime(frame.timestamp) }),
      el('span', { class: 'uart-dir', text: isTx ? 'TX' : 'RX' }),
      el('span', { class: 'uart-len', text: `${frame.length}B` }),
    )
    if (hasHex) row.append(el('span', { class: 'uart-hex', text: prettyHex(frame.raw) }))
    if (hasHex && hasAscii) row.append(el('span', { class: 'uart-grip-hex', title: t('dragDivider') }))
    if (hasAscii) row.append(el('span', { class: 'uart-ascii', text: textOf(frame) }))
    return row
  }

  function renderTape() {
    pendingFrames.length = 0
    const visible = state.frames.filter(passes)
    state.visibleCount = visible.length
    refs.count.textContent = `${t('frameCount', { count: visible.length })} · ${t('seq', { seq: state.lastSeq })}`
    refs.tape.textContent = ''
    if (visible.length === 0) {
      refs.tape.append(
        el(
          'div',
          { class: 'uart-empty' },
          el('div', { class: 'uart-empty-icon' }, uartGlyph(28)),
          el('div', { class: 'uart-empty-title', text: state.frames.length === 0 ? t('emptyTitle') : t('emptyFiltered') }),
          el('div', { class: 'uart-empty-body', text: state.frames.length === 0 ? t('emptyBody') : t('emptyFilteredBody') }),
        ),
      )
      return
    }
    const fragment = document.createDocumentFragment()
    for (const frame of visible.slice(-MAX_ROWS)) fragment.append(frameRow(frame))
    refs.tape.append(fragment)
    if (state.follow) refs.tape.scrollTop = refs.tape.scrollHeight
  }

  /**
   * Frame rendering is batched per animation frame.
   *
   * A busy line can deliver hundreds of frames per second; appending one DOM
   * row, rewriting the counter and forcing a scroll reflow for each of them
   * locks the renderer. Frames land in a queue and one fragment append per
   * animation frame paints them, so a burst costs one layout instead of N.
   */
  const MAX_ROWS = 800
  const pendingFrames = []
  let flushScheduled = false
  let flushHandle = 0

  function flushFrames() {
    flushScheduled = false
    if (pendingFrames.length === 0) return
    const batch = pendingFrames.splice(0, pendingFrames.length)
    let matched = 0
    const rows = []
    for (const frame of batch) {
      if (!passes(frame)) continue
      matched += 1
      rows.push(frame)
    }
    if (matched > 0) {
      // A hidden panel can queue a whole buffer before the next animation
      // frame; only the newest screenful survives the trim below, so build
      // that many rows instead of thousands that are removed immediately.
      const fragment = document.createDocumentFragment()
      for (const frame of rows.slice(-MAX_ROWS)) fragment.append(frameRow(frame))
      const empty = refs.tape.querySelector('.uart-empty')
      if (empty) empty.remove()
      refs.tape.append(fragment)
      state.visibleCount += matched
      while (refs.tape.childElementCount > MAX_ROWS) refs.tape.firstElementChild.remove()
    }
    refs.count.textContent = `${t('frameCount', { count: state.visibleCount })} · ${t('seq', { seq: state.lastSeq })}`
    if (state.follow) refs.tape.scrollTop = refs.tape.scrollHeight
    if (pendingFrames.length > 0) scheduleFlush()
  }

  function scheduleFlush() {
    if (flushScheduled) return
    flushScheduled = true
    flushHandle = requestAnimationFrame(flushFrames)
  }

  function appendFrame(frame) {
    state.frames.push(frame)
    // Bulk trim, same reason as the Hub: `slice(-4000)` per frame copied 4000
    // entries for every single frame and made the console stutter at speed.
    if (state.frames.length > 5000) state.frames.splice(0, state.frames.length - 4000)
    state.rate[state.rate.length - 1] += 1
    if (frame.direction === 'tx') state.txTotal += 1
    else state.rxTotal += 1
    pendingFrames.push(frame)
    if (pendingFrames.length > 2000) pendingFrames.splice(0, pendingFrames.length - 2000)
    scheduleFlush()
  }

  /**
   * Telemetry strip: frames/second for the last minute plus the RX/TX split.
   *
   * This is the "is data actually flowing" indicator — a static frame count
   * cannot distinguish a live link from a stalled one.
   */
  function renderTelemetry() {
    const rates = state.rate
    const peak = Math.max(1, ...rates)
    const step = 120 / rates.length
    const points = rates
      .map((value, index) => {
        const x = (index * step + step / 2).toFixed(1)
        const y = (22 - (value / peak) * 20).toFixed(1)
        return `${x},${y}`
      })
      .join(' ')

    const ns = 'http://www.w3.org/2000/svg'
    refs.spark.textContent = ''
    const area = document.createElementNS(ns, 'polygon')
    area.setAttribute('points', `0,24 ${points} 120,24`)
    area.setAttribute('fill', 'currentColor')
    area.setAttribute('opacity', '0.12')
    const line = document.createElementNS(ns, 'polyline')
    line.setAttribute('points', points)
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', 'currentColor')
    line.setAttribute('stroke-width', '1.3')
    line.setAttribute('stroke-linejoin', 'round')
    refs.spark.append(area, line)

    // Average over the last 5 seconds: a single bucket reads 0 right after a
    // tick even on a live link, which looked like "no data".
    const recent = rates.slice(-5)
    const perSecond = Math.round(recent.reduce((sum, value) => sum + value, 0) / Math.max(1, recent.length))
    refs.rateLabel.textContent = `${perSecond}/s`
    // Idle is not an error — dim the rate instead of shouting a bare "0/s" next
    // to a long frame list.
    refs.rateLabel.classList.toggle('is-idle', perSecond === 0)
    refs.rateLabel.title = t('rateHint')
    refs.rxCount.textContent = t('tallyRx', { count: state.rxTotal })
    refs.txCount.textContent = t('tallyTx', { count: state.txTotal })
    refs.tally.title = t('tallyHint')
  }

  function sync() {
    const connected = state.connected
    refs.port.disabled = connected
    refs.baud.disabled = connected
    // Encoding is live-tunable: a GBK device already streaming must be readable
    // without dropping the port, so this one stays enabled while connected.
    refs.encoding.disabled = false
    refs.dataBits.disabled = connected
    refs.parity.disabled = connected
    refs.stopBits.disabled = connected
    // Framing is live-tunable too: switching from raw to line must take effect
    // on the open port, not force a reconnect.
    refs.protocol.disabled = false
    refs.connect.style.display = connected ? 'none' : ''
    refs.stop.style.display = connected ? '' : 'none'
    refs.stop.disabled = state.busy
    refs.close.style.display = connected ? '' : 'none'
    refs.connect.disabled = state.busy || String(state.port ?? '').trim().length === 0
    refs.connect.textContent = state.busy ? t('connecting') : t('connect')
    refs.dtrBtns.forEach((button, index) => {
      const active = state.signals.dtr === (index === 1)
      button.disabled = !connected
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
      button.style.color = active ? 'var(--uart-text)' : 'var(--uart-text-2)'
      button.style.background = active ? 'var(--uart-surface-2)' : 'var(--uart-surface)'
    })
    refs.rtsBtns.forEach((button, index) => {
      const active = state.signals.rts === (index === 1)
      button.disabled = !connected
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
      button.style.color = active ? 'var(--uart-text)' : 'var(--uart-text-2)'
      button.style.background = active ? 'var(--uart-surface-2)' : 'var(--uart-surface)'
    })
    refs.break.disabled = !connected
    syncSend()
    syncChips()
  }

  function syncSend() {
    const bytes = state.sendText.length === 0 ? 0 : new TextEncoder().encode(state.sendText + state.lineEnding).length
    refs.send.disabled = !state.connected || state.sendText.length === 0
    refs.send.textContent = state.sendText.length === 0 ? t('send') : `${t('send')} · ${t('bytes', { count: bytes })}`
    refs.sendText.disabled = !state.connected
  }

  function syncChips() {
    const online = state.hub === 'up'
    const offline = state.hub === 'down'
    refs.chip.className = `uart-chip${online ? ' is-online' : offline ? ' is-offline' : ''}`
    refs.chip.title = offline ? t('offlineHint') : ''
    refs.chip.lastElementChild.textContent = online ? t('online') : offline ? t('offline') : '…'
    refs.session.style.display = state.connected ? '' : 'none'
    refs.session.textContent = state.connected ? (state.ownsPort ? t('owned') : t('agentChip')) : ''
    refs.session.title = state.connectionId ?? ''

    // Ownership: locking every input without saying why reads as a bug, so the
    // Agent-held case gets its own strip and an explicit way out.
    const agentHeld = state.connected && !state.ownsPort
    refs.owner.style.display = agentHeld ? '' : 'none'
    if (agentHeld) {
      refs.owner.textContent = ''
      refs.owner.append(
        el('span', { class: 'uart-agent-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'uart-banner-text', text: t('agentOwned') }),
        el('button', { class: 'uart-button', type: 'button', text: t('stopMonitorAgent'), onclick: stopMonitoring }),
      )
    }
    // The rail keeps the short label: the long "does not close the Agent's
    // port" wording belongs to the ownership strip, and repeating it in both
    // places read as two different actions.
    refs.stop.textContent = t('stopMonitor')
  }

  /** Persisted user preferences; a missing storage entry keeps the defaults. */
  const PREF_KEY = 'mcp-uart.ui'
  function savePrefs() {
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify({
        rail: state.railWidth,
        ascii: state.asciiWidth,
        showHex: state.showHex,
        showAscii: state.showAscii,
      }))
    } catch {
      /* storage disabled: the layout still works for this session */
    }
  }
  function loadPrefs() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREF_KEY) ?? 'null')
      if (!saved || typeof saved !== 'object') return
      if (Number.isFinite(saved.rail)) state.railWidth = clamp(saved.rail, 190, 460)
      if (Number.isFinite(saved.ascii)) state.asciiWidth = clamp(saved.ascii, 100, 620)
      if (typeof saved.showHex === 'boolean') state.showHex = saved.showHex
      if (typeof saved.showAscii === 'boolean') state.showAscii = saved.showAscii
    } catch {
      /* ignore malformed prefs */
    }
  }
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

  function applyColumnWidths() {
    refs.body.style.setProperty('--uart-rail-w', `${state.railWidth}px`)
    refs.tape.style.setProperty('--uart-ascii-w', `${state.asciiWidth}px`)
  }

  /**
   * Breakpoints measured from the console's own box, not from window.
   *
   * `is-tiny` is the "too small to lay out" state: below a usable width/height
   * the console keeps a minimum content size and lets the host scroll, so the
   * panel degrades into something you can pan through instead of clipping.
   */
  let sizeObserver = null
  function applyResponsive(width, height) {
    root.classList.toggle('is-narrow', width < 860)
    root.classList.toggle('is-tight', width < 620)
    root.classList.toggle('is-tiny', width < 430 || (typeof height === 'number' && height < 300))
    // Short containers (the floating window, a short dock) trade the telemetry
    // strip for frame rows: at 520px tall the sparkline cost a whole line.
    root.classList.toggle('is-short', typeof height === 'number' && height < 600)
  }
  function observeSize() {
    applyResponsive(root.clientWidth, root.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    sizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) applyResponsive(entry.contentRect.width, entry.contentRect.height)
    })
    sizeObserver.observe(root)
  }

  function syncHexToggle() {
    refs.hexToggle.classList.toggle('is-off', !state.showHex)
    refs.hexToggle.setAttribute('aria-pressed', state.showHex ? 'true' : 'false')
  }

  /** Hex-column grips are delegated on the tape, so no per-row listeners are needed. */
  refs.tape.addEventListener('pointerdown', (event) => {
    const grip = event.target instanceof Element ? event.target.closest('.uart-grip-hex') : null
    if (grip === null || event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startW = state.asciiWidth
    grip.classList.add('is-dragging')
    root.classList.add('is-resizing')
    const move = (moveEvent) => {
      state.asciiWidth = clamp(startW - (moveEvent.clientX - startX), 100, 620)
      applyColumnWidths()
    }
    const up = () => {
      grip.classList.remove('is-dragging')
      root.classList.remove('is-resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      savePrefs()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })

  /** Pointer-drag a vertical divider; deltas are in CSS pixels. */
  function bindGrip(node, getWidth, setWidth) {
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startW = getWidth()
      node.classList.add('is-dragging')
      root.classList.add('is-resizing')
      const move = (moveEvent) => setWidth(startW + (moveEvent.clientX - startX))
      const up = () => {
        node.classList.remove('is-dragging')
        root.classList.remove('is-resizing')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        savePrefs()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    })
  }

  function notify(notice) {
    if (notice === null) {
      refs.banner.style.display = 'none'
      return
    }
    refs.banner.className = `uart-banner is-${notice.tone ?? 'info'}`
    refs.banner.style.display = ''
    refs.banner.textContent = ''
    refs.banner.append(
      el('span', { class: 'uart-banner-text', text: notice.text }),
      el('button', { class: 'uart-button is-quiet', type: 'button', text: '×', onclick: () => notify(null) }),
    )
    if (notice.tone !== 'error') {
      clearTimeout(refs.bannerTimer)
      refs.bannerTimer = setTimeout(() => notify(null), 4000)
    }
  }

  // ── dut page ─────────────────────────────────────────────────────────────
  function dutProfile() {
    return state.dut.profiles.find((profile) => profile.name === state.dut.profile) ?? null
  }

  function setTab(kind) {
    if (kind === 'dut' && !state.dut.available) return
    state.tab = kind === 'history' ? 'history' : kind === 'dut' ? 'dut' : 'monitor'
    refs.tabMonitor.classList.toggle('is-active', state.tab === 'monitor')
    refs.tabDut.classList.toggle('is-active', state.tab === 'dut')
    refs.tabHistory.classList.toggle('is-active', state.tab === 'history')
    refs.body.style.display = state.tab === 'monitor' ? '' : 'none'
    dutBody.style.display = state.tab === 'dut' ? '' : 'none'
    historyBody.style.display = state.tab === 'history' ? '' : 'none'
    if (state.tab === 'dut') refreshDut()
    if (state.tab === 'history') loadHistory()
  }

  /** Debounce history queries so typing in a filter does not spam the Hub. */
  function scheduleHistory() {
    clearTimeout(state.history.timer)
    state.history.timer = setTimeout(() => loadHistory(), 250)
  }

  /**
   * Read the Hub's session archive.
   *
   * Unlike the live tape this survives reconnects and is searchable, which is
   * what "历史消息" needs: look back at what the device said earlier without
   * keeping the window open.
   */
  async function loadHistory() {
    try {
      const params = new URLSearchParams({ limit: '500' })
      if (state.history.text) params.set('text', state.history.text)
      if (state.history.hex) params.set('hex', state.history.hex)
      if (refs.histDir.value !== 'all') params.set('direction', refs.histDir.value)
      const data = await readJson(`api/history?${params.toString()}`)
      state.history.frames = Array.isArray(data?.frames) ? data.frames : []
      state.history.total = Number(data?.total ?? 0)
      state.history.loaded = true
      renderHistory()
    } catch (error) {
      notify({ tone: 'error', text: t('historyFailed', { reason: errorText(error) }) })
    }
  }

  function renderHistory() {
    const frames = state.history.frames
    refs.histCount.textContent = t('historyCount', { shown: frames.length, total: state.history.total })
    refs.histList.textContent = ''
    if (frames.length === 0) {
      refs.histList.append(
        el(
          'div',
          { class: 'uart-empty' },
          el('div', { class: 'uart-empty-title', text: t('historyEmpty') }),
          el('div', { class: 'uart-empty-body', text: t('historyEmptyBody') }),
        ),
      )
      return
    }
    const fragment = document.createDocumentFragment()
    for (const frame of frames) {
      const isTx = frame.direction === 'tx'
      const row = el(
        'div',
        { class: `uart-frame has-ascii no-hex ${isTx ? 'is-tx' : 'is-rx'} uart-history-row` },
        el('span', { class: 'uart-time', text: fmtTime(frame.timestamp) }),
        el('span', { class: 'uart-dir', text: isTx ? 'TX' : 'RX' }),
        el('span', { class: 'uart-len', text: `${frame.length}B` }),
        el('span', { class: 'uart-ascii', text: textOf(frame) }),
      )
      fragment.append(row)
    }
    refs.histList.append(fragment)
  }

  function selectDutProfile() {
    const profile = dutProfile()
    if (profile !== null) {
      state.dutBaud = String(profile.serial.baudRate)
      refs.dutBaud.value = String(profile.serial.baudRate)
    }
    renderDutCommands()
    syncDut()
  }

  function renderDutCommands() {
    const profile = dutProfile()
    refs.dutCmds.textContent = ''
    refs.dutBadges.clear()
    if (profile === null) {
      refs.dutCmdsCount.textContent = ''
      refs.dutCmds.append(el('div', { class: 'uart-dut-idle', text: t('dutNoProfile') }))
      return
    }
    refs.dutCmdsCount.textContent = t('dutCommandsCount', { count: profile.commands.length })
    const query = String(state.dut.query ?? '').trim().toLowerCase()
    const commands = query.length === 0
      ? profile.commands
      : profile.commands.filter((command) => command.name.toLowerCase().includes(query) || String(command.title ?? '').toLowerCase().includes(query))
    if (commands.length === 0) {
      refs.dutCmds.append(el('div', { class: 'uart-dut-idle', text: t('dutNoMatch') }))
      return
    }
    for (const command of commands) {
      const badge = el('span', { class: 'uart-verdict', text: '—' })
      refs.dutBadges.set(command.name, badge)
      const title = el('span', { class: 'uart-cmd-title', text: command.title })
      if (command.fpgaSuitable) title.append(el('span', { class: 'uart-cmd-flag', text: 'FPGA' }))
      refs.dutCmds.append(
        el(
          'div',
          { class: 'uart-cmd' },
          el('span', { class: 'uart-cmd-name', text: command.name }),
          title,
          badge,
          el('button', { class: 'uart-button is-quiet', type: 'button', text: t('dutRunOne'), onclick: () => runDutCommand(command.name) }),
        ),
      )
    }
  }

  function setVerdict(name, verdict, elapsedMs) {
    const badge = refs.dutBadges.get(name)
    if (badge === undefined) return
    const tone = String(verdict ?? 'report').toLowerCase()
    badge.className = 'uart-verdict is-' + tone
    badge.textContent = elapsedMs === undefined ? String(verdict) : String(verdict) + ' · ' + Math.round(elapsedMs) + 'ms'
  }

  /** One-line-per-step text report, for pasting into a bug note or a chat. */
  function dutReport() {
    const summary = state.dut.summary
    const lines = []
    if (summary !== null) {
      lines.push(
        `${summary.profile}: PASS ${summary.passed} / FAIL ${summary.failed} / REPORT ${summary.report} (${Math.round(summary.elapsedMs ?? 0)}ms)`,
      )
    }
    for (const step of state.dut.steps) {
      lines.push(`[${step.verdict}] ${step.command} ${step.title ? '- ' + step.title : ''} (${Math.round(step.elapsedMs ?? 0)}ms)`)
      if (Array.isArray(step.failedChecks) && step.failedChecks.length > 0) lines.push(`    failed: ${step.failedChecks.join('; ')}`)
      if (Array.isArray(step.sent) && step.sent.length > 0) lines.push(`    tx: ${step.sent.join(' ')}`)
      if (Array.isArray(step.frames) && step.frames.length > 0) {
        lines.push(`    rx: ${step.frames.map((frame) => frame.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')).join(' | ')}`)
      }
    }
    return lines.join('\n')
  }

  function stepRow(step) {
    const verdict = String(step.verdict ?? 'REPORT')
    const tone = verdict.toLowerCase()
    const icon = verdict === 'PASS' ? '✓' : verdict === 'FAIL' ? '✗' : verdict === 'TIMEOUT' ? '⏱' : '○'
    const open = state.dut.expanded.has(step.command)
    const hasDetail =
      (Array.isArray(step.failedChecks) && step.failedChecks.length > 0) ||
      (Array.isArray(step.sent) && step.sent.length > 0) ||
      (Array.isArray(step.frames) && step.frames.length > 0) ||
      Boolean(step.note)

    const header = el(
      'div',
      {
        class: `uart-step${hasDetail ? ' is-expandable' : ''}${open ? ' is-open' : ''}`,
        onclick: hasDetail
          ? () => {
              if (open) state.dut.expanded.delete(step.command)
              else state.dut.expanded.add(step.command)
              renderDutSmoke()
            }
          : undefined,
      },
      el('span', { class: 'uart-step-icon is-' + tone, text: icon }),
      el('span', { class: 'uart-step-cmd', text: step.command }),
      el('span', { class: 'uart-step-title', text: step.title ?? '' }),
      el('span', { class: 'uart-verdict is-' + tone, text: verdict }),
      el('span', { class: 'uart-step-ms', text: Math.round(step.elapsedMs ?? 0) + 'ms' }),
      hasDetail ? el('span', { class: 'uart-step-chevron', text: open ? '▾' : '▸' }) : null,
    )

    if (!hasDetail || !open) return header

    const detail = el('div', { class: 'uart-step-detail' })
    if (Array.isArray(step.failedChecks) && step.failedChecks.length > 0) {
      detail.append(el('div', { class: 'uart-step-detail-row is-bad' }, el('span', { class: 'uart-step-detail-key', text: t('dutFailedChecks') }), el('span', { text: step.failedChecks.join('; ') })))
    }
    if (Array.isArray(step.sent) && step.sent.length > 0) {
      detail.append(el('div', { class: 'uart-step-detail-row' }, el('span', { class: 'uart-step-detail-key', text: 'TX' }), el('code', { text: step.sent.join(' ') })))
    }
    if (Array.isArray(step.frames) && step.frames.length > 0) {
      for (const frame of step.frames) {
        const hex = frame.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
        detail.append(el('div', { class: 'uart-step-detail-row' }, el('span', { class: 'uart-step-detail-key', text: 'RX' }), el('code', { text: hex })))
      }
    }
    if (step.note) {
      detail.append(el('div', { class: 'uart-step-detail-row' }, el('span', { class: 'uart-step-detail-key', text: t('dutNote') }), el('span', { text: step.note })))
    }
    return el('div', { class: 'uart-step-block' }, header, detail)
  }

  function renderDutSmoke() {
    refs.dutSteps.textContent = ''
    // Live progress while a smoke run is in flight.
    if (state.dut.running && state.dut.total > 0) {
      const done = state.dut.steps.length
      const percent = Math.min(100, Math.round((done / state.dut.total) * 100))
      refs.dutProgress.style.display = ''
      refs.dutProgress.textContent = ''
      refs.dutProgress.append(
        el('div', { class: 'uart-dut-progress-track' }, el('div', { class: 'uart-dut-progress-fill', style: { width: `${percent}%` } })),
        el('span', { class: 'uart-dut-progress-label', text: `${done}/${state.dut.total}` }),
      )
    } else {
      refs.dutProgress.style.display = 'none'
    }
    if (state.dut.steps.length === 0) {
      refs.dutSteps.append(
        el(
          'div',
          { class: 'uart-empty' },
          el('div', { class: 'uart-empty-title', text: state.dut.running ? t('dutRunning') : t('dutEmpty') }),
          el('div', { class: 'uart-empty-body', text: state.dut.running ? t('dutWaiting') : t('dutEmptyBody') }),
        ),
      )
    } else {
      for (const step of state.dut.steps) refs.dutSteps.append(stepRow(step))
      if (state.dut.running) {
        refs.dutSteps.append(
          el('div', { class: 'uart-step is-pending' }, el('span', { class: 'uart-step-icon', text: '…' }), el('span', { class: 'uart-step-cmd', text: t('dutRunning') })),
        )
      }
    }
    refs.dutSteps.scrollTop = refs.dutSteps.scrollHeight
    const summary = state.dut.summary
    refs.dutSummary.className = 'uart-count' + (summary === null ? '' : summary.failed > 0 ? ' is-bad' : ' is-good')
    refs.dutSummary.textContent = summary === null ? '' : t('dutSummary', { passed: summary.passed, failed: summary.failed, ms: Math.round(summary.elapsedMs ?? 0) })
  }

  function syncDut() {
    const status = state.dut.status
    const connected = status !== null && status.connected === true
    const profile = dutProfile()
    const active = state.dut.active
    refs.dutProfile.disabled = connected || state.dut.connecting
    refs.dutPort.disabled = connected || state.dut.connecting
    refs.dutBaud.disabled = connected || state.dut.connecting
    refs.dutConnect.style.display = connected ? 'none' : ''
    refs.dutDisconnect.style.display = connected ? '' : 'none'
    refs.dutConnect.disabled = state.dut.connecting || profile === null || (active === null && String(state.dutPort ?? '').trim().length === 0)
    refs.dutConnect.textContent = state.dut.connecting ? t('dutConnecting') : t('dutConnect')
    refs.dutDesc.textContent = profile === null ? '' : profile.description
    // Only offer low-power coverage when the profile actually declares it.
    const lowPowerCount = Array.isArray(profile?.lowPower) ? profile.lowPower.length : 0
    refs.dutLowLabel.style.display = lowPowerCount > 0 ? '' : 'none'
    if (lowPowerCount === 0) {
      refs.dutLow.checked = false
      state.dut.includeLowPower = false
    }
    // Frame contract and wiring, so the operator can sanity-check the hookup
    // without opening the profile JSON.
    refs.dutMeta.textContent = profile === null
      ? ''
      : [
          t('dutFrameMeta', { length: profile.frame?.length ?? '?', checksum: profile.frame?.checksum ?? '?' }),
          profile.serial?.wiring ? t('dutWiringMeta', { wiring: profile.serial.wiring }) : '',
        ].filter((part) => part.length > 0).join(' · ')
    if (connected) refs.dutTarget.textContent = t('dutConnectedHint', { profile: status.profile ?? '', port: status.port ?? '', baud: status.baudRate ?? '' })
    else if (active !== null) refs.dutTarget.textContent = t('dutAttachHint', { port: active.port ?? '' })
    else refs.dutTarget.textContent = t('dutOpenHint')
    refs.dutStatus.textContent = ''
    if (!connected) {
      refs.dutStatus.append(el('p', { class: 'uart-dut-idle', text: t('dutIdle') }))
    } else {
      const stats = status.stats ?? { framesParsed: 0, framesSent: 0, noiseBytes: 0 }
      const rows = [
        [t('dutLabelProfile'), String(status.profile ?? '') + ' · ' + String(status.chip ?? '')],
        [t('dutLabelPort'), String(status.port ?? '—') + ' @ ' + String(status.baudRate ?? '—')],
        [t('dutLabelFrames'), t('dutFramesValue', { parsed: stats.framesParsed, sent: stats.framesSent })],
        [t('dutLabelNoise'), t('bytes', { count: stats.noiseBytes })],
      ]
      for (const [key, value] of rows) {
        refs.dutStatus.append(
          el('div', { class: 'uart-kv-row' }, el('span', { class: 'uart-kv-key', text: key }), el('span', { class: 'uart-kv-value', text: value })),
        )
      }
    }
    refs.dutSmoke.disabled = !connected || state.dut.running
    refs.dutSmoke.textContent = state.dut.running ? t('dutRunning') : t('dutRunSmoke')
    refs.dutLow.disabled = state.dut.running || !connected
    for (const button of refs.dutCmds.querySelectorAll('button')) button.disabled = !connected || state.dut.running
  }

  async function loadDut() {
    try {
      const data = await readJson('api/dut')
      state.dut.available = data?.available === true
      if (state.dut.available) {
        state.dut.profiles = Array.isArray(data?.profiles) ? data.profiles : []
        state.dut.status = data?.status ?? null
        state.dut.active = data?.active ?? null
        if (!state.dut.profiles.some((profile) => profile.name === state.dut.profile)) {
          state.dut.profile = state.dut.profiles.length > 0 ? state.dut.profiles[0].name : ''
        }
        refs.dutProfile.textContent = ''
        for (const profile of state.dut.profiles) {
          refs.dutProfile.append(el('option', { value: profile.name, text: profile.name + ' · ' + profile.chip }))
        }
        refs.dutProfile.value = state.dut.profile
        // The tab row is always visible now (History lives there too); only the
        // DUT tab itself is disabled when this Hub has no DUT layer.
        refs.tabDut.disabled = state.dut.profiles.length === 0
        refs.tabDut.title = state.dut.profiles.length === 0 ? t('dutUnavailable') : ''
        selectDutProfile()
      } else {
        refs.tabDut.disabled = true
      }
    } catch {
      state.dut.available = false
      refs.tabDut.disabled = true
    }
    syncDut()
    renderDutSmoke()
  }

  async function refreshDut() {
    try {
      const data = await readJson('api/dut/status')
      state.dut.status = data?.status ?? null
      state.dut.active = data?.active ?? null
      state.dut.available = data?.available !== false && state.dut.profiles.length > 0
      syncDut()
    } catch {
      /* keep the last known DUT state; the next poll retries */
    }
  }

  async function connectDut() {
    if (state.dut.profile === '') return
    state.dut.connecting = true
    syncDut()
    try {
      const opening = state.dut.active === null
      const path = opening ? String(state.dutPort ?? '').trim() : undefined
      const baud = opening && String(state.dutBaud ?? '').trim() !== '' ? Number(state.dutBaud) : undefined
      const data = await postJson('api/dut/connect', { profile: state.dut.profile, path, baudRate: baud })
      state.dut.status = data?.status ?? null
      state.dut.active = data?.active ?? null
      if (data?.connectionId && data.connectionId !== state.connectionId) attach(data.connectionId, data.opened === true)
      notify({ tone: 'ok', text: t('dutConnected', { profile: state.dut.profile, port: data?.status?.port ?? '' }) })
    } catch (error) {
      notify({ tone: 'error', text: t('dutFailed', { reason: errorText(error) }) })
    } finally {
      state.dut.connecting = false
      syncDut()
    }
  }

  async function disconnectDut() {
    const closePort = state.ownsPort === true
    try {
      const data = await postJson('api/dut/disconnect', { closePort })
      state.dut.status = data?.status ?? null
      state.dut.active = data?.active ?? null
      notify({ tone: 'info', text: t('dutDisconnected') })
      if (closePort) {
        closeStream()
        detachLocal()
        state.frames = []
        renderTape()
      }
    } catch (error) {
      notify({ tone: 'error', text: t('dutFailed', { reason: errorText(error) }) })
    }
    syncDut()
  }

  async function runSmoke() {
    if (state.dut.running) return
    state.dut.running = true
    state.dut.steps = []
    state.dut.summary = null
    state.dut.total = 0
    state.dut.expanded.clear()
    renderDutSmoke()
    syncDut()
    try {
      const data = await postJson('api/dut/smoke', { includeLowPower: state.dut.includeLowPower })
      const result = data?.result ?? null
      state.dut.summary = result
      if (result !== null && Array.isArray(result.steps)) state.dut.steps = result.steps
      if (result !== null) {
        for (const step of result.steps ?? []) setVerdict(step.command, step.verdict, step.elapsedMs)
        notify({
          tone: result.allPassed ? 'ok' : 'error',
          text: result.allPassed ? t('dutSmokeDone', result) : t('dutSmokeFailed', result),
        })
      }
    } catch (error) {
      notify({ tone: 'error', text: t('dutFailed', { reason: errorText(error) }) })
    } finally {
      state.dut.running = false
      renderDutSmoke()
      syncDut()
    }
  }

  async function runDutCommand(name) {
    if (state.dut.running) return
    try {
      const data = await postJson('api/dut/run', { name })
      const result = data?.result
      if (result !== undefined) setVerdict(result.command, result.verdict, result.elapsedMs)
      notify({
        tone: result !== undefined && (result.verdict === 'PASS' || result.verdict === 'REPORT') ? 'ok' : 'error',
        text: t('dutRunDone', { command: name, verdict: result?.verdict ?? '?', ms: Math.round(result?.elapsedMs ?? 0) }),
      })
    } catch (error) {
      notify({ tone: 'error', text: t('dutFailed', { reason: errorText(error) }) })
    }
  }


  // ── backend ──────────────────────────────────────────────────────────────
  async function loadPorts() {
    try {
      const data = await readJson('api/ports')
      state.ports = Array.isArray(data?.ports) ? data.ports : []
      state.hub = 'up'
      refs.portList.textContent = ''
      for (const port of state.ports) refs.portList.append(el('option', { value: port.path, text: port.manufacturer ?? '' }))
      if ((state.port ?? '').length === 0 && state.ports.length > 0) {
        state.port = state.ports[0].path
        refs.port.value = state.port
      }
    } catch {
      state.hub = 'down'
    }
    syncChips()
    sync()
  }

  function openStream(sinceSeq) {
    closeStream()
    const source = new EventSource(apiUrl(`events/stream?sinceSeq=${sinceSeq}`))
    source.addEventListener('frame', (event) => {
      try {
        const frame = JSON.parse(event.data)
        if (typeof frame?.seq === 'number') {
          if (frame.seq <= state.lastSeq) return
          state.lastSeq = frame.seq
        }
        appendFrame(frame)
      } catch {
        /* a malformed frame must not kill the stream */
      }
    })
    source.addEventListener('dut', (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload?.kind === 'smoke-start') {
          state.dut.running = true
          state.dut.steps = []
          state.dut.summary = null
          state.dut.total = Number(payload.total ?? 0)
          renderDutSmoke()
          syncDut()
        } else if (payload?.kind === 'smoke-step' && payload.step) {
          state.dut.steps.push(payload.step)
          renderDutSmoke()
          setVerdict(payload.step.command, payload.step.verdict, payload.step.elapsedMs)
        } else if (payload?.kind === 'smoke-done' && payload.summary) {
          state.dut.summary = payload.summary
          renderDutSmoke()
        }
      } catch {
        /* a malformed progress event must not kill the stream */
      }
    })
    source.addEventListener('close', () => {
      detachLocal()
      notify({ tone: 'info', text: t('streamClosed') })
    })
    state.stream = source
  }

  function closeStream() {
    if (state.stream !== null) {
      state.stream.close()
      state.stream = null
    }
  }

  function detachLocal() {
    state.connected = false
    state.connectionId = null
    state.ownsPort = false
    sync()
  }

  function attach(connectionId, ownsPort) {
    state.connected = true
    state.connectionId = connectionId
    state.ownsPort = ownsPort === true
    state.lastSeq = 0
    state.frames = []
    renderTape()
    sync()
    // Replay only the recent tail: a full backlog makes the first paint heavy
    // and the reader does not need history older than the last screenful.
    readJson('api/health')
      .then((health) => {
        const seq = typeof health?.seq === 'number' ? health.seq : 0
        openStream(Math.max(0, seq - 200))
      })
      .catch(() => openStream(0))
  }

  async function attachIfNeeded(force = false) {
    if (state.connected && !force) return
    try {
      const health = await readJson('api/health')
      state.hub = 'up'
      syncChips()
      if (!health?.activeConnectionId) return
      if (state.connected && health.activeConnectionId === state.connectionId) return
      attach(health.activeConnectionId, health.ownsPort === true)
      notify({ tone: 'info', text: t('monitorAttached') })
    } catch {
      state.hub = 'down'
      syncChips()
    }
  }

  async function connect() {
    const path = String(state.port ?? '').trim()
    if (path.length === 0) return
    state.busy = true
    sync()
    notify(null)
    try {
      const data = await postJson('api/connect', {
        path,
        baudRate: Number(state.baud),
        dataBits: Number(state.dataBits),
        stopBits: Number(state.stopBits),
        parity: state.parity,
        encoding: state.encoding,
        protocol: state.protocol,
      })
      attach(data.connectionId, true)
      notify({ tone: 'ok', text: t('connected', { path: data?.info?.config?.path ?? path, baud: String(data?.info?.config?.baudRate ?? state.baud) }) })
    } catch (error) {
      notify({ tone: 'error', text: t('connectFailed', { reason: errorText(error) }) })
    } finally {
      state.busy = false
      sync()
    }
  }

  async function stopMonitoring() {
    try {
      await postJson('api/detach', {})
      notify({ tone: 'info', text: t('detached') })
    } catch (error) {
      notify({ tone: 'error', text: errorText(error) })
    }
    closeStream()
    detachLocal()
    state.frames = []
    renderTape()
  }

  async function closePort() {
    try {
      await postJson('api/disconnect', {})
      notify({ tone: 'info', text: t('closed') })
    } catch (error) {
      notify({ tone: 'error', text: errorText(error) })
    }
    closeStream()
    detachLocal()
    state.frames = []
    renderTape()
  }

  async function send() {
    if (state.sendText.length === 0) return
    try {
      const result = await postJson('api/write', { data: state.sendText + state.lineEnding, encoding: state.encoding })
      notify({ tone: 'ok', text: t('sent', { count: result?.bytesWritten ?? 0 }) })
    } catch (error) {
      notify({ tone: 'error', text: t('sendFailed', { reason: errorText(error) }) })
    }
  }

  /**
   * Push the current encoding to the live connection.
   *
   * The Hub decodes each incoming chunk with the connection's encoding, so this
   * must reach the backend — changing only the local select left the stream
   * decoded as before, which is why switching to GBK appeared to do nothing.
   * Frames already on screen keep their old decoding; new ones use the new one.
   */
  async function applyEncoding() {
    if (!state.connected) return
    try {
      await postJson('api/config', { encoding: state.encoding })
      notify({ tone: 'ok', text: t('encodingApplied', { encoding: state.encoding }) })
    } catch (error) {
      notify({ tone: 'error', text: t('encodingFailed', { reason: errorText(error) }) })
    }
  }

  /**
   * Push the current framing to the live connection.
   *
   * The backend rebuilds its parser on a protocol change, so this is what turns
   * "one frame per USB chunk" into "one frame per line" without a reconnect.
   */
  async function applyProtocol() {
    if (!state.connected) return
    try {
      await postJson('api/config', { protocol: state.protocol })
      notify({ tone: 'ok', text: t('protocolApplied', { protocol: state.protocol }) })
    } catch (error) {
      notify({ tone: 'error', text: t('protocolFailed', { reason: errorText(error) }) })
    }
  }

  async function setSignal(patch) {
    Object.assign(state.signals, patch)
    sync()
    try {
      await postJson('api/signals', patch)
    } catch (error) {
      notify({ tone: 'error', text: t('signalFailed', { reason: errorText(error) }) })
    }
  }

  // ── wiring / lifecycle ───────────────────────────────────────────────────
  state.port = ''
  state.baud = '115200'
  state.encoding = 'utf8'
  state.dataBits = '8'
  state.parity = 'none'
  state.stopBits = '1'
  state.protocol = 'line'
  refs.baud.value = state.baud
  refs.encoding.value = state.encoding
  refs.dataBits.value = state.dataBits
  refs.parity.value = state.parity
  refs.stopBits.value = state.stopBits
  refs.protocol.value = state.protocol
  refs.lineEnding.value = state.lineEnding

  loadPrefs()
  refs.ascii.checked = state.showAscii
  syncHexToggle()
  applyColumnWidths()
  observeSize()
  bindGrip(
    refs.railGrip,
    () => state.railWidth,
    (width) => { state.railWidth = clamp(width, 190, 460); applyColumnWidths() },
  )

  renderTape()
  renderTelemetry()
  sync()
  loadPorts()
  attachIfNeeded()
  loadDut()
  state.timer = setInterval(() => attachIfNeeded(), 1500)
  state.dut.timer = setInterval(() => { if (state.tab === 'dut') refreshDut() }, 3000)
  // One tick per second: slide the 60s window and repaint the strip.
  state.rateTimer = setInterval(() => {
    state.rate.push(0)
    state.rate.shift()
    renderTelemetry()
  }, 1000)

  return {
    destroy() {
      clearInterval(state.timer)
      clearInterval(state.dut.timer)
      clearInterval(state.rateTimer)
      clearTimeout(refs.bannerTimer)
      if (sizeObserver !== null) sizeObserver.disconnect()
      if (flushScheduled) cancelAnimationFrame(flushHandle)
      flushScheduled = false
      pendingFrames.length = 0
      closeStream()
      root.textContent = ''
      root.classList.remove('uart-root')
      root.classList.remove('is-embedded')
    },
  }
}

/** Same waveform mark as the plugin icon, drawn for the empty state. */
function uartGlyph(size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML =
    '<rect x="1.2" y="2.2" width="13.6" height="11.6" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.7"/>' +
    '<path d="M3.2 10.4h2.1V6.2h2.3v4.2h2.2V6.2h2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
  return svg
}

const ZH = {
  nav: '串口',
  title: '串口调试',
  intro: '与 Agent 共用同一条串口会话',
  openInBrowser: '在浏览器打开',
  refresh: '刷新',
  online: '在线',
  offline: '离线',
  shared: '共享会话',
  encodingApplied: '编码已切换为 {encoding}（对之后收到的帧生效）',
  encodingFailed: '切换编码失败：{reason}',
  copyAll: '复制',
  histColTime: '时间',
  histColDir: '方向',
  histColLen: '长度',
  histColText: '内容',
  copyAllHint: '复制当前过滤结果中的全部 ASCII 文本',
  copied: '已复制 {count} 个字符',
  copyFailed: '复制失败：{reason}',
  protocolApplied: '分段方式已切换为 {protocol}（对之后收到的数据生效）',
  protocolFailed: '切换分段方式失败：{reason}',
  protocolHint: '按行(line)=以 CR/LF 为一段；raw=每个串口数据块为一段',
  agentChip: 'Agent 接管',
  agentOwned: 'Agent 正在使用这条串口：面板只读监视，参数已锁定',
  stopMonitorAgent: '停止监视（不关闭 Agent 的串口）',
  owned: '面板会话',
  offlineHint: '串口 Hub 未运行。让 Agent 调用一次串口工具，或在本机执行 npx mcp-uart-hub。',
  sectionPort: '串口',
  sectionSignal: '调制解调器信号',
  advanced: '高级参数',
  portPlaceholder: 'COM3 或 /dev/ttyUSB0',
  baud: '波特率',
  dataBits: '数据位',
  parity: '校验',
  stopBits: '停止位',
  encoding: '编码',
  protocol: '协议',
  connect: '连接',
  connecting: '连接中…',
  connected: '已连接 {path} @ {baud}',
  connectFailed: '连接失败：{reason}',
  stopMonitor: '停止监视',
  closePort: '断开串口',
  detached: '已停止监视，MCP 打开的串口不会被关闭',
  closed: '串口已断开',
  filterAll: '全部',
  filterRx: 'RX',
  filterTx: 'TX',
  filterHex: '按 HEX 过滤',
  filterText: '按文本过滤',
  hex: 'HEX',
  toggleHex: '显示 / 折叠原始 HEX',
  dragDivider: '拖动调整列宽',
  ascii: 'ASCII',
  follow: '跟随',
  clear: '清空',
  frameCount: '{count} 帧',
  seq: 'seq {seq}',
  emptyTitle: '暂无帧',
  emptyBody: '连接串口后，TX/RX 会实时写入这里。',
  emptyFiltered: '没有匹配的帧',
  emptyFilteredBody: '放宽过滤条件试试。',
  sendPlaceholder: '输入要发送的数据…',
  sendHint: 'Ctrl+Enter 发送',
  send: '发送',
  lineEnding: '行尾',
  none: '无',
  bytes: '{count} B',
  sent: '已发送 {count} 字节',
  sendFailed: '发送失败：{reason}',
  dtr: 'DTR',
  rts: 'RTS',
  breakPulse: 'Break',
  signalFailed: '信号切换失败：{reason}',
  monitorAttached: '已挂上当前串口会话',
  streamClosed: '串口已关闭',
  tabMonitor: '监视',
  tabDut: '编排',
  tabHistory: '历史',
  dutUnavailable: '当前 Hub 没有 DUT 层',
  historyCount: '{shown} / {total} 条',
  historyEmpty: '暂无历史',
  historyEmptyBody: '这个 Hub 启动以来收到的帧会一直留在这里，重连也不会清空。',
  historyFailed: '读取历史失败：{reason}',
  copy: '复制',
  dutSectionProfile: '编排上位机',
  dutSectionStatus: '状态',
  dutProfile: '设备配置',
  dutPort: '串口',
  dutBaud: '波特率',
  dutBaudAuto: '跟随配置',
  dutConnect: '连接 DUT',
  dutConnecting: '连接中…',
  dutDisconnect: '断开 DUT',
  dutIdle: '未连接 DUT。选好配置后连接，或让 Agent 先跑 dut_connect。',
  dutAttachHint: '将附加到当前串口会话 {port}',
  dutOpenHint: '将打开所选串口并挂上该配置',
  dutConnectedHint: '{profile} · {port} @ {baud}',
  dutConnected: '编排上位机已连接：{profile} @ {port}',
  dutDisconnected: '编排上位机已断开',
  dutSmoke: '冒烟测试',
  dutCopyReport: '复制结果',
  dutCopyReportHint: '把本次冒烟结果（判定、耗时、收发帧、未过项）复制为文本',
  dutSearchCommands: '搜索命令',
  dutNoMatch: '没有匹配的命令',
  dutFailedChecks: '未过项',
  dutNote: '备注',
  dutFrameMeta: '帧 {length}B · 校验 {checksum}',
  dutWiringMeta: '接线 {wiring}',
  dutRunSmoke: '运行冒烟',
  dutRunning: '运行中…',
  dutLowPower: '含低功耗',
  tallyRx: 'RX {count}',
  tallyTx: 'TX {count}',
  tallyHint: '本次会话累计接收 / 发送的帧数',
  rateHint: '最近 5 秒的平均帧率；折线是最近 60 秒的走势',
  dutCommands: '命令',
  dutCommandsCount: '{count} 条',
  dutNoProfile: '没有可用的编排配置',
  dutRunOne: '运行',
  dutEmpty: '还没有结果',
  dutEmptyBody: '连接 DUT 后运行冒烟，或从下面挑一条命令单跑。',
  dutWaiting: '正在执行，结果会逐条出现…',
  dutSummary: 'PASS {passed} · FAIL {failed} · {ms}ms',
  dutSmokeDone: '冒烟通过：PASS {passed} / FAIL {failed}（{elapsedMs}ms）',
  dutSmokeFailed: '冒烟未通过：PASS {passed} / FAIL {failed}（{elapsedMs}ms）',
  dutRunDone: '{command} → {verdict}（{ms}ms）',
  dutFailed: '编排操作失败：{reason}',
  dutLabelProfile: '配置',
  dutLabelPort: '串口',
  dutLabelFrames: '帧',
  dutLabelNoise: '噪声',
  dutFramesValue: '解析 {parsed} · 发送 {sent}',
}

const EN = {
  nav: 'UART',
  title: 'Serial console',
  intro: 'One serial session, shared with the Agent',
  openInBrowser: 'Open in browser',
  refresh: 'Refresh',
  online: 'Online',
  offline: 'Offline',
  shared: 'Shared session',
  encodingApplied: 'Encoding switched to {encoding} (applies to new frames)',
  encodingFailed: 'Could not switch encoding: {reason}',
  copyAll: 'Copy',
  histColTime: 'Time',
  histColDir: 'Dir',
  histColLen: 'Len',
  histColText: 'Payload',
  copyAllHint: 'Copy every ASCII payload in the current filter',
  copied: 'Copied {count} characters',
  copyFailed: 'Copy failed: {reason}',
  protocolApplied: 'Framing switched to {protocol} (applies to incoming data)',
  protocolFailed: 'Could not switch framing: {reason}',
  protocolHint: 'line = split on CR/LF; raw = one frame per serial chunk',
  agentChip: 'Agent held',
  agentOwned: 'The Agent is using this port: the panel is read-only and its settings are locked',
  stopMonitorAgent: "Stop monitoring (leave the Agent's port open)",
  owned: 'Panel session',
  offlineHint: 'The serial hub is not running. Call any serial tool from the Agent, or run npx mcp-uart-hub locally.',
  sectionPort: 'Port',
  sectionSignal: 'Modem signals',
  advanced: 'Advanced',
  portPlaceholder: 'COM3 or /dev/ttyUSB0',
  baud: 'Baud rate',
  dataBits: 'Data bits',
  parity: 'Parity',
  stopBits: 'Stop bits',
  encoding: 'Encoding',
  protocol: 'Protocol',
  connect: 'Connect',
  connecting: 'Connecting…',
  connected: 'Connected to {path} at {baud}',
  connectFailed: 'Could not connect: {reason}',
  stopMonitor: 'Stop monitoring',
  closePort: 'Close port',
  detached: 'Stopped monitoring; a port opened by MCP stays open.',
  closed: 'Port closed',
  filterAll: 'All',
  filterRx: 'RX',
  filterTx: 'TX',
  filterHex: 'Filter hex',
  filterText: 'Filter text',
  hex: 'HEX',
  toggleHex: 'Show / collapse raw HEX',
  dragDivider: 'Drag to resize columns',
  ascii: 'ASCII',
  follow: 'Follow',
  clear: 'Clear',
  frameCount: '{count} frames',
  seq: 'seq {seq}',
  emptyTitle: 'No frames yet',
  emptyBody: 'TX and RX appear here as soon as a port is connected.',
  emptyFiltered: 'No matching frames',
  emptyFilteredBody: 'Try a looser filter.',
  sendPlaceholder: 'Type data to send…',
  sendHint: 'Ctrl+Enter sends',
  send: 'Send',
  lineEnding: 'Line ending',
  none: 'None',
  bytes: '{count} B',
  sent: 'Sent {count} bytes',
  sendFailed: 'Could not send: {reason}',
  dtr: 'DTR',
  rts: 'RTS',
  breakPulse: 'Break',
  signalFailed: 'Could not change signals: {reason}',
  monitorAttached: 'Attached to the current serial session',
  streamClosed: 'The port was closed',
  tabMonitor: 'Monitor',
  tabDut: 'Orchestrator',
  tabHistory: 'History',
  dutUnavailable: 'This Hub has no DUT layer',
  historyCount: '{shown} / {total}',
  historyEmpty: 'No history yet',
  historyEmptyBody: 'Frames received since this Hub started stay here, even across reconnects.',
  historyFailed: 'Could not read history: {reason}',
  copy: 'Copy',
  dutSectionProfile: 'Orchestrator',
  dutSectionStatus: 'Status',
  dutProfile: 'Profile',
  dutPort: 'Port',
  dutBaud: 'Baud rate',
  dutBaudAuto: 'From profile',
  dutConnect: 'Connect DUT',
  dutConnecting: 'Connecting…',
  dutDisconnect: 'Disconnect DUT',
  dutIdle: 'No DUT session. Pick a profile and connect, or let the Agent run dut_connect first.',
  dutAttachHint: 'Will attach to the open serial session {port}',
  dutOpenHint: 'Will open the selected port with this profile',
  dutConnectedHint: '{profile} · {port} at {baud}',
  dutConnected: 'Orchestrator connected: {profile} on {port}',
  dutDisconnected: 'Orchestrator disconnected',
  dutSmoke: 'Smoke test',
  dutCopyReport: 'Copy result',
  dutCopyReportHint: 'Copy this smoke run as text: verdicts, timings, frames, failed checks',
  dutSearchCommands: 'Search commands',
  dutNoMatch: 'No matching command',
  dutFailedChecks: 'Failed',
  dutNote: 'Note',
  dutFrameMeta: 'frame {length}B · checksum {checksum}',
  dutWiringMeta: 'wiring {wiring}',
  dutRunSmoke: 'Run smoke',
  dutRunning: 'Running…',
  dutLowPower: 'Low power',
  tallyRx: 'RX {count}',
  tallyTx: 'TX {count}',
  tallyHint: 'Frames received / sent in this session',
  rateHint: 'Average frame rate over the last 5 s; the line is the last 60 s',
  dutCommands: 'Commands',
  dutCommandsCount: '{count} commands',
  dutNoProfile: 'No DUT profile is available',
  dutRunOne: 'Run',
  dutEmpty: 'No results yet',
  dutEmptyBody: 'Connect a DUT and run the smoke test, or run a single command below.',
  dutWaiting: 'Running — results appear as each step finishes…',
  dutSummary: 'PASS {passed} · FAIL {failed} · {ms}ms',
  dutSmokeDone: 'Smoke passed: PASS {passed} / FAIL {failed} ({elapsedMs}ms)',
  dutSmokeFailed: 'Smoke failed: PASS {passed} / FAIL {failed} ({elapsedMs}ms)',
  dutRunDone: '{command} → {verdict} ({ms}ms)',
  dutFailed: 'Orchestrator operation failed: {reason}',
  dutLabelProfile: 'Profile',
  dutLabelPort: 'Port',
  dutLabelFrames: 'Frames',
  dutLabelNoise: 'Noise',
  dutFramesValue: '{parsed} parsed · {sent} sent',
}

const CSS = `
.uart-root {
  /* Clean-surface palette: white cards on the host background, separation comes
     from a 1px border + 1px shadow, NOT from tinting every layer grey. */
  --uart-bg: var(--dsw-alias-bg-base, #ffffff);
  --uart-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --uart-surface-2: var(--dsw-alias-bg-layer-2, #f4f5f7);
  --uart-border: var(--dsw-alias-border-l1, #e4e6eb);
  --uart-border-strong: var(--dsw-alias-border-l2, #d3d7de);
  --uart-text: var(--dsw-alias-label-primary, #1b1d22);
  /* Derive secondary/tertiary ink from primary text instead of trusting a
     host token whose contrast may be very low on light backgrounds. */
  --uart-ink-2: color-mix(in srgb, var(--uart-text) 76%, var(--uart-bg));
  --uart-ink-3: color-mix(in srgb, var(--uart-text) 56%, var(--uart-bg));
  --uart-text-2: var(--uart-ink-2);
  --uart-brand: var(--dsw-alias-brand-primary, #1f6feb);
  --uart-ok: var(--dsw-alias-state-success-primary, #16a34a);
  --uart-err: var(--dsw-alias-state-error-primary, #dc2626);
  --uart-warn: var(--dsw-alias-state-warn-primary, #b45309);
  --uart-tx: var(--uart-brand);
  --uart-rx: var(--uart-ok);
  --uart-danger: var(--uart-err);
  display: flex; flex-direction: column;
  /* A DSH panel or floating window may be a shrink-to-fit flex child, so the
     host's viewport width is NOT our width. Claim the full inline size and
     allow shrinking; all responsive decisions below use ResizeObserver on this
     element, never a viewport media query. */
  width: 100%; min-width: 0;
  height: 100%; min-height: 0; box-sizing: border-box;
  overflow: hidden;
  padding: 18px 20px 14px;
  gap: 14px;
  background: var(--uart-bg);
  color: var(--uart-text);
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .uart-root {
    --uart-bg: var(--dsw-alias-bg-base, #151517);
    --uart-surface: var(--dsw-alias-bg-layer-1, #1c1d21);
    --uart-surface-2: var(--dsw-alias-bg-layer-2, #23242a);
    --uart-border: var(--dsw-alias-border-l1, #2b2d33);
    --uart-border-strong: var(--dsw-alias-border-l2, #3a3d45);
    --uart-text: var(--dsw-alias-label-primary, #e8eaee);
    --uart-ink-2: color-mix(in srgb, var(--uart-text) 80%, var(--uart-bg));
    --uart-ink-3: color-mix(in srgb, var(--uart-text) 60%, var(--uart-bg));
    --uart-brand: var(--dsw-alias-brand-primary, #6ea8fe);
    --uart-ok: var(--dsw-alias-state-success-primary, #3ecf8e);
    --uart-err: var(--dsw-alias-state-error-primary, #ff6b6b);
    --uart-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  }
}
.uart-root *, .uart-root *::before, .uart-root *::after { box-sizing: border-box; }
.uart-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.uart-root.is-embedded { padding: 10px 12px 8px; gap: 10px; }
.uart-root.is-embedded .uart-heading { display: none; }
.uart-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.uart-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.uart-intro { margin: 0; color: var(--uart-text-2); font-size: 12px; }
.uart-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.uart-chip {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--uart-border);
  background: var(--uart-surface-2);
  color: var(--uart-text-2);
  font-size: 11px; font-weight: 500; white-space: nowrap;
}
.uart-chip.is-online { color: var(--uart-ok); border-color: color-mix(in srgb, var(--uart-ok) 35%, transparent); background: color-mix(in srgb, var(--uart-ok) 10%, transparent); }
.uart-chip.is-offline { color: var(--uart-danger); border-color: color-mix(in srgb, var(--uart-danger) 35%, transparent); background: color-mix(in srgb, var(--uart-danger) 8%, transparent); }
.uart-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.uart-chip.is-online .uart-dot { box-shadow: 0 0 0 2px color-mix(in srgb, var(--uart-ok) 22%, transparent); }
/* One explicit grid row: height comes from .uart-body, never from its content.
   Without this the tape grew with every received frame and pushed the send box
   out of the root (which clips overflow), so the 发送 button disappeared. */
.uart-body {
  flex: 1 1 auto; min-height: 0; min-width: 0;
  display: grid; grid-template-columns: 248px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 14px; overflow: hidden;
}
.uart-main { display: flex; flex-direction: column; gap: 14px; min-width: 0; min-height: 0; overflow: hidden; }
.uart-card {
  display: flex; flex-direction: column;
  min-height: 0;
  border: 1px solid var(--uart-border-strong);
  border-radius: 12px;
  background: var(--uart-surface);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}
.uart-rail { padding: 14px; gap: 14px; overflow: auto; }
/* The parameter card must never be squeezed by its container: if the host is
   short, the BODY scrolls and the card keeps its natural height. Without this a
   flex-shrunk rail cut the "高级参数" row in half. */
.uart-rail { flex: none; min-height: max-content; }
.uart-tape-card { flex: 1 1 0; min-height: 0; overflow: hidden; }
.uart-send-card { flex: none; padding: 12px; gap: 8px; }
.uart-group { display: flex; flex-direction: column; gap: 10px; }
.uart-group-title {
  margin: 0; font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--uart-text-2);
}
.uart-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.uart-row2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.uart-label { color: var(--uart-text-2); font-size: 11px; font-weight: 500; }
.uart-input, .uart-select {
  width: 100%; min-width: 0; height: 30px; padding: 0 8px;
  border: 1px solid var(--uart-border);
  border-radius: 7px;
  background: var(--uart-bg);
  color: var(--uart-text);
  font: inherit; font-size: 12px;
}
.uart-select { padding-right: 4px; cursor: pointer; }
.uart-input::placeholder { color: var(--uart-ink-3); opacity: 1; }
.uart-input:hover:not(:disabled), .uart-select:hover:not(:disabled) { border-color: var(--uart-border-strong); }
.uart-input:disabled, .uart-select:disabled { opacity: 0.55; cursor: default; }
.uart-input:focus-visible, .uart-select:focus-visible, .uart-textarea:focus-visible, .uart-button:focus-visible, .uart-seg-button:focus-visible, .uart-link:focus-visible, .uart-summary:focus-visible {
  outline: 2px solid var(--uart-brand); outline-offset: 1px;
}
.uart-advanced { display: flex; flex-direction: column; gap: 8px; }
.uart-summary { width: fit-content; list-style: none; cursor: pointer; color: var(--uart-text-2); font-size: 11px; font-weight: 500; user-select: none; }
.uart-summary::-webkit-details-marker { display: none; }
.uart-summary::before { content: '›'; display: inline-block; width: 12px; transition: transform .12s ease; }
.uart-advanced[open] .uart-summary::before { transform: rotate(90deg); }
.uart-summary:hover { color: var(--uart-text); }
.uart-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--uart-border-strong);
  background: var(--uart-bg);
  color: var(--uart-text);
  font: inherit; font-size: 12px; font-weight: 500;
  white-space: nowrap; cursor: pointer;
  transition: background-color .12s ease, border-color .12s ease, opacity .12s ease;
}
.uart-button:hover:not(:disabled) { background: var(--uart-surface-2); }
.uart-button:disabled { opacity: 0.45; cursor: default; }
.uart-button.is-primary { height: 32px; background: var(--uart-brand); border-color: var(--uart-brand); color: var(--uart-bg); font-weight: 600; }
.uart-button.is-primary:hover:not(:disabled) { filter: brightness(1.06); }
.uart-button.is-block { width: 100%; }
.uart-button.is-quiet { border-color: transparent; background: transparent; color: var(--uart-text-2); }
.uart-button.is-quiet:hover:not(:disabled) { background: var(--uart-surface-2); color: var(--uart-text); }
.uart-button.is-danger { border-color: transparent; background: transparent; color: var(--uart-danger); }
.uart-button.is-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--uart-danger) 10%, transparent); }
.uart-link { border: 0; background: transparent; padding: 0 2px; color: var(--uart-text-2); font: inherit; font-size: 11px; cursor: pointer; text-decoration: none; white-space: nowrap; }
.uart-link:hover { color: var(--uart-text); }
.uart-seg { display: inline-flex; border: 1px solid var(--uart-border); border-radius: 7px; overflow: hidden; }
.uart-seg-button { height: 24px; min-width: 30px; padding: 0 8px; border: 0; background: var(--uart-bg); color: var(--uart-text-2); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.uart-seg-button + .uart-seg-button { border-left: 1px solid var(--uart-border); }
.uart-seg-button:hover:not(:disabled) { color: var(--uart-text); }
.uart-seg-button:disabled { opacity: .45; cursor: default; }
.uart-signal-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.uart-signal-name { font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--uart-text-2); }
.uart-tape-head { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 7px; border-bottom: 1px solid var(--uart-border); background: transparent; }
.uart-tape-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.uart-tape-meta { gap: 10px; color: var(--uart-text-2); font-size: 11px; }
.uart-spark { width: 120px; height: 24px; flex: none; color: var(--uart-brand); }
.uart-rate { font-size: 11px; color: var(--uart-text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.uart-rate.is-idle { opacity: 0.55; }
.uart-tally-group { display: inline-flex; align-items: baseline; gap: 10px; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.uart-tally.is-rx { color: var(--uart-ok); }
.uart-tally.is-tx { color: var(--uart-brand); }
.uart-tape-head .uart-input { height: 26px; width: 118px; font-size: 11.5px; }
.uart-tape-head .uart-select { height: 26px; width: auto; font-size: 11.5px; }
.uart-spacer { flex: 1 1 auto; }
.uart-toggle { display: inline-flex; align-items: center; gap: 5px; color: var(--uart-text-2); font-size: 11px; cursor: pointer; user-select: none; }
.uart-toggle input { margin: 0; accent-color: var(--uart-brand); }
.uart-count { color: var(--uart-text-2); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.uart-tape { flex: 1 1 auto; min-height: 0; overflow: auto; background: var(--uart-surface); border-radius: 0 0 12px 12px; padding: 4px 0 8px; }
.uart-frame {
  display: grid; grid-template-columns: 84px 34px 44px minmax(0, 1fr) minmax(0, 210px);
  gap: 8px; align-items: start;
  padding: 3px 14px 3px 12px;
  border-left: 2px solid transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; line-height: 1.6;
}
.uart-frame:nth-of-type(even) { background: color-mix(in srgb, var(--uart-surface-2) 45%, transparent); }
.uart-frame:hover { background: var(--uart-surface-2); }
.uart-frame.is-tx { border-left-color: var(--uart-tx); }
.uart-frame.is-rx { border-left-color: var(--uart-rx); }
.uart-time { color: var(--uart-text-2); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.uart-dir { display: inline-flex; align-items: center; justify-content: center; height: 16px; border-radius: 4px; font-size: 9.5px; font-weight: 700; letter-spacing: .06em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.uart-frame.is-tx .uart-dir { color: color-mix(in srgb, var(--uart-tx) 78%, var(--uart-text)); background: color-mix(in srgb, var(--uart-tx) 16%, transparent); }
.uart-frame.is-rx .uart-dir { color: color-mix(in srgb, var(--uart-rx) 72%, var(--uart-text)); background: color-mix(in srgb, var(--uart-rx) 16%, transparent); }
.uart-len { color: var(--uart-text-2); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* Long frames wrap inside their own column only: the two text columns start on
   the same line and never push each other onto a second row. */
.uart-hex { min-width: 0; color: var(--uart-text); font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; }
.uart-ascii { min-width: 0; color: var(--uart-ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
/* Selection is restricted BY REGION, not by row controls: a frame is a table,
   not prose. Nothing in the row is selectable except the ASCII payload cell, so
   dragging across the log copies messages only — never the timestamp, TX/RX
   tag, byte count or the hex dump. */
.uart-frame, .uart-history-row { user-select: none; -webkit-user-select: none; }
.uart-ascii { user-select: text; -webkit-user-select: text; cursor: text; }
.uart-frame ::selection, .uart-frame::selection { background: color-mix(in srgb, var(--uart-brand) 26%, transparent); }
.uart-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; height: 100%; min-height: 150px; padding: 24px; text-align: center; }
.uart-empty-icon { color: var(--uart-border-strong); }
.uart-empty-title { font-size: 13px; font-weight: 600; }
.uart-empty-body { color: var(--uart-text-2); font-size: 12px; max-width: 34ch; }
.uart-composer { display: flex; gap: 8px; align-items: flex-end; flex: none; }
.uart-textarea {
  flex: 1 1 auto; min-width: 0; min-height: 44px; max-height: 140px;
  padding: 8px 10px;
  border: 1px solid var(--uart-border);
  border-radius: 8px;
  background: var(--uart-bg);
  color: var(--uart-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; line-height: 1.55; resize: vertical;
}
.uart-textarea::placeholder { color: var(--uart-ink-3); opacity: 1; }
.uart-composer-side { display: flex; flex-direction: column; gap: 6px; align-items: stretch; flex: none; }
.uart-hint { color: var(--uart-text-2); font-size: 10.5px; text-align: right; white-space: nowrap; }
.uart-banner { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 9px; border: 1px solid var(--uart-border); background: transparent; font-size: 12px; }
.uart-banner.is-ok { border-color: color-mix(in srgb, var(--uart-ok) 40%, transparent); background: color-mix(in srgb, var(--uart-ok) 8%, transparent); }
.uart-banner.is-error { border-color: color-mix(in srgb, var(--uart-danger) 40%, transparent); background: color-mix(in srgb, var(--uart-danger) 7%, transparent); }
.uart-banner.is-agent { border-color: color-mix(in srgb, var(--uart-warn) 45%, transparent); background: color-mix(in srgb, var(--uart-warn) 9%, transparent); color: var(--uart-text); }
.uart-agent-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--uart-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--uart-warn) 20%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .uart-agent-dot { animation: uart-agent-pulse 1.8s ease-in-out infinite; }
}
@keyframes uart-agent-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, var(--uart-warn) 20%, transparent); }
  50% { opacity: .65; box-shadow: 0 0 0 5px color-mix(in srgb, var(--uart-warn) 8%, transparent); }
}
.uart-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.uart-banner .uart-button { height: 24px; }
.uart-tabs { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--uart-border); border-radius: 9px; background: var(--uart-surface-2); }
.uart-tab { height: 24px; padding: 0 12px; border: 0; border-radius: 7px; background: transparent; color: var(--uart-text-2); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; }
.uart-tab:hover:not(.is-active) { color: var(--uart-text); }
.uart-tab.is-active { background: var(--uart-surface); color: var(--uart-text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
.uart-dut-desc { margin: 0; color: var(--uart-text-2); font-size: 11.5px; line-height: 1.55; }
.uart-dut-meta { margin: 0; color: var(--uart-ink-3); font-size: 11px; line-height: 1.5; }
.uart-dut-target { margin: 0; color: var(--uart-text-2); font-size: 11px; line-height: 1.5; }
.uart-dut-kv { display: flex; flex-direction: column; gap: 6px; }
.uart-kv-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 11.5px; }
.uart-kv-key { color: var(--uart-text-2); white-space: nowrap; }
.uart-kv-value { color: var(--uart-text); text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.uart-dut-idle { margin: 0; color: var(--uart-text-2); font-size: 11.5px; line-height: 1.6; }
.uart-dut-smoke { flex: 1 1 56%; min-height: 168px; overflow: hidden; }
/* The DUT page is a single stacked column at EVERY width.
   Two-column grid on this page produced repeated misalignment: the parameter
   card and the smoke card fought over the row height and the connect button
   ended up painted on top of the smoke header. Stacking removes that whole
   class of bug; on wide screens the form itself spreads out horizontally. */
.uart-dut-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  overflow-x: hidden;
}
.uart-dut-body > .uart-rail { flex: none; width: 100%; height: auto; overflow: visible; }
.uart-dut-body > .uart-main { flex: none; width: 100%; min-height: 480px; }
/* Wide screens: the profile form lays out in columns instead of a tall card. */
.uart-dut-body > .uart-rail > .uart-dut-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  align-items: end;
  gap: 10px;
}
.uart-dut-body > .uart-rail > .uart-dut-form > .uart-group-title,
.uart-dut-body > .uart-rail > .uart-dut-form > .uart-dut-desc,
.uart-dut-body > .uart-rail > .uart-dut-form > .uart-dut-meta,
.uart-dut-body > .uart-rail > .uart-dut-form > .uart-dut-target { grid-column: 1 / -1; }
.uart-dut-body > .uart-rail > .uart-dut-form > .uart-button { grid-column: 1 / -1; }
.uart-dut-commands { flex: 1 1 44%; min-height: 140px; overflow: hidden; }
.uart-dut-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--uart-border); flex-wrap: wrap; }
.uart-dut-title { font-size: 12px; font-weight: 600; }
.uart-dut-head .uart-button.is-primary { height: 26px; padding: 0 10px; font-size: 11.5px; }
.uart-dut-steps { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0 8px; }
.uart-step {
  display: grid; grid-template-columns: 16px 168px minmax(0, 1fr) 76px 60px;
  gap: 8px; align-items: baseline;
  padding: 4px 12px;
  border-left: 2px solid transparent;
  font-size: 12px;
}
.uart-step:nth-of-type(even) { background: color-mix(in srgb, var(--uart-surface-2) 40%, transparent); }
.uart-step-icon { font-weight: 700; text-align: center; }
.uart-step-icon.is-pass { color: var(--uart-ok); }
.uart-step-icon.is-fail, .uart-step-icon.is-timeout { color: var(--uart-danger); }
.uart-step-icon.is-report { color: var(--uart-text-2); }
.uart-step.is-pending { color: var(--uart-text-2); font-style: italic; }
.uart-step-cmd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
.uart-step-title { color: var(--uart-text-2); font-size: 11.5px; overflow-wrap: anywhere; }
.uart-step-ms { color: var(--uart-text-2); font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; }
.uart-step-note { grid-column: 2 / -1; color: var(--uart-danger); font-size: 11px; overflow-wrap: anywhere; }
.uart-verdict {
  justify-self: start;
  padding: 1px 6px; border-radius: 4px;
  background: var(--uart-surface-2); color: var(--uart-text-2);
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.uart-verdict.is-pass { color: var(--uart-ok); background: color-mix(in srgb, var(--uart-ok) 12%, transparent); }
.uart-verdict.is-fail, .uart-verdict.is-timeout { color: var(--uart-danger); background: color-mix(in srgb, var(--uart-danger) 10%, transparent); }
.uart-cmd-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0 8px; }
.uart-cmd { display: grid; grid-template-columns: 168px minmax(0, 1fr) auto auto; gap: 8px; align-items: center; padding: 3px 12px; font-size: 12px; }
.uart-cmd:nth-of-type(even) { background: color-mix(in srgb, var(--uart-surface-2) 40%, transparent); }
.uart-cmd:hover { background: var(--uart-surface-2); }
.uart-cmd-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
.uart-cmd-title { color: var(--uart-text-2); font-size: 11.5px; overflow-wrap: anywhere; }
.uart-cmd-flag { margin-left: 6px; padding: 0 4px; border-radius: 3px; background: var(--uart-surface-2); color: var(--uart-text-2); font-size: 9.5px; letter-spacing: 0.05em; }
.uart-cmd .uart-button { height: 22px; padding: 0 8px; font-size: 11px; }
.uart-count.is-good { color: color-mix(in srgb, var(--uart-ok) 78%, var(--uart-text)); }
.uart-count.is-bad { color: color-mix(in srgb, var(--uart-danger) 78%, var(--uart-text)); }

/* ── History view ───────────────────────────────────────────────────────── */
.uart-history-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  overflow: hidden;
}
.uart-history-body > .uart-card { width: 100%; min-width: 0; }
.uart-history-head {
  display: grid;
  grid-template-columns: 84px 34px 44px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 5px 14px 5px 12px;
  border-bottom: 1px solid var(--uart-border);
  background: transparent;
  color: var(--uart-text-2);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.uart-history-list { border-radius: 0 0 12px 12px; }
.uart-history-row { border-bottom: 1px solid color-mix(in srgb, var(--uart-border) 55%, transparent); }
.uart-history-row:nth-of-type(even) { background: color-mix(in srgb, var(--uart-surface-2) 45%, transparent); }
.uart-history-row:hover { background: var(--uart-surface-2); }

/* ── DUT page ───────────────────────────────────────────────────────────── */
.uart-dut-progress { display: flex; align-items: center; gap: 8px; padding: 6px 12px 0; }
.uart-dut-progress-track { flex: 1 1 auto; height: 4px; border-radius: 999px; background: var(--uart-surface-2); overflow: hidden; }
.uart-dut-progress-fill { height: 100%; background: var(--uart-brand); transition: width .2s ease; }
.uart-dut-progress-label { font-size: 11px; color: var(--uart-text-2); font-variant-numeric: tabular-nums; }
.uart-cmd-search { width: 140px; height: 24px; font-size: 11.5px; }
.uart-step-block { border-bottom: 1px solid color-mix(in srgb, var(--uart-border) 60%, transparent); }
.uart-step.is-expandable { cursor: pointer; }
.uart-step.is-expandable:hover { background: var(--uart-surface-2); }
.uart-step-chevron { color: var(--uart-text-2); font-size: 10px; text-align: right; }
.uart-step-detail { display: flex; flex-direction: column; gap: 4px; padding: 4px 12px 8px 36px; }
.uart-step-detail-row { display: flex; gap: 8px; align-items: baseline; font-size: 11.5px; overflow-wrap: anywhere; }
.uart-step-detail-row code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.uart-step-detail-row.is-bad { color: var(--uart-danger); }
.uart-step-detail-key { flex: none; width: 64px; color: var(--uart-text-2); font-size: 11px; }

/* ── user-resizable columns ───────────────────────────────────────────────
   CSS custom properties hold the live widths; two narrow grips drag them.
   The rail grip sits between the rail and the log, the hex grip between HEX
   and ASCII. Widths persist in localStorage so both carriers remember. */
.uart-body { --uart-rail-w: 248px; }
.uart-body.is-monitor { grid-template-columns: var(--uart-rail-w) 5px minmax(0, 1fr); }
.uart-grip { cursor: col-resize; border-radius: 3px; background: transparent; position: relative; touch-action: none; }
.uart-grip::after { content: ''; position: absolute; inset: 8px 1px; border-radius: 2px; background: var(--uart-border-strong); opacity: .35; }
.uart-grip:hover::after, .uart-grip.is-dragging::after { background: var(--uart-brand); opacity: .8; }
.uart-grip-hex { width: 5px; cursor: col-resize; border-radius: 3px; background: transparent; position: relative; flex: none; touch-action: none; }
.uart-grip-hex::after { content: ''; position: absolute; inset: 0 1px; border-left: 2px dotted var(--uart-border-strong); opacity: .8; }
.uart-grip-hex:hover::after, .uart-grip-hex.is-dragging::after { border-left-color: var(--uart-brand); opacity: 1; }
.uart-root.is-resizing, .uart-root.is-resizing * { cursor: col-resize !important; user-select: none !important; }
.uart-frame { --uart-hex-w: minmax(0, 1fr); }
.uart-frame.has-hex.has-ascii { grid-template-columns: 84px 34px 44px var(--uart-hex-w) 5px var(--uart-ascii-w, minmax(0, 210px)); }
.uart-frame.has-hex.has-ascii > .uart-grip-hex { grid-column: 5; }
.uart-frame.has-hex.has-ascii > .uart-ascii { grid-column: 6; }
.uart-frame.has-hex.no-ascii { grid-template-columns: 84px 34px 44px minmax(0, 1fr); }
.uart-frame.no-hex.has-ascii { grid-template-columns: 84px 34px 44px minmax(0, 1fr); }
.uart-hex-toggle { font-size: 10px; color: var(--uart-ink-2); border: 1px solid var(--uart-border); background: var(--uart-surface); border-radius: 5px; padding: 0 5px; height: 18px; line-height: 16px; cursor: pointer; }
.uart-hex-toggle:hover { color: var(--uart-text); border-color: var(--uart-border-strong); }
.uart-hex-toggle.is-off { color: var(--uart-ink-3); text-decoration: line-through; }
/* ── container-driven layout ──────────────────────────────────────────────
   Viewport media queries are wrong here: the console can live in a narrow
   floating window on a wide screen (or a wide panel on a narrow screen).
   ResizeObserver sets these classes from the ROOT element's own width. */
.uart-root.is-narrow .uart-body,
.uart-root.is-narrow .uart-body.is-monitor {
  grid-template-columns: minmax(0, 1fr) !important;
  grid-template-rows: auto auto minmax(0, 1fr);
}
.uart-root.is-narrow > .uart-body > .uart-grip { display: none; }
/* Narrow layout is ONE scrolling column, not a fixed three-row grid.
   A grid row sized to the leftover space clipped the parameter card as soon as
   the window got short ("高级参数" cut in half); letting the column scroll means
   the rail always keeps its natural height. */
.uart-root.is-narrow > .uart-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
/* Percentage max-height does not resolve against a flex container whose own
   height is content-driven, so the rail cap is a fixed 180px in narrow mode:
   the parameter form scrolls inside itself and the tape keeps the rest.
   min-height: 0 is required — the base rule pins min-height: max-content, and a
   min beats a max in CSS, which silently defeated this cap. */
.uart-root.is-narrow .uart-rail { overflow: auto; flex: 0 1 auto; max-height: 180px; min-height: 0; }
/* Only the rail keeps its natural height. The main column takes the leftover
   space and scrolls its tape internally — a fixed 420px floor made the send box
   fall out of the floating window as soon as frames arrived. */
.uart-root.is-narrow > .uart-body > .uart-rail { flex: 0 1 auto; }
.uart-root.is-narrow .uart-main { flex: 1 1 auto; min-height: 0; }
/* Short containers give the telemetry row's height back to the frame tape. */
.uart-root.is-short .uart-tape-meta { display: none; }
.uart-root.is-narrow .uart-port-group { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); align-items: end; }
.uart-root.is-narrow .uart-port-group > .uart-group-title,
.uart-root.is-narrow .uart-port-group > .uart-advanced { grid-column: 1 / -1; }
.uart-root.is-narrow .uart-port-group > .uart-button.is-block { grid-column: 1 / -1; }
/* Baud + encoding are a 2-up pair: give the pair its own full-width row instead
   of letting both squeeze into one 120px grid cell (that clipped "115200"). */
.uart-root.is-narrow .uart-port-group > .uart-row2 { grid-column: 1 / -1; }
/* The port picker is the primary field: always its own full-width row. */
.uart-root.is-narrow .uart-port-group > .uart-port-field { grid-column: 1 / -1; }
.uart-root.is-narrow .uart-signal-group { display: none; }
.uart-root.is-tight { padding: 12px; }
/* Too small to lay out: keep a usable content width and let the host scroll it
   horizontally, so a squeezed panel stays reachable instead of being cut. */
.uart-root.is-tiny {
  padding: 8px;
  gap: 8px;
  overflow-x: auto;
  overflow-y: hidden;
}
.uart-root.is-tiny > .uart-header,
.uart-root.is-tiny > .uart-banner,
.uart-root.is-tiny > .uart-body { min-width: 420px; }
.uart-root.is-tiny .uart-main { min-height: 180px; }
.uart-root.is-tiny .uart-tabs { flex-wrap: wrap; }
.uart-root.is-tiny { scrollbar-width: thin; scrollbar-color: var(--uart-border-strong) transparent; }
.uart-root.is-tiny::-webkit-scrollbar { height: 9px; width: 9px; }
.uart-root.is-tiny::-webkit-scrollbar-thumb { background: var(--uart-border-strong); border-radius: 5px; }
.uart-root.is-tiny::-webkit-scrollbar-track { background: transparent; }
.uart-root.is-tight .uart-frame { grid-template-columns: 72px 30px 38px minmax(0, 1fr) minmax(0, 120px); padding-right: 8px; }
.uart-root.is-tight .uart-tabs { order: 3; }
.uart-root.is-tight .uart-step { grid-template-columns: 14px minmax(0, 1fr) 64px 46px; }
.uart-root.is-tight .uart-step-title { display: none; }
.uart-root.is-tight .uart-cmd { grid-template-columns: minmax(0, 1fr) auto auto; }
.uart-root.is-tight .uart-cmd-title { display: none; }
`
