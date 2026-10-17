import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStartupPageHtml } from '../lib/types/electron/startup-page.js'

/**
 * Executes the rendered player's inline script against a minimal fake DOM and a
 * fake `corumDesktop` bridge, then drives it the way the host does.
 *
 * Regex assertions on the template string are cheap but weak — they pass even if
 * the logic is wired up wrong. Running the script catches the failures that
 * actually matter: a looping segment being killed by its own duration watchdog, a
 * segment never advancing, or `finishStartup` never being called.
 */

/** Minimal DOM + video element sufficient for the player. */
function makeEnv() {
  const timers = new Map()
  let nextTimer = 1
  const calls = { finish: 0, retry: 0, closePreview: 0 }
  const videos = []

  class FakeVideo {
    constructor() {
      this.listeners = {}
      this.paused = true
      this.muted = true
      this.loop = false
      this.duration = 3
      this.currentTime = 0
      // 真实 <video> 的 src 是访问器：赋新值会中止正在进行的加载与 play。
      // 用普通属性赋值就模拟不出「换 src 打断 play()」这个关键行为，
      // 而它正是 2026-10-17「主题无法播放」报障的触发条件。
      this._src = ''
      videos.push(this)
    }
    get src() {
      return this._src
    }
    set src(value) {
      if (this._src !== '' && this._src !== value) this.interrupt()
      this._src = value
    }
    addEventListener(type, fn) {
      ;(this.listeners[type] ??= []).push(fn)
    }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn)
    }
    emit(type) {
      for (const fn of this.listeners[type] ?? []) fn({ type })
    }
    play() {
      this.__playCalls = (this.__playCalls ?? 0) + 1
      // 真实行为（2026-10-17 在 Electron 43 实测）：若在一次 play() 尚未 settle 时
      // 又换了 src，上一次 play() 会以 AbortError 拒绝。这里必须模拟出来，
      // 否则「把 AbortError 当致命错误」这个 bug 在测试里永远抓不到。
      if (this.pendingPlay !== undefined) {
        const previous = this.pendingPlay
        this.pendingPlay = undefined
        previous.reject(Object.assign(new Error('The play() request was interrupted'), { name: 'AbortError' }))
      }
      this.paused = false
      // Real players fire loadedmetadata then playing; emulate that order.
      queueMicrotask(() => {
        this.emit('loadedmetadata')
        this.emit('playing')
        // 'playing' 到达 = 真正开始播 = play() promise 兑现。
        if (this.pendingPlay !== undefined) {
          const settled = this.pendingPlay
          this.pendingPlay = undefined
          settled.resolve()
        }
      })
      // 真实语义：play() 的 promise 在「开始播放」后才 resolve，而不是立刻。
      // 若这里用 microtask 马上 resolve，AbortError 就永远来不及发生 ——
      // 「换 src 打断 play」这个 bug 也就抓不到（本测试最初正是这么漏掉的）。
      // 所以在 'playing' 事件里 settle。
      return new Promise((resolve, reject) => {
        this.pendingPlay = { resolve, reject }
      })
    }
    /** 模拟「换 src 打断上一次 play」（真实浏览器必然如此）。 */
    interrupt() {
      if (this.pendingPlay === undefined) return
      const previous = this.pendingPlay
      this.pendingPlay = undefined
      previous.reject(Object.assign(new Error('interrupted'), { name: 'AbortError' }))
    }
    pause() {
      this.paused = true
    }
    removeAttribute() {}
    load() {}
    remove() {}
  }

  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: '',
        hidden: false,
        disabled: false,
        listeners: {},
        addEventListener(type, fn) {
          ;(this.listeners[type] ??= []).push(fn)
        },
        append() {},
        remove() {},
      })
    }
    return elements.get(id)
  }

  const statusHandlers = []
  const fakeDocument = {
    getElementById: element,
    createElement: (tag) => {
      if (tag === 'video') return new FakeVideo()
      return {
        style: {},
        setAttribute() {},
        addEventListener() {},
        append() {},
        remove() {},
      }
    },
    addEventListener() {},
  }

  const bridge = {
    finishStartup: () => {
      calls.finish++
    },
    retryStartup: () => {
      calls.retry++
    },
    closeStartupPreview: () => {
      calls.closePreview++
    },
    onStartupStatus: (cb) => {
      statusHandlers.push(cb)
      return () => {}
    },
    getStartupStatus: () => Promise.resolve(undefined),
  }

  const fakeWindow = {
    corumDesktop: bridge,
    addEventListener() {},
  }

  const fakeSetTimeout = (fn, ms) => {
    const id = nextTimer++
    timers.set(id, { fn, ms })
    return id
  }

  return {
    /** Values the player script sees as globals. */
    sandbox: {
      document: fakeDocument,
      window: fakeWindow,
      matchMedia: () => ({ matches: false }),
      setTimeout: fakeSetTimeout,
      clearTimeout: (id) => timers.delete(id),
      requestAnimationFrame: () => 0,
      queueMicrotask,
      Promise,
      console,
      JSON,
      Number,
      Math,
      Date,
      Object,
      Array,
      String,
      Boolean,
      Error,
    },
    videos,
    calls,
    statusHandlers,
    log: [],
    timers,
    /** Fire every pending timer whose delay is <= `ms` (and mark the rest). */
    fireTimersAtLeast(ms) {
      for (const [id, t] of [...timers]) {
        if (t.ms >= ms) {
          timers.delete(id)
          t.fn()
        }
      }
    },
    pendingDelays: () => [...timers.values()].map((t) => t.ms),
    restore() {},
  }
}

