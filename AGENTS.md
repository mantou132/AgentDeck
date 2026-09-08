# Agent Rules

1. 遇到没有明确的事情不要自由发挥，应该询问确定。
2. 始终根据目的考虑代码，如果有更简洁的方案应该提出来。
3. 结构、入口或构建方式变化时同步更新本文件；只保留导航和必要约束，不记录实现细节。
4. 只处理有实际依据的场景；不为不会发生的情况增加防御逻辑或不必要的复杂度。

# 项目导航

- `src/`：Gem + Tap UI 前端；`elements/` 为公共自定义元素；`i18n.ts` 与 `locales/` 提供基于 `@mantou/gem` 的多语言。
- `src-tauri/`：Tauri 2 原生入口、配置和 Android / iOS 工程；Android `res/*/launch_*` 定义启动资源，`MainActivity.kt` 控制系统启动屏退出延迟；iOS `LaunchScreen.storyboard` / `LaunchIcon.imageset` 定义启动布局与图标。插件提供接续到页面 load 的原生启动层；更新应用图标时同步更新 LaunchIcon。
- `public/`：静态品牌资源；`relay-guide/` 为三步 Relay 指南插图。
- `test/`：Node 回归测试；`helpers/app-fixture.mjs` 提供使用实际 Relay SDK 的隔离环境。

关键入口：

- `src/main.ts` → `src/app.ts`：加载主题、挂载 App、启动 transport；未配置 Relay ID 时打开 settings，否则打开 list。
- `src/pages/`：session-list、session、settings 三页面；settings 提供 Relay 获取指南 sheet，首次未配对使用时自动展示一次；`src/navigation.ts` 提供 Stack 入口，通过 property 传递 sessionId。
- `src/state/store.ts`：单一全局状态与基础更新；`state/sessions.ts` 管理会话生命周期，`state/app.ts` 负责启动、设置、重置及 transport 消息消费；`state/modes.ts` 执行模式切换。
- `src/agent/`：transport 管理 Relay 连接与 host 握手，api 提供远端接口，rpc 负责双向流式通信；`src/config.ts` 保存配置读取与连接常量。
- `src/session/`：types 为会话类型，events 为 ACP reducer，groups / timeline 为列表与消息分组，turn 控制流式任务和权限决断，modes 只适配 ACP 模式信息。
- `src/elements/`：composer 管理输入和附件，session-timeline / process-detail 展示消息与过程，attachment / attachment-preview 展示附件；sheet.ts 封装弹层及内部 sheet-layer，通过 tap-reflect 映射到 body 并保留样式作用域；carousel 提供通用 CSS Scroll Snap 分页，relay-guide 提供三步指南图文；其余为目录、会话分组、权限和品牌组件。
- `src/composer/`：files 读取文件并检查限制，references 管理粘贴引用与编辑范围；`src/lib/`：Markdown、diff2html 输入转换与路径显示。
- `src/styles/`：tailwind.css 共享主题 token，theme.ts 桥接 Tap UI。
- `rsbuild.config.ts`、`postcss.config.js`：构建、自动导入与 Tailwind；内部 `deck-sheet-layer` 标签映射到 `sheet.ts`；`biome.json`：格式和 lint。

# 运行约束

- 新会话先建本地 draft，首次发送才远端 create；打开已有会话保留 close → load，手机端不能依赖页面卸载时 close。
- App 经 `relay-client-ts` 连接 Relay endpoint 2，browser4agent 使用 endpoint 1；地址见 `src/config.ts`，相关源码在 `~/relay`、`~/browser-mcp`。
- host 握手成功才算 connected。普通重连保留 SDK 消息状态；短请求有超时，prompt 不套相同的固定短时限。
- 异常必须保留重试或 settings 重置入口。重置重载文档并清理本地 Relay 消息状态，保留配对和设备标识；不删除远端历史，也不保证停止远端任务。
- Android identifier / namespace / applicationId / MainActivity package 保持 `com.mantou.agentdeck` 一致；对应 `src-tauri/tauri.conf.json`、`src-tauri/gen/android/app/build.gradle.kts` 和 `MainActivity.kt`。Rust library 为 `agentdeck_lib`。

# 前端开发

使用 Gem、Tap UI 和最新 ECMAScript；优先参考现有组件。

