/**
 * 模型配置页（点模型卡片进入）：品牌徽标卡头 + 容量（上下文/
 * 最大输出/思考模式）+ 能力（图片输入）+ 费用（缓存命中/未命中/输出）+ 连接
 * （API 地址/连通性测试）+ 底部（删除模型/取消/保存）。
 *
 * 写通路：per-model 字段写回 provider profile 的 models[]（settings/mutate set ops），
 * 费用写自建 pricing 字段，思考模式按协议族侦测档位。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ConfirmDialog } from '@corum/corum-ui-base/client'
import { messageOf } from './store.ts'
import type { ModelsSettingsStore, ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelCard } from './model-cards.ts'
import { formatCapacity, parseCapacity, readModel } from './model-profile.ts'
import { readModelThinking, declaredLevelsOf, piAiThinkingWrite, thinkingOptionsOf, KNOWN_LEVELS } from './reasoning.ts'
import { BrandLogo } from './brands.tsx'
import { useConnTest } from './useConnTest.ts'

import {
  BackRow, ConnResult, GlassButton, IconCpu, IconTrash, IconZap,
  SelectField, SettingGroup, SettingRow, StatusPill, Switch,
} from './controls.tsx'
import styles from './ModelsSection.module.css'

type Snapshot = ReturnType<ModelsSettingsStore['store']['getSnapshot']>

export function ModelConfigView({ card, state, api, schema, onBack, onChanged }: {
  card: ModelCard
  state: Snapshot
  api: ModelsWire
  schema: SettingsSchemaOperations
  onBack: () => void
  onChanged: () => void
}): ReactNode {
  const namespace = state.namespaces.get(card.settingsNs)
  const base = namespace === undefined
    ? { id: card.modelId, imageInput: card.imageInput }
    : readModel(schema, namespace, card.settingsPath, card.modelId)

  const [ctx, setCtx] = useState(formatCapacity(base.contextWindow))
  const [maxOut, setMaxOut] = useState(formatCapacity(base.maxTokens))
  const [image, setImage] = useState(base.imageInput)
  const [priceHit, setPriceHit] = useState(base.pricing?.cacheHit?.toString() ?? '')
  const [priceMiss, setPriceMiss] = useState(base.pricing?.cacheMiss?.toString() ?? '')
  const [priceOut, setPriceOut] = useState(base.pricing?.output?.toString() ?? '')
  // API 地址从 provider profile 读（自定义 provider 的 endpoint 存这里；
  // catalog 路由无此字段则空，连通测试走适配器默认地址）。
  const [baseURL, setBaseURL] = useState(() => {
    if (namespace === undefined) return ''
    const url = schema.getPath(namespace.value, [...card.settingsPath, 'baseURL'])
    return typeof url === 'string' ? url : ''
  })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const conn = useConnTest(api)
  // deepseek 官方路由（llm-deepseek 整节）：隐藏 BaseURL、连通测试走 catalog 目录。
  const isDeepSeekOfficial = card.settingsNs === 'llm-deepseek'

  if (namespace === undefined) {
    // fork（corum）：无 settingsNs 的 route provider（如 Ollama 本地模型），
    // 模型由本地引擎管理，无需在设置页配置——显示只读信息而非报错。
    if (card.settingsNs === '') {
      return (
        <div className={styles['section']}>
          <BackRow onBack={onBack} />
          <div className={styles['card']}>
            <span className={styles['cardHead']}>
              <span className={styles['cardHeadLeft']}>
                <BrandLogo brand={card.brand} size={34} fallback={<IconCpu size={17} />} />
                <span className={styles['cardHeadTitle']}>
                  <span className={styles['cardName']}>{card.modelId}</span>
                  <span className={styles['cardDesc']}>本地模型 · 由 Ollama 引擎管理</span>
                </span>
              </span>
              <span className={styles['cardHeadRight']}>
                <StatusPill tone="success" label="已就绪" />
              </span>
            </span>
          </div>
          <SettingGroup title="基本信息">
            <SettingRow label="供应商" desc="本地推理引擎" control={<span style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)' }}>{card.providerName}</span>} />
            <SettingRow label="思考模式" desc="Ollama 支持 关闭/low/medium/high/max 五档思考。在 Agent 预设编辑页选择模型后可设置思考程度。" control={
              <SelectField
                value="off"
                options={[
                  { id: 'off', label: '关闭思考' },
                  { id: 'low', label: 'low · 轻量思考' },
                  { id: 'medium', label: 'medium · 标准思考' },
                  { id: 'high', label: 'high · 深度思考' },
                  { id: 'max', label: 'max · 最大思考' },
                ]}
                onChange={() => {}}
              />
            } />
            <SettingRow label="配置说明" desc="本地模型无需 API 密钥、无需配置端点。激活后在 Agent 预设中可选为驱动模型。" divider={true} control={<span />} />
          </SettingGroup>
        </div>
      )
    }
    return (
      <div className={styles['section']}>
        <BackRow onBack={onBack} />
        <p className={styles['error']}>{card.provider}: 无法解析设置命名空间。</p>
      </div>
    )
  }

  // 思考模式：按单个模型读档位（不翻译）。侦测到→该模型真实档位下拉；
  // 侦测不到→固定档 valuelist（off/low/medium/high/xhigh/max）下拉 + 「自定义…」入口（方案 C）。
  const modelThinking = readModelThinking(schema, namespace, card.settingsPath, card.modelId, card.family, card.provider)
  const [thinking, setThinking] = useState(modelThinking.current)
  const [customThinking, setCustomThinking] = useState('')
  // 仅当用户已配置了一个不在档位集合里的自定义档时，才默认进自定义输入框回显。
  const [showCustomThinking, setShowCustomThinking] = useState(
    !modelThinking.levels.includes(modelThinking.current) && modelThinking.current !== 'off',
  )
  /**
   * 该模型实际支持的档位集合（用户勾选；选择器的「推理等级」子面板就渲染这一集合）。
   *
   * 初值优先级（用户 2026-09-29 定调「pi-ai 的表是兜底，档位由用户设置」）：
   *   ① 用户已显式声明过 `reasoningEfforts` → 原样回显（**不补 off**，见 declaredLevelsOf）；
   *   ② 否则用侦测结果（catalog 表 → 兜底固定档）作**预勾选建议**，用户可改；
   * 保存时一律以本集合落盘 `reasoningEfforts`（用户表达优先，表只是默认建议）。
   */
  const [levels, setLevels] = useState<readonly string[]>(() => {
    const declared = declaredLevelsOf(schema, namespace, card.settingsPath, card.modelId)
    return declared ?? modelThinking.levels
  })
  /** 用户勾选集合（按 pi-ai 键域归一序）；空 = 该模型不提供思考档。 */
  const knownSelected = KNOWN_LEVELS.filter(level => levels.includes(level))
  /**
   * 是否 pi-ai 族（档位集合可落盘）。
   *
   * deepseek 族的模型 profile 没有 `reasoningEfforts` 字段——它的可选档位来自
   * deepseek 适配器自己的目录链（`reasoningEffort` 只管默认档）。对它显示多选
   * 控件会造成「勾了但不落盘」的假象，故 deepseek 族沿用原有单选语义。
   */
  const isPiAi = card.family !== 'deepseek'
  const noLevels = isPiAi && knownSelected.length === 0
  // 默认档候选只列**用户勾选的集合**（不再列侦测全集）：档位不在集合里时 pi-ai
  // 派发会抛 UNSUPPORTED_REASONING_EFFORT，故候选集必须与落盘的 reasoningEfforts 键域一致。
  const options = isPiAi
    ? (noLevels ? [{ id: 'off', label: '未勾选档位' }] : thinkingOptionsOf(knownSelected))
    : thinkingOptionsOf(modelThinking.levels)
  const thinkingValue = !isPiAi
    ? thinking
    : knownSelected.includes(thinking) ? thinking : knownSelected[0] ?? 'off'
  const thinkingDesc = `${modelThinking.detected
    ? `侦测到：${modelThinking.levels.join(' / ')}`
    : '未识别该模型 · 默认档集'}${isPiAi ? ` · 已选 ${knownSelected.length} 档（下方勾选实际支持的档位）` : ''}`
  /**
   * 勾选/取消一个档位。
   *
   * 取消掉当前默认档时必须同步改默认档——否则落盘的 `reasoning` 指向一个不在
   * `reasoningEfforts` 里的档，pi-ai 在**请求期**才抛错（实测报错文案是
   * `does not support reasoning effort "<x>"`，用户看到的是发消息失败而非设置报错）。
   * 取消后回落到剩余档里的第一个（全取消则置 'off'，配合落盘删键 = 不可选思考等级）。
   * 顺序按 KNOWN_LEVELS 归一，保证同配置重复保存不产生 diff。
   */
  const toggleLevel = (level: string): void => {
    setSaved(false)
    const has = levels.includes(level)
    // 归一序（KNOWN_LEVELS）顺带剔除非键域的历史档位 id——保存时本就会剔除，
    // 提前归一让「已选 N 档」与落盘结果一致。
    const next = KNOWN_LEVELS.filter(l => has ? levels.includes(l) && l !== level : levels.includes(l) || l === level)
    setLevels(next)
    // 取消掉当前默认档时同步改默认档（见上：否则请求期才抛错）。
    if (!next.includes(thinking)) setThinking(next[0] ?? 'off')
  }
  /**
   * profile 里既有的、不在 pi-ai 键域内的历史档位 id。
   *
   * 必须显式提示而非静默丢弃：pi-ai 的 `reasoningEfforts` **键**被
   * `z.union(THINKING_LEVELS)` 校验，一个非法键会让**整个 settings 段注册失败**，
   * UI 只报「namespace not registered」（2026-09-15 事故形态，真凶是布尔键 `false`）。
   * 保存时这些键会被剔除（保段可注册），故先告知用户会丢什么。
   */
  const unknownLevels = levels.filter(level => !KNOWN_LEVELS.includes(level))
  const disabled = busy || !state.writable

  const writeModels = async (mutate: (arr: Record<string, unknown>[], idx: number, next: Record<string, unknown>) => void): Promise<boolean> => {
    const list = schema.getPath(namespace.value, [...card.settingsPath, 'models'])
    const arr: Record<string, unknown>[] = Array.isArray(list)
      ? list.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null).map(m => ({ ...m }))
      : []
    const idx = arr.findIndex(m => m.id === card.modelId)
    const next: Record<string, unknown> = idx >= 0 ? { ...arr[idx] } : { id: card.modelId }
    mutate(arr, idx, next)
    const res = await api.settings.mutate(
      card.settingsNs,
      [{ op: 'set', path: [...card.settingsPath, 'models'], value: arr as unknown as JsonValue }],
      namespace.revision,
    )
    if (!res.ok) { setFailure(res.error.message); return false }
    return true
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    try {
      const ctxN = parseCapacity(ctx)
      const maxN = parseCapacity(maxOut)
      const ok = await writeModels((arr, idx, next) => {
        if (ctxN !== undefined) next.contextWindow = ctxN
        else delete next.contextWindow
        if (maxN !== undefined) next.maxTokens = maxN
        else delete next.maxTokens
        const inputKey = card.family === 'deepseek' ? 'inputModalities' : 'input'
        if (image) next[inputKey] = ['text', 'image']
        else delete next[inputKey]
        /**
         * 思考档落盘。
         *
         * **deepseek 族**（沿用原语义）：用户填的默认档原样写入 `reasoningEffort`。
         *
         * **pi-ai 族**（2026-09-29 用户定调「pi-ai 的表是兜底，档位由用户设置」）：
         * 档位集合**以用户勾选为准**落盘 `reasoningEfforts`——选择器的「推理等级」
         * 子面板读的就是它；内置表只在用户没勾过时作预勾选建议。
         *
         * 两条不变式（对应实测会炸的形态）：
         *   ① 键必须落在 pi-ai 键域（KNOWN_LEVELS）内——非法键让**整段 settings 失效**
         *      （UI 只报 namespace not registered，不指向那个键）；
         *   ② 至少要有一个非 off 档——否则 pi-ai 报「offers no level beyond "off"」。
         *
         * ⚠️ 关于 `reasoning` 这个键（实测事实，避免过度归因）：pi-ai 的模型条目 schema
         * （`modelFields`）**没有** `reasoning`，其 `resolveEntry` 也只消费
         * id/name/api/input/contextWindow/maxTokens/compat——即**该字段对请求派发无效**，
         * 它只被 corum 自己的 UI（readModelThinking）读回显示。真正决定每轮请求档位的是
         * 会话的 `reasoningEffort` 选择，兜底才是**路由级** `providers.<route>.reasoning`
         * （pi-ai `adapter.ts` 的 `options.reasoningEffort ?? profile.reasoning`）。
         * 故这里照旧写入它（保留用户可见的默认档记录），但不宣称它门控请求行为。
         */
        if (card.family === 'deepseek') {
          if (thinking !== '' && thinking !== 'off') next.reasoningEffort = thinking
          else delete next.reasoningEffort
        } else {
          // 归一（键域过滤 / 非推理模型编码 / 默认档门控）收在 piAiThinkingWrite
          // 里，由单测钉住——见 reasoning.ts 的不变式 ①②。
          const written = piAiThinkingWrite(levels, thinking)
          if (written.defaultLevel !== '') next.reasoning = written.defaultLevel
          else delete next.reasoning
          next.reasoningEfforts = written.efforts
        }
        // 费用（自建 pricing 字段）。
        const pricing: Record<string, number> = {}
        const ph = Number(priceHit)
        const pm = Number(priceMiss)
        const po = Number(priceOut)
        if (priceHit.trim() !== '' && Number.isFinite(ph)) pricing.cacheHit = ph
        if (priceMiss.trim() !== '' && Number.isFinite(pm)) pricing.cacheMiss = pm
        if (priceOut.trim() !== '' && Number.isFinite(po)) pricing.output = po
        if (Object.keys(pricing).length > 0) next.pricing = pricing
        else delete next.pricing
        if (idx >= 0) arr[idx] = next
        else arr.push(next)
      })
      if (!ok) return
      setSaved(true)
      onChanged()
      // 保存成功即返回上一级（主页卡片网格）。
      onBack()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  // 删除模型：点「删除模型」先开统一风格确认弹窗（pendingDelete），确认才执行。
  const [confirmDelete, setConfirmDelete] = useState(false)

  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const ok = await writeModels((arr, idx) => {
        if (idx >= 0) arr.splice(idx, 1)
      })
      if (!ok) return
      onChanged()
      onBack()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const desc = `${card.providerName} · ${image ? '文本 / 图片输入' : '文本输入'}`

  return (
    <div className={styles['section']}>
      <BackRow onBack={onBack} />

      <div className={styles['card']}>
        <span className={styles['cardHead']}>
          <span className={styles['cardHeadLeft']}>
            <BrandLogo brand={card.brand} size={34} fallback={<IconCpu size={17} />} />
            <span className={styles['cardHeadTitle']}>
              <span className={styles['cardName']}>{card.modelId}</span>
              <span className={styles['cardDesc']}>{desc}</span>
            </span>
          </span>
          <span className={styles['cardHeadRight']}>
            <StatusPill tone="success" label="已启用" />
          </span>
        </span>
      </div>

      <SettingGroup title="容量">
        <SettingRow
          label="上下文窗口"
          desc="单次请求最大词元数（留空用提供方默认）"
          control={<input className={styles['textField']} value={ctx} placeholder="256K" disabled={disabled} onChange={e => { setCtx(e.target.value); setSaved(false) }} />}
        />
        <SettingRow
          label="最大输出词元数"
          desc="单次响应最大生成词元数"
          control={<input className={styles['textField']} value={maxOut} placeholder="32K" disabled={disabled} onChange={e => { setMaxOut(e.target.value); setSaved(false) }} />}
        />
        <SettingRow
          label="默认思考模式"
          desc={thinkingDesc}
          divider={false}
          control={(
            <span className={styles['settingControl']}>
              {showCustomThinking
                ? (
                  <input
                    className={styles['textField']}
                    value={customThinking}
                    placeholder="输入档位（如 high）"
                    disabled={disabled}
                    onChange={e => { setCustomThinking(e.target.value); setThinking(e.target.value || 'off'); setSaved(false) }}
                  />
                )
                : (
                  <SelectField
                    value={thinkingValue}
                    options={[...options, { id: '__custom__', label: '自定义…' }]}
                    disabled={disabled}
                    ariaLabel="默认思考模式"
                    onChange={(id) => {
                      if (id === '__custom__') { setShowCustomThinking(true); setCustomThinking(''); setThinking('off') }
                      else { setThinking(id) }
                      setSaved(false)
                    }}
                  />
                )}
              {showCustomThinking && modelThinking.levels.length > 1
                ? (
                  <button type="button" className={styles['btnGhost']} onClick={() => { setShowCustomThinking(false) }}>
                    返回档位
                  </button>
                )
                : null}
            </span>
          )}
        />
        {/* 自定义档位集合（2026-09-29 用户定调）：勾出该模型实际支持的档位，
            选择器的「推理等级」子面板即渲染这一集合。pi-ai 内置表只在没勾过时
            作预勾选建议 —— 表未覆盖的模型（如 glm-5.3-flash）由此获得真实档位，
            而非兜底全集。deepseek 族不出此行（其 profile 无该字段，档位来自适配器目录）。 */}
        {isPiAi
          ? (
            <SettingRow
              label="支持的档位"
              desc="勾选该模型实际支持的推理档。取消勾选当前默认档时会自动改默认档；全不勾 = 该模型不提供思考等级。⚠️ 某个 Agent 预设固定了某档位时，取消勾选该档会让预设的请求在发送时失败（pi-ai 报 does not support reasoning effort）——改前请确认没有预设正在用被去掉的档。"
              stacked
              divider={false}
              control={(
                <span className={styles['levelPicker']}>
                  {KNOWN_LEVELS.map((level) => {
                    const on = levels.includes(level)
                    return (
                      <button
                        key={level}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        aria-label={`档位 ${level}`}
                        disabled={disabled}
                        className={`${styles['levelChip']} ${on ? styles['levelChipOn'] as string : ''}`}
                        onClick={() => { toggleLevel(level) }}
                      >
                        {level}
                      </button>
                    )
                  })}
                </span>
              )}
            />
          )
          : null}
        {/* 历史非法档位提示：pi-ai 的 reasoningEfforts **键**只认 7 个固定 id，
            非法键会让整个 settings 段注册失败（UI 只报 namespace not registered，
            不指向那个键）。保存时会剔除，故先明说会丢什么，不静默吞。 */}
        {isPiAi && unknownLevels.length > 0
          ? (
            <SettingRow
              label="将被移除的历史档位"
              desc={`该模型的档位声明里有 pi-ai 不认识的键：${unknownLevels.join(' / ')}。它们不是合法档位 id，保留会导致整个模型设置段失效，保存时会被移除。`}
              divider={false}
              control={<span />}
            />
          )
          : null}
      </SettingGroup>

      <SettingGroup title="能力">
        <SettingRow
          label="支持图片输入"
          desc="允许向该模型发送图片（多模态）"
          divider={false}
          control={<Switch on={image} disabled={disabled} ariaLabel="支持图片输入" onChange={(on) => { setImage(on); setSaved(false) }} />}
        />
      </SettingGroup>

      <SettingGroup title="费用">
        <PriceRow label="输入 · 缓存命中" desc="缓存命中时输入词元单价" value={priceHit} disabled={disabled} onChange={(v) => { setPriceHit(v); setSaved(false) }} />
        <PriceRow label="输入 · 缓存未命中" desc="缓存未命中时输入词元单价" value={priceMiss} disabled={disabled} onChange={(v) => { setPriceMiss(v); setSaved(false) }} />
        <PriceRow label="输出" desc="生成词元单价" value={priceOut} disabled={disabled} divider={false} onChange={(v) => { setPriceOut(v); setSaved(false) }} />
      </SettingGroup>

      <SettingGroup title="连接">
          {/* deepseek 官方路由：隐藏 BaseURL（用官方默认地址），连通测试走 catalog 目录 */}
          {isDeepSeekOfficial ? null : (
            <SettingRow
              label="API 地址"
              desc="留空使用提供方默认地址"
              control={<input className={`${styles['textField']} ${styles['textFieldWide']}`} value={baseURL} placeholder="https://api.deepseek.com" disabled={disabled} onChange={e => { setBaseURL(e.target.value) }} />}
            />
          )}
          <SettingRow
            label="连通性测试"
            desc={isDeepSeekOfficial ? '官方目录路由 · 读取内置模型目录验证配置' : '向该模型发送一次最小请求验证配置'}
            divider={false}
            control={(
              <>
                <ConnResult conn={conn} inline />
                <GlassButton icon={<IconZap size={12} />} disabled={conn.result.kind === 'busy'} onClick={() => {
                  void conn.run({ settingsNs: card.settingsNs, provider: card.provider, baseURL: baseURL || undefined })
                }}>
                  测试连接
                </GlassButton>
              </>
            )}
          />
      </SettingGroup>

      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {saved ? <p className={styles['savedNotice']}>已保存。</p> : null}

      <div className={styles['foot']}>
        <GlassButton kind="ghost" icon={<IconTrash size={12} />} danger onClick={() => { setConfirmDelete(true) }} disabled={disabled}>
          删除模型
        </GlassButton>
        <span className={styles['footRight']}>
          <GlassButton onClick={onBack} disabled={busy}>取消</GlassButton>
          <GlassButton kind="primary" onClick={() => { void save() }} disabled={disabled}>
            {busy ? '保存中…' : '保存'}
          </GlassButton>
        </span>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="删除模型"
          message={`删除模型 ${card.modelId}？`}
          warning={`将从 ${card.providerName} 的目录中移除。`}
          tone="danger"
          confirmLabel="删除"
          busy={busy}
          busyLabel="删除中…"
          onConfirm={() => { setConfirmDelete(false); void remove() }}
          onCancel={() => { setConfirmDelete(false) }}
        />
      )}
    </div>
  )
}

/* ── 费用行（输入框 + 单位） ── */

function PriceRow({ label, desc, value, disabled, divider, onChange }: {
  label: string
  desc: string
  value: string
  disabled?: boolean
  divider?: boolean
  onChange: (v: string) => void
}): ReactNode {
  return (
    <SettingRow
      label={label}
      desc={desc}
      divider={divider}
      control={(
        <span className={styles['priceInput']}>
          <input
            className={styles['textField']}
            style={{ width: 90 }}
            value={value}
            placeholder="0"
            disabled={disabled}
            onChange={e => { onChange(e.target.value) }}
          />
          <span className={styles['priceUnit']}>¥ / M Token</span>
        </span>
      )}
    />
  )
}
