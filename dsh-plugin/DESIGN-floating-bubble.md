# 设计规格：串口悬浮球（三态浮窗）

> 状态：**已实现**（2026-11-20）。实现落在 `dsh-plugin/client.template.js`，
> `dsh-plugin/client.js` 由 `npm run build` 生成。`src/hub/public/uart-ui.js`
> 与 Host 半未改动。
>
> 实现备注：
> - 悬停用 `onPointerEnter/Leave`（200ms 延迟收回）；点击/拖动用
>   `onPointerDown` + window 级 `pointermove/up`，4px 死区分流。
> - 胶囊展开时若贴近右边缘，向右展开会溢出，已改为**贴右边对齐**（`displayX`）。
> - 拖动写入的是拖动过程中记录的最后一帧坐标（`start.current`），不是
>   render 时的 ref —— 否则 React 批处理会导致存到旧位置。
> - 完整窗只剩「停靠」「×」两个动作：× = 收起为圆球；「—」折叠态已移除。
>
> 第二轮修正（2026-11-20 下午）：
> - **动画**：只过渡 `width`，且展开时固定住"不动的那条边"（贴右就改锚
>   `right`），按钮不再从指针下方滑走 —— 之前 hover 抖动就是这个原因。
> - **Logo**：换成 D-sub 9 针剪影 `UartLogo`，颜色自带
>   `var(--dsw-alias-brand-primary, #1f6feb)` 兜底。
> - **缩窗**：浮动窗 `minWidth 380 / minHeight 240`，宿主窗口 resize 时重新
>   clamp；窄布局改为「body 可滚动 + main 最小 240px」，不再裁掉发送区。
> - **换行**：帧行 `align-items:start`，HEX / ASCII 各自 `white-space:pre-wrap`
>   + `overflow-wrap:anywhere`，长帧只在两列内部换行，不再互相挤到第二行。
> - **接管状态**：`ownsPort=false` 时显示琥珀色常驻条
>   「Agent 正在使用这条串口：面板只读监视，参数已锁定」+「停止监视（不关闭
>   Agent 的串口）」，顶部 chip 显示「Agent 接管」，避免"参数被莫名锁住"。

## 1. 目标

把现在的「一整块悬浮窗」改成参考 Visio 气泡的三段式：

```
平时        鼠标碰到        点击
圆球  ──▶  胶囊（含文字） ──▶  完整悬浮窗
 ▲                              │
 └──────── × / 收起 ───────────┘
```

- **圆球**：直径 44px，只显示串口波形图标，固定在右下角、可拖动。
- **胶囊**：悬停展开，显示图标 +「UART 串口」+ 展开箭头；移开 200ms 后收回圆球。
- **完整窗**：即现有 `FloatingWindow`（标题栏拖动、`resize:both`、`监视/Orchestrator`、HEX 等全部不变）。
- 完整窗的「×」改为**收回圆球**（现在的行为是"关闭并停靠回工作区"，要改）；「停靠」按钮仍回工作区面板。

## 2. 状态机

现有两段式保留并扩展一个子状态：

| 层 | 键 | 值 | 说明 |
|---|---|---|---|
| 显示位置 | `dsh-uart.display-mode` | `panel` \| `float` | 已有，不动 |
| 浮窗形态 | `dsh-uart.float-state`（新增） | `bubble` \| `window` | 默认 `bubble`，**持久化** |
| 瞬时悬停 | 不持久化 | `peek` | 仅 hover/focus 期间的视觉态 |

转移：

```
setMode('float') 从 panel/设置进入  →  float-state = 'bubble'   （不要直接弹大窗）
hover / focus 圆球或胶囊           →  peek（瞬时）
离开 200ms 且未点击                →  bubble
click 圆球/胶囊                    →  window（写 float-state='window'）
完整窗 × / 收起                    →  bubble（写 float-state='bubble'）
完整窗 停靠                        →  setMode('panel')，保留 float-state
```

- `peek` **绝不写 localStorage**，避免刷新后停在半展开态。
- 圆球位置单独存 `dsh-uart.bubble-pos`（默认右下），完整窗位置继续用已有的 `dsh-uart.float-rect`，两者互不覆盖。
- 现有 `PanelHost` 在 `mode==='float'` 时的占位文案改成「串口控制台已收起为右下角圆球」，按钮仍为「停靠到工作区」。

## 3. 视觉规格（用 DSH token，不写死颜色）

| 元素 | 规格 |
|---|---|
| 圆球 | 44×44，`border-radius:50%`，`--dsw-alias-bg-layer-1` 底，`1px --dsw-alias-border-l2` 边，`box-shadow:0 6px 20px rgba(0,0,0,.22)`，图标 `currentColor`、20px、`UartIcon` 现有 SVG |
| 圆球 z-index | 41（比现有窗口 40 高一级） |
| 胶囊 | 高 40px，`border-radius:999px`，`padding:0 14px`，gap 8px；图标 16px + 文字 12px/600 + 右侧 `›` 箭头；同一底色/边框/阴影 |
| 过渡 | `width / opacity / transform` 150ms ease；圆球→胶囊只做宽度与文字淡入，不要位移 |
| 完整窗 | 完全沿用现有 `FloatingWindow` 样式，不改 |
| 默认位置 | 右下避让：距右 24px、距底 96px（避开 DSH 右下角已有的 Visio 气泡与系统 toast），clamp 在视口内 |