- `unplugin-gem` 自动导入 Gem 成员、Tap UI 和 `elements/*` 元素，无需手动导入；开发期 HMR 由插件处理，不配置 Gem helper `preEntry`。
- 布局优先 Tailwind utility，Shadow DOM 内不能使用。Light DOM 样式用 `:scope`，Shadow DOM 用 `:host`；通过 `css` / `@adoptedStyle` 共享样式，避免模板内联样式。
- 主题统一使用 `src/styles/tailwind.css` token 和 `src/styles/theme.ts`，不新增平行的应用级 CSS 变量。原生安全区变量继续局部使用。
- 保留 `patches/tailwindcss.patch` 对 Gem 元素的 Preflight 排除；`icons.loading` SVG 自带动画，不加额外旋转。
- 元素文件名为去前缀的标签名，继承 GemElement；使用 ES 装饰器，不使用已弃用的生命周期函数，也不额外声明自定义元素类型。
- 用 `@property` / attribute 装饰器定义输入；不要在元素内部修改输入，attribute 不赋默认值。内部数据用 `createState`，CSS 状态用 `@state`；优先使用 `#` 私有字段。
- `@memo` / `@effect` 用依赖数组控制执行，effect 返回清理函数；`@template` 定义模板，支持 `v-if`、ref 和属性展开。
- 全局状态用 `createStore` / `@connectStore`；事件用 `@emitter`，跨 Shadow DOM 冒泡用 `@globalemitter`；part / slot 用静态装饰字段。

### Gem Syntax Example

```ts
// 如果需要全局状态，就可以创建一个 Store
// 也许是从其他模块中导入的
const store = createStore({
  globalCount: 1,
  text: '',
});

// 一个更新 Store 的函数，Store 即是个数据对象，也可以用来更新内容
// 一般和 Store 的定义写在模块中，也可能没有这样的函数，因为可以直接调用 `store({})` 更新
const addCount = () => store({ globalCount: store.globalCount + 1 });

// 创建一个给元素实例用的主题
// 当元素的样式基于元素的属性时使用这种方法
// 这是个特殊的主题，在应用到元素时他也是个装饰器，作用是用来反应元素属性的变化来更改主题值
const elementTheme = createDecoratorTheme({ color: 'red' });

// 用 `css` 创建 Gem 元素可挂载的样式表，可以使用 CSS 嵌套语法
// 只有元素通过 `@shadow` 定义成了 Shadow DOM，CSS 中才能使用 `:host`
// 否则使用 `:scope`，请注意区分它们的使用方法而不是简单的替换
// 不要在模板内写内联样式，以这种方式定义的样式可以共享，而且和 DOM 分离
// 如果项目定义了主题，CSS 规则值可以从主题读取
const style = css`
  :scope {
    display: block;
    color: ${theme.textColor};
  }
