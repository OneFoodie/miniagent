# 配置菜单改版：左下角入口 + 居中弹窗

日期：2026-09-27
状态：设计待确认
关联：[UI 配置菜单设计](./2026-09-27-ui-config-menu-design.md)（本文改的是它的入口形态与容器）

## 1. 需求

1. 配置入口从顶栏挪到**左下角**；
2. 点开后不再是从按钮下方展开的下拉面板，而是在**界面正中弹窗**显示，**宽高自适应**。

现状：`#configBtn` 在顶栏 `.topbar-right` 里，`#configPanel` 是 `.config-wrap` 内部
`position: absolute; top: calc(100% + 10px); right: 0; width: 430px` 的下拉面板
（`styles.css` 的 `.config-panel`）。

## 2. 为什么值得改

配置项已经长到 18 个字段、分 5 组，还多了一块「已放行的命令」列表（含逐条撤回按钮）。
430px 宽、`max-height: 70vh` 的下拉里，用户要在滚动中找字段，而面板顶部还贴着顶栏——
小屏上直接吃掉半屏。弹窗给了它一个真正属于内容的容器：宽度按视口给，高度按内容给，滚动只发生在中间。

## 3. 交互

| 动作 | 结果 |
|---|---|
| 点左下角按钮 | 打开弹窗，内容区加载中 → 渲染配置 |
| 点右上角 × | 关闭 |
| 按 `Esc` | 关闭 |
| 点遮罩（弹窗外的暗色区域） | 关闭 |
| 关闭 | `body` 的滚动锁解除，焦点还给左下角按钮 |

已确认的形态：

- 左下角是一个**固定悬浮按钮**（`.config-fab`），图标 + 「配置」文字；`≤640px` 收成纯图标圆钮。
- 弹窗**居中**，`width: min(960px, 100%)`（遮罩带 24px padding，等价于 `100vw - 48px`），`max-height: min(86vh, 100%)`。
- 遮罩带轻微模糊与半透明黑，点击遮罩即关闭。

## 4. 尺寸自适应

宽：

```
width: min(960px, 100%);
```

`100%` 指的是遮罩的内容盒宽度。遮罩自己有 `padding: 24px`，所以它等价于 `calc(100vw - 48px)`；
窄屏媒体查询把 padding 归零后它自动变成 `100vw`，不需要再写一个断点。

高：

```
max-height: min(86vh, 100%);
```

同理，`100%` = 视口高 − 48px。内容少时按内容高度撑开，不撑满。

结构上用 flex 三段，**滚动只发生在中间那段**：

```
.modal                 display: flex; flex-direction: column;
  .modal-head          flex: 0 0 auto;      /* 标题 + 关闭按钮，常驻 */
  #configPanel         flex: 1 1 auto; overflow-y: auto; min-height: 0;
```

`min-height: 0` 不能省：flex 子项的默认 `min-height: auto` 会让它按内容撑开、
把自己顶出容器，于是滚动条出现在 `.modal` 上而不是内容区，`max-height` 形同虚设。
这是这套布局唯一容易踩的坑。

**实现时放弃的一条**：原打算把「保存并生效」那一行做成 `position: sticky; bottom: 0`。
写的时候发现该行在 DOM 里排在「管理令牌」输入框**之前**，sticky 固定在底部后，
后出现的令牌行会盖在它上面（后出现的兄弟节点绘制在上层），看起来像按钮被输入框压住。
改成把令牌行提前会牵动 `renderConfigPanel` 的渲染顺序，收益不值这个改动，
因此这一行就是普通流式排布，滚到底部去点——这是弹窗里本就正常的操作。

窄屏（`≤640px`）直接全屏化，比在手机上挤一个小窗更好用：

```
.modal-backdrop { padding: 0; }
.modal { width: 100%; max-height: 100dvh; height: 100dvh; border-radius: 0; }
```

## 5. 左下角与输入坞的关系

输入坞（`.dock`）在底部居中，宽屏下与左下角相隔很远。**窄屏（`≤900px`）时输入坞几乎占满宽度**，
会与悬浮按钮重叠，因此：

- `≤900px` 给 `.dock-wrap` 加 `padding-left`，为按钮让出约 62px；
- `≤640px` 按钮收成 40px 圆钮，让位宽度不变。

这是本次唯一的布局连带改动，写在样式里而不是靠 `z-index` 把按钮盖在输入框上——
盖上去会让左下角那一小块 textarea 点不到。

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `public/index.html` | 从 `.topbar-right` 移除 `.config-wrap`；在 `</main>` 后新增 `.config-fab`（`id` 仍是 `configBtn`）与 `.modal-backdrop > .modal > (.modal-head + #configPanel)` |
| `public/styles.css` | 新增 `.config-fab` / `.modal-backdrop` / `.modal` / `.modal-head` / `.modal-close`；改写 `.config-panel`（去掉绝对定位与固定宽度，改为 flex 内容区）；`.config-actions` 改 sticky；响应式段补窄屏规则 |
| `public/app.js` | `toggleConfigPanel()` 改为开关弹窗（含 `body` 滚动锁）；新增 `openConfigPanel()` / `closeConfigPanel()`（后者已存在，改为同时解锁滚动与还焦点）；删除「点击外部收起」的 document 监听与 `.config-wrap` 的 `stopPropagation` 兜底，改为遮罩点击 + `Esc` |

### 6.1 顺带删掉的 hack

`app.js` 现在有这么一行：

```js
configWrap.addEventListener("click", (event) => event.stopPropagation());
```

它拦掉面板内部点击，防止冒泡到 document 的「点外部收起」监听（原因见 [app.js](file:///d:/project/traecode/prj1/public/app.js) 里那段注释：
按钮在处理函数里同步替换了 `innerHTML`，导致 `contains(event.target)` 变 false，面板被误判为「点了外面」）。

改成弹窗后，收起条件从「点击不在 `.config-wrap` 内」变成「点击的目标正是遮罩本身」：

```js
configModal.addEventListener("click", (event) => {
  if (event.target === configModal) closeConfigPanel();
});
```

按钮把自己从 DOM 上摘掉也不再影响判断（被摘掉的是 `.modal` 的后代，`event.target` 仍然是那个按钮，
不等于遮罩），因此这个 hack 可以删掉——它要防的 bug 在新结构下不会发生。

## 7. 非目标

- **不动「历史」面板**：它继续留在顶栏，仍是点开的下拉。本次只改配置。
- **不改配置字段与接口**：`GET/PUT /api/config`、`/api/allowlist` 一律不变。
- **不重排配置项分组**：5 组与字段顺序保持原样，弹窗更宽只是让它们更好读。
- **不引入焦点陷阱**（focus trap）：弹窗内容全是表单与按钮，不做 Tab 循环锁定。
  `role="dialog"` + `aria-modal="true"` + 打开时聚焦、关闭时还焦点这三件事做到即可。