// 夹具必须含**至少两个加载段**，否则「换 src 打断上一次 play」无法复现。
//
// 2026-10-17：`spawn` 段已并入 `env`（环境检查几乎瞬时完成），所以真实启动不再
// 出现「同一 tick 连发」。但换段打断 play 的 AbortError 仍可能出现（异常路径、
// 阶段快速推进），因此保留两段夹具来守住该防御逻辑。
// 早先这份夹具只列 env/mounting/ready 之外的组合时，playSegment 因 !seg 直接
// return，连续换段从未被模拟，AbortError 也就永远抓不到。
const SEGMENTS = [
  { stage: 'env', file: 'segments/env.mp4' },
  { stage: 'plugins', file: 'segments/plugins.mp4' },
  { stage: 'mounting', file: 'segments/mounting.mp4' },
  { stage: 'ready', file: 'segments/ready.mp4' },
]

/** Render + execute the player for a segment theme. */
async function boot({ preview = false, animationEnabled = true } = {}) {
  const html = renderStartupPageHtml({
    theme: { id: 'corum-segments', type: 'video', builtin: false, segments: SEGMENTS },
    animationEnabled,
    preview,
    platform: 'darwin',
  })
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  const env = makeEnv()
  // Each boot gets its own VM context: the player declares `const` at top level,
  // so re-running it in a shared global scope would throw
  // "Identifier 'config' has already been declared".
  const { createContext, runInContext } = await import('node:vm')
  const context = createContext(env.sandbox)
  runInContext(script, context, { filename: 'player.js' })
  return { env, html, statusHandlers: env.statusHandlers, calls: env.calls }
}

/** Let the player's microtasks (and our fake `playing` event) run. */
const flush = () => new Promise((r) => realSetTimeout(r, 0))
const realSetTimeout = globalThis.setTimeout.bind(globalThis)

test('分段播放器：加载段真的被设为循环，ready 段不循环', async () => {
  const { env, statusHandlers } = await boot()
  try {
    statusHandlers[0]({ phase: 'loading', stage: 'env' })
    await flush()
    assert.equal(env.videos.length, 1, 'one reused <video> element')
    const v = env.videos[0]
    assert.equal(v.loop, true, 'env must loop')
    assert.equal(v.muted, true, 'loading segments stay muted')

    statusHandlers[0]({ phase: 'ready' })
    await flush()
    assert.equal(v.loop, false, 'ready must NOT loop')
    assert.equal(env.videos.length, 1, 'still reusing the same element')
  } finally {
    env.restore()
  }
})

test('分段播放器：循环段播放中不保留 duration 看门狗（否则会误判失败）', async () => {
  const { env, statusHandlers } = await boot()
  try {
    statusHandlers[0]({ phase: 'loading', stage: 'env' })
    await flush()
    // After metadata + playing, no duration-based failure timer may remain for a
    // looping segment. A 15s "did it load" timer is fine; 3s+10s is not.
    const delays = env.pendingDelays()
    assert.ok(
      !delays.some((d) => d >= 13 && d <= 14),
      `no duration watchdog for a looping segment, got ${JSON.stringify(delays)}`,
    )
  } finally {
    env.restore()
  }
})