## 4. 交互细则

1. **hover 展开**：`onPointerEnter` 立即 `peek`；`onPointerLeave` 用 200ms 延迟收回，进入胶囊时取消定时器（用一个 `useRef` 计时器）。
2. **点击 vs 拖动**：圆球可拖动，复用现有 `onPointerDown` 的 window 级 pointermove/pointerup 逻辑；**位移阈值 4px** —— 超过阈值判定为拖动，不触发展开；未超过且在 200ms 内抬起才触发 click → `window`。
3. **拖动后**写 `bubble-pos`；`clamp` 到视口（窗口 resize 时也要重新 clamp，用现有 `loadRect` 的思路）。
4. **键盘可达**：用 `<button>`，`aria-label="UART 串口"`、`aria-expanded`；`onFocus` 等价 hover 展开，Tab 移走回收；Enter/Space 展开。
5. **无 hover 的触摸设备**：`matchMedia('(hover: none)')` 时单击圆球**直接**展开完整窗（跳过胶囊），避免点两次。
6. **完整窗关闭**：标题栏 `×` → 回圆球；`—` 折叠按钮改为「收起为圆球」（与 × 同义）或保留折叠为 40px 条 —— 二选一，建议直接合并成「收起」，减少一个状态。
7. 完整窗展开时**圆球隐藏**（同一时刻只有一个入口），窗口收起后圆球回到记住的位置。

## 5. 必须规避的已知坑（重要）

之前几轮反复失败的根因，实现时务必遵守：

- **验证环境**：所有"验证通过"曾在独立 `dsh web` + headless Chrome 里跑，但用户实际用的是 **Electron 桌面版（`dsh-app://`）的 `main` 主区**，父容器是 shrink-to-fit flex，两者 CSS 不同。**必须在完全重启后的真实桌面版里验收**，独立实例不算数。
- **宽度**：`ConsoleMount` 的外层 div 必须 `width:'100%'; minWidth:0; flex:'1 1 auto'; alignSelf:'stretch'`；`.uart-root` 必须 `width:100%; min-width:0`。缺了就会重现"内容全挤左侧一条、右边空白"。
- **响应式**：断点用 `ResizeObserver` 观察**面板自身宽度**（`is-narrow <860` / `is-tight <620`），**不要**用视口 `@media` —— 悬浮窗 760px 宽处在 2149px 视口里，视口判断必然错。
- **模块加载**：Desktop 跑在 `dsh-app://`，**不能动态 `import()` ES 模块**（会报 `Failed to fetch dynamically imported module`）。共享 UI 必须由构建脚本内联进 `client.js`。
- **改完插件必须完全退出桌面版再启动**（用户既有规则，且有 profile `node_modules` 被 pnpm 锁住的 EPERM 问题）。

## 6. 涉及文件与改动点

| 文件 | 改动 |
|---|---|
| `dsh-plugin/client.template.js` | 新增 `BubbleOrb` 组件（圆球/胶囊/拖动/hover/focus/点击）、`FLOAT_STATE_KEY` 与 `BUBBLE_POS_KEY`、`FloatSlot` 按 `float-state` 渲染圆球或 `FloatingWindow`、`FloatingWindow` 的 × / 收起改为回圆球、`PanelHost` 占位文案、`zh/en` 字典、`UartSettingsSection` 的 `optionFloatBody` 文案 |
| `dsh-plugin/client.js` | **不要手改**，跑 `npm run build`（或 `npm run build:dsh`）由 `scripts/build-dsh-client.mjs` 生成 |
| `src/hub/public/uart-ui.js` | 不动（浏览器模式不受影响） |
| `dsh-plugin/index.js`、Host 半 | 不动 |

## 7. 验收清单

- [ ] `npm run build` 成功，`node --check dsh-plugin/client.js` 通过
- [ ] `npm test` 全绿；`node test/hub-contract-test.mjs <hub-url>` 通过
- [ ] **完全退出桌面版再启动**后：右下出现圆球
- [ ] 鼠标碰到 → 胶囊；移开 → 收回；点击 → 完整窗
- [ ] 完整窗 × → 回圆球；「停靠」→ 回工作区面板
- [ ] 圆球与完整窗都能拖动，位置刷新后保留
- [ ] 从「工作区面板 / 设置 → 悬浮窗」切换时**默认落成圆球**，不是大窗
- [ ] Tab/focus 可展开；触摸设备单击直接展开
- [ ] 独立 Hub 浏览器页、`监视/Orchestrator`、HEX 折叠、列宽拖动均不受影响
- [ ] 桌面版 `main` 面板下界面铺满、不再挤成左侧一条
