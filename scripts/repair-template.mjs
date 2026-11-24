/**
 * One-shot repair of dsh-plugin/client.template.js.
 *
 * A PowerShell round-trip decoded the file as GBK and re-encoded it as UTF-8,
 * which mangled every non-ASCII literal (and ate a few closing quotes). The
 * ASCII structure survived, so each damaged line is replaced by its correct
 * text here rather than reconstructing the whole file.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
let text = readFileSync(path, 'utf8')

// 1. Clean the mojibake that only appears in comments. Literal replacements
//    only: a regex like /鈥?/ treats "?" as a quantifier and eats the file.
const commentFixes = [
  ['鈥斺€?', '—'],
  ['鈥?', '—'],
  ['鈹€', '─'],
  ['鈫?', '→'],
  ['鉁?', '✕'],
  ['路', '·'],
  ['脳', '×'],
]
for (const [from, to] of commentFixes) text = text.split(from).join(to)

const lines = text.split('\n')

/** 1-based line number -> replacement text. */
const fixes = {
  35: "    const zh = { nav: '串口', title: '串口调试', float: '悬浮窗', dock: '停靠到工作区', close: '关闭', parkedTitle: '串口控制台在悬浮窗中', parkedBody: '关闭悬浮窗，或点「停靠到工作区」把控制台放回这里。', openFloat: '打开悬浮窗', settingsTitle: '串口控制台', settingsBody: '选择控制台显示的位置。改动会立即生效，并记住到下次启动。', optionPanel: '工作区面板', optionPanelBody: '控制台占用串口面板的主区域。', optionFloat: '悬浮球', optionFloatBody: '右下角显示一个串口圆球：鼠标碰上去展开成胶囊，点击展开完整控制台。', optionDockChip: '底栏状态条', optionDockChipBody: '在输入框下方显示一行串口状态（连接、波特率、帧率），点「展开」以悬浮窗打开控制台。', optionDockFollow: '自动滚到最新', optionDockFollowBody: '底栏预览有新数据时自动滚到底部；向上翻看旧数据时暂停，滚回底部后恢复。', decodeTitle: '数据解码', decodeBody: '底栏预览按这个偏好显示接收数据；编码只影响显示，不会重连串口。', decodeAuto: '自动', decodeText: '文本', decodeHex: 'HEX', optionCurrent: '当前' }",
  423: "      const label = zhLocale ? 'UART 串口' : 'UART serial'",
  460: "          h('span', { style: { fontSize: '12px' } }, '›'),",
  470: "          title: zhLocale ? 'UART 串口 — 点击打开控制台' : 'UART serial — click to open the console',",
  524: "          h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '›'),",
  639: "          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, zhLocale ? '串口调试' : 'Serial console'),",
  641: "          h(LinkButton, { onClick: dock, title: zhLocale ? '停靠到工作区' : 'Dock to panel' }, zhLocale ? '停靠' : 'Dock'),",
  642: "          h(LinkButton, { onClick: collapse, title: zhLocale ? '收起为右下角圆球' : 'Collapse to the orb' }, '×'),",
  655: "          domAction(zhLocale ? '悬浮窗' : 'Float', zhLocale ? '在悬浮窗中打开' : 'Open in a floating window', () => setMode('float')),",
  660: "      if (mode === 'float') {",
  670: "              { style: { fontSize: '13px', fontWeight: 600 } },",
  671: "              zhLocale ? '控制台已收起为右下角圆球' : 'The console is collapsed into the orb at the bottom right',",
  676: "              zhLocale ? '点右下角圆球展开控制台；也可以直接停靠回这里。' : 'Click the orb at the bottom right to open it, or dock it back here.',",
  698: "              zhLocale ? '停靠到工作区' : 'Dock to panel',",
  798: "          label: active ? `${active.config?.path ?? ''} · ${active.config?.baudRate ?? ''}` : zhLocale ? '未连接' : 'not connected',",
  842: "          setStatus({ connected: false, label: zhLocale ? '未连接' : 'not connected', rate: 0 })",
  907: "              label: active ? `${active.config?.path ?? ''} · ${active.config?.baudRate ?? ''}` : zhLocale ? '未连接' : 'not connected',",
  911: "            if (!stopped) setStatus({ connected: false, label: zhLocale ? 'Hub 离线' : 'hub offline', rate: 0 })",
  970: "              h('span', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, zhLocale ? '串口接收' : 'Serial receive'),",
  982: "                    zhLocale ? '断开' : 'Disconnect',",
  984: "                : h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, zhLocale ? '未连接' : 'Offline'),",
  1000: "                    ports.length === 0 ? h('option', { value: '' }, zhLocale ? '没有可用串口' : 'No port') : null,",
  1031: "                    busy ? (zhLocale ? '连接中…' : 'Connecting…') : zhLocale ? '连接' : 'Connect',",
  1050: "                ? h('div', { style: { padding: '14px 12px', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' } }, zhLocale ? '还没有接收数据' : 'No data yet')",
  1064: "              h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, zhLocale ? '解码' : 'Decode'),",
  1081: "                  value === 'auto' ? (zhLocale ? '自动' : 'Auto') : value === 'text' ? (zhLocale ? '文本' : 'Text') : 'HEX',",
  1088: "                zhLocale ? '打开面板' : 'Open panel',",
  1122: "              title: zhLocale ? '查看最近的接收数据' : 'Recent received data',",
  1131: "            { onClick: toggle, title: zhLocale ? '以悬浮窗打开控制台' : 'Open the console as a floating window' },",
  1132: "            zhLocale ? '展开' : 'Expand',",
  1134: "          h(LinkButton, { onClick: goPanel, title: zhLocale ? '打开工作区面板' : 'Open the workspace panel' }, zhLocale ? '面板' : 'Panel'),",
}

// Lines that must disappear entirely (the removed dock placement action and the
// inDock branches that belonged to the old inline console).
const drop = new Set([656, 661, 677, 678])

for (const [key, value] of Object.entries(fixes)) {
  lines[Number(key) - 1] = value
}
const result = lines.filter((_, index) => !drop.has(index + 1))

writeFileSync(path, result.join('\n'))
console.log(`repaired ${Object.keys(fixes).length} lines, dropped ${drop.size}`)
