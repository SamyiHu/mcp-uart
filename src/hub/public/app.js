/**
 * Standalone Hub page bootstrap — the browser carrier.
 *
 * The console itself is `uart-ui.js`, the same module the DSH panel mounts
 * through the /uart proxy. This file only picks a locale and starts it.
 */
import { createUartUi } from './uart-ui.js'

const root = document.getElementById('uart-app')
const locale = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
createUartUi({ root, apiBase: './', locale })