test('分段播放器：ready 段 ended 才收尾，加载段 ended 不收尾', async () => {
  const { env, calls, statusHandlers } = await boot()
  try {
    statusHandlers[0]({ phase: 'loading', stage: 'env' })
    await flush()
    env.videos[0].emit('ended')
    assert.equal(calls.finish, 0, 'a loading segment ending must not finish boot')

    statusHandlers[0]({ phase: 'ready' })
    await flush()
    env.videos[0].emit('ended')
    assert.equal(calls.finish, 1, 'ready ending must finish boot exactly once')
  } finally {
    env.restore()
  }
})

test('分段播放器：ready 段解除静音（琶音）', async () => {
  const { env, statusHandlers } = await boot()
  try {
    statusHandlers[0]({ phase: 'loading', stage: 'mounting' })
    await flush()
    assert.equal(env.videos[0].muted, true)

    statusHandlers[0]({ phase: 'ready' })
    await flush()
    assert.equal(env.videos[0].muted, false, 'ready segment plays its arpeggio')
  } finally {
    env.restore()
  }
})

test('分段播放器：预览时全部不循环且静音', async () => {
  const { env, html } = await boot({ preview: true })
  try {
    assert.match(html, /"preview":true/)
    await flush()
    // Preview auto-starts the first segment.
    assert.ok(env.videos.length >= 1)
    for (const v of env.videos) {
      assert.equal(v.loop, false, 'preview must not loop')
      assert.equal(v.muted, true, 'preview stays muted')
    }
  } finally {
    env.restore()
  }
})

test('分段播放器：关闭动画时直接收尾，不创建 video', async () => {
  const { env, calls } = await boot({ animationEnabled: false })
  try {
    await flush()
    assert.equal(env.videos.length, 0, 'no media when the animation is disabled')
    assert.equal(calls.finish, 1, 'boot proceeds immediately')
  } finally {
    env.restore()
  }
})

test('分段播放器：连续换段（换 src 打断 play）不得报「主题无法播放」', async () => {
  // 2026-10-17 的实机报障：启动时两个阶段几乎同一 tick 到达，playSegment 连续换
  // 两次 src；前一段的 play() promise 以 AbortError 拒绝，旧代码
  // `video.play().catch(mediaError)` 把它当致命错误 → 整段动画被跳过并显示
  // 「主题无法播放」。合并 env/spawn 后正常路径不再连发，但该防御仍需守住。
  const { env, statusHandlers } = await boot()
  try {
    const v = env.videos.at(0) ?? null
    statusHandlers[0]({ phase: 'loading', stage: 'env' })
    // 不 await：模拟同一 tick 内下发下一个阶段（换 src 打断上一次 play）
    statusHandlers[0]({ phase: 'loading', stage: 'plugins' })
    await flush()
    // 关键断言：没有触发收尾（mediaError -> stopAnimation -> finishStartup）
    assert.equal(env.calls.finish, 0, 'AbortError 不应让启动动画提前收尾')
    // 且视频仍在播（没被 releaseMedia 清掉）
    assert.ok(env.videos.length >= 1, 'video 元素不应被释放')
    const last = env.videos.at(-1)
    assert.equal(last?.paused, false, '换段后应当继续播放')
  } finally {
    env.restore()
  }
})

test('分段播放器：陈旧段事件不得替新段解绑兜底（按 epoch 丢弃）', async () => {
  // 场景：env 已换到 plugins，此时 env 的迟到 loadedmetadata 仍会触发。
  // 若不加 epoch 校验，回调会用**新段**的 duration/loop 去操作 watchdog，
  // 等于让上一段的事件替新段做决定。
  //
  // 判据不能是「15s 兜底还在」——新段真的播起来之后，onSegPlaying 本就会清掉它
  // （那是设计）。所以这里改为断言：陈旧事件不会造成任何状态变化，
  // 即没有触发收尾、也没有改动定时器状态。
  const { env, statusHandlers, calls } = await boot()
  try {
    statusHandlers[0]({ phase: 'loading', stage: 'env' })
    statusHandlers[0]({ phase: 'loading', stage: 'plugins' })
    await flush()
    const v = env.videos.at(-1)
    const before = env.pendingDelays().slice().sort()
    v.emit('loadedmetadata')   // env 的迟到事件
    v.emit('playing')          // 旧段的迟到 playing
    await flush()
    const after = env.pendingDelays().slice().sort()
    // 陈旧事件不应新增任何定时器（尤其是 duration+10s 那种）
    assert.deepEqual(after, before, '陈旧事件不应改动定时器状态')
    assert.equal(calls.finish, 0, '陈旧事件不应导致收尾')
    assert.equal(v.paused, false, '播放不应被打断')
  } finally {
    env.restore()
  }
})