`;

// 复杂的元素，可以使用这个方案编写样式表，在模板中用 `style1.header` 来引用类名
const style1 = css({
  // `$` 表示 `:host` 或 `:scope`
  $: `
    font-size: small;
  `,
  content: `
    font-size: 24px;
    color: ${elementTheme.color};
  `,
});

// 自定义元素标签名，使用统一的 `dy` 命名空间
@customElement('dy-test')
// 将创建的样式表挂载到元素上，使用多次就可以挂载多个样式表
@adoptedStyle(style)
@adoptedStyle(style1)
// 将全局 store 链接到元素上，store 更新时驱动元素更新，使用多次就可以链接多个 store
@connectStore(store)
// 默认是 Light DOM，只有使用了 `@shadow()` 才是 Shadow DOM，参数是 `ShadowRootInit`
@shadow()
// 一般不需要使用，只有该元素的内容需要能被外部样式化时才使用
@light({ penetrable: true })
// 指定元素渲染不会阻塞主线程，如果这个元素需要一次渲染很多个实例，可以使用
@async()
// 用来指定元素的 ARIA 属性，加强元素的可访问性
@aria({ role: 'region' })
// 这里的元素类名，`Duoyun` 是 `dy` 的全称，后面要加 `Element`，类似原生 HTML 元素类名
class DuoyunTestElement extends GemElement {
  // 定义元素的 part，使用静态字段可以让外部引用 part 名称，不需要设置初始值，状态器会提供一个同名初始值
  static @part img: string;
  // 定义元素的 slot，和 `@part` 一样的原则
  static @slot content: string;
  // 指定一个称为 `src` 的 Attribute，当没有赋值时默认解析成空字符串
  @attribute src: string;
  // 指定一个称为 `count` 的 Attribute，但解析成数字，当没有赋值时默认解析成 `0`
  @numattribute count: number;
  // 指定一个称为 `show` 的 Attribute，但解析成布尔值，当没有赋值时默认解析成 `false`
  @boolattribute show: boolean;
  // 当 Attribute 不能表示的属性时用 Property 表示，由于用户可以不传递属性，所以总要处理为空的情况，更改时会触发元素重新渲染
  @property data?: {};
  // 定义了一个 `display-content` 事件，直接调用触发，参数是自定义事件的 `detail` 属性
  // 只需要指定类型，类型中的参数是自定义事件的 `detail` 属性，`this.displayContent(true)` 触发
  // 很多时候传递数据，就使用 `null` 占位
  // `@globalemitter` 可以穿透 ShadowDOM 进行冒泡
  @emitter displayContent: Emitter<boolean>;
  // 定义 CSS 状态，仅仅是用来供外部 CSS 选择器使用，例如 `dy-test:state(open)`
  // 修改方法：`this.open = true`，没有特别的限制
  @state open: boolean;

  // 创建一个 { value?: HTMLImageElement } 对象，用来访问 DOM
  #imgRef = createRef<HTMLImageElement>();
  // 创建一个内部状态对象，`this.#state({ ... })` 来更新状态
  // 元素内部不应该更新元素的 Attribute/Property，就像原生元素一样
  // 注意和 CSS 状态 `@state` 无关
  #state = createState({ internalCount: 1 });

  // Attribute 不要赋初始值，因为 DOM 序列化会多出以内容，如果需要默认值，可以定义一个 `getter`
  // Property 可以赋初始值，但也可以同样用 `getter`
  get #src() {
    return this.src || 'test';
  }

  // 一些复杂计算可以使用 `@memo`，他的参数是一个函数，参数是当前实例，返回一个依赖数组
  // 在元素每次渲染前执行，只有依赖数组有更改时才会执行函数内容
  // 基于 `@memo` 实现了 `@willMount`
  @memo((i) => [i.src])
  get #text() {
    return i.src.repeat(10);
  }

  // 每次渲染后的副作用，参数和 `@memo` 一样，没有参数时每次都执行
  // 返回的函数会作为清理函数，在下次调用前执行
  // 类似 React 的 `useLayoutEffect`
  // 基于 `@effect` 实现了 `@mounted` `@unmounted`
  @effect()
  #print = () => {
    console.log('updated');
    return () => console.log('clear');
  }

  // `@template` 指定模板渲染函数，参数是一个条件函数，可以为不同条件指定不同渲染内容
  // 不提供条件函数时直接认为满足条件
  @template()
  #content = () => {
    const imgProps = { dataTest: 1 };
    // 模板语法基于 lit-html，添加了 Vue 的 `v-if` 语法、Ref 语法和剩余属性语法
    // 必要时候使用 `classMap` `styleMap` `partMap` `exportPartsMap`
    return html`
      <img ${this.#imgRef} ${imgProps} src=${this.#src} part=${DuoyunTestElement.part} />
      <div class=${classMap({ div: true })} v-if=${this.show}>Show</div>
      <div v-else class=${style1.content} style=${styleMap({ fontSize: '10px' })}>None</div>
    `;
  }

  // 当元素更新后，会根据依赖是否变化重新计算主题，不提供依赖函数则每次更新都更新主题
  @elementTheme((i) => [i.show])
  #updateTheme = () => ({ color: this.show ? 'red' : 'blue' });

  // 渲染出错时的后备内容，只有可能会渲染出错时才需要提供后备模板内容
  @fallback()
  #errorContent = (err) => {
    return html`Error: ${err}`;
  }

  // Gem 元素使用 ES 装饰器定义特性，装饰器本身就完整的表示了意义，所以不需要额外写自定义元素声明
  // Gem 元素不要使用生命周期函数，应该使用各种装饰器装饰普通函数，生命周期已经弃用了!!!
  // 应该尽量使用 ES 私有字段（`#aaa`）来替代类方法，这样没有 `this` 指向的问题
}

```

# 常用命令

- `pnpm run dev`：开发预览；`pnpm run build`：前端构建。
- `pnpm run check`：类型检查；`pnpm test`：回归测试。
- `pnpm run lint:check`：只检查；`pnpm run lint`：检查并修复。Husky pre-commit 的 lint-staged 仅检查暂存文件。
- `pnpm run tauri dev` / `pnpm run tauri android dev`：原生开发。
- `cargo check --manifest-path src-tauri/Cargo.toml`：Rust 检查。
- `pnpm tauri icon public/agentdeck-icon.png`：重建平台图标。
