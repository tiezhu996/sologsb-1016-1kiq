import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import type { BatchActor, BatchConflict, Cue, CueKind, FrozenVersion, PendingChange, RecordingBatch, Scene, StudioDocument, StudioState, WarningItem } from './types'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 某场台词对应的配音演员（去重），内容变化后调用方随 computed 实时重算 */
export function actorsOfScene(document: StudioDocument, sceneId: string): string[] {
  const scene = document.scenes.find((item) => item.id === sceneId)
  if (!scene) return []
  const actors = new Set<string>()
  for (const cue of scene.cues) {
    if (cue.kind !== 'dialogue' || !cue.characterId) continue
    const character = document.characters.find((item) => item.id === cue.characterId)
    if (character?.voiceActor) actors.add(character.voiceActor)
  }
  return [...actors]
}

/** 同一天同一时段下，跨批次的演员撞场；返回需要点名的两个场次 */
export function findBatchConflicts(document: StudioDocument): BatchConflict[] {
  const result: BatchConflict[] = []
  for (const scene of document.scenes) {
    const batch = scene.batchId ? document.batches.find((item) => item.id === scene.batchId) : undefined
    if (!batch || !batch.date || !batch.slot) continue
    for (const other of document.scenes) {
      if (other.id === scene.id || !other.batchId || other.batchId === scene.batchId) continue
      const otherBatch = document.batches.find((item) => item.id === other.batchId)
      if (!otherBatch || otherBatch.date !== batch.date || otherBatch.slot !== batch.slot) continue
      const shared = actorsOfScene(document, scene.id).filter((actor) => actorsOfScene(document, other.id).includes(actor))
      for (const actor of shared) {
        // 同一对场次每个演员只留一条，且按场次顺序去重
        if (other.id < scene.id) continue
        result.push({
          actor,
          batchId: scene.batchId!,
          sceneId: scene.id,
          otherBatchId: other.batchId!,
          otherSceneId: other.id
        })
      }
    }
  }
  return result
}

/**
 * 预演“把 sceneId 归入 batchId（'' 表示撤出批次）”。
 * 不修改任何数据；有冲突时返回需要点名的场次对，调用方据此挡住改派。
 * 规则：同一天同一时段，演员不得分属两个不同批次；
 * 与目标批次内已有场次同档属于“并入同一批”，是允许的，不拦截。
 */
export function previewAssignConflicts(document: StudioDocument, sceneId: string, batchId: string): BatchConflict[] {
  const target = batchId ? document.batches.find((item) => item.id === batchId) : undefined
  if (!target || !target.date || !target.slot) return []
  const sceneActors = actorsOfScene(document, sceneId)
  if (!sceneActors.length) return []
  const conflicts: BatchConflict[] = []
  for (const other of document.scenes) {
    if (other.id === sceneId || !other.batchId || other.batchId === target.id) continue
    const otherBatch = document.batches.find((item) => item.id === other.batchId)
    if (!otherBatch || otherBatch.date !== target.date || otherBatch.slot !== target.slot) continue
    for (const actor of sceneActors) {
      if (actorsOfScene(document, other.id).includes(actor)) {
        conflicts.push({
          actor,
          batchId: target.id,
          sceneId,
          otherBatchId: otherBatch.id,
          otherSceneId: other.id
        })
      }
    }
  }
  return conflicts
}

/** 预演批次日期/时段调整后会不会产生跨批次撞场 */
export function previewBatchEditConflicts(document: StudioDocument, batchId: string, patch: Pick<RecordingBatch, 'date' | 'slot'>): BatchConflict[] {
  const draft = clone(document)
  const batch = draft.batches.find((item) => item.id === batchId)
  if (!batch) return []
  batch.date = patch.date
  batch.slot = patch.slot
  return findBatchConflicts(draft).filter((conflict) => conflict.batchId === batchId || conflict.otherBatchId === batchId)
}

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StudioState
      if (parsed.document?.scenes?.length) {
        // 旧数据没有批次概念：补上空批次列表，场次一律按“未排期”打开，原排期和名单都不变
        if (!Array.isArray(parsed.document.batches)) parsed.document.batches = []
        for (const scene of parsed.document.scenes) {
          if (scene.batchId && !parsed.document.batches.some((batch) => batch.id === scene.batchId)) scene.batchId = undefined
        }
        return parsed
      }
    }
  } catch {
    // A corrupt local draft should not prevent access to the built-in example.
  }
  return {
    document: clone(sampleDocument),
    pending: [],
    frozen: [],
    updatedAt: new Date().toISOString()
  }
}

export function useStudio() {
  const state = ref<StudioState>(loadState())
  const selectedSceneId = ref(state.value.document.scenes[0]?.id ?? '')
  const selectedCueId = ref('')
  const saveState = ref<'saved' | 'saving' | 'dirty'>('saved')
  const undoStack = ref<StudioDocument[]>([])
  const redoStack = ref<StudioDocument[]>([])
  let saveTimer: number | undefined

  const selectedScene = computed(() => state.value.document.scenes.find((scene) => scene.id === selectedSceneId.value) ?? state.value.document.scenes[0])

  function durationOfCue(cue: Cue): number {
    if (cue.manualDuration !== undefined) return cue.manualDuration
    if (cue.kind === 'sfx') {
      return state.value.document.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
    }
    if (cue.kind === 'transition') return 3
    const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
    const effectiveRate = cue.rate || 1
    return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
  }

  function durationOfScene(scene: Scene): number {
    return Number(scene.cues.reduce((total, cue) => total + durationOfCue(cue), 0).toFixed(1))
  }

  const totalDuration = computed(() => state.value.document.scenes.reduce((total, scene) => total + durationOfScene(scene), 0))
  const pendingChanges = computed(() => state.value.pending.filter((item) => item.status === 'pending'))

  /** 每个批次的到场演员：批次内场次内容（角色、台词增删）一变，这里实时重算 */
  const batchActors = computed<Map<string, BatchActor[]>>(() => {
    const map = new Map<string, BatchActor[]>()
    for (const batch of state.value.document.batches) {
      const actorMap = new Map<string, BatchActor>()
      for (const scene of state.value.document.scenes) {
        if (scene.batchId !== batch.id) continue
        for (const cue of scene.cues) {
          if (cue.kind !== 'dialogue' || !cue.characterId) continue
          const character = state.value.document.characters.find((item) => item.id === cue.characterId)
          if (!character?.voiceActor) continue
          const entry = actorMap.get(character.voiceActor) ?? { actor: character.voiceActor, roles: [], sceneIds: [] }
          if (!entry.roles.includes(character.name)) entry.roles.push(character.name)
          if (!entry.sceneIds.includes(scene.id)) entry.sceneIds.push(scene.id)
          actorMap.set(character.voiceActor, entry)
        }
      }
      map.set(batch.id, [...actorMap.values()].sort((a, b) => a.actor.localeCompare(b.actor, 'zh-CN')))
    }
    return map
  })

  const unscheduledScenes = computed(() => state.value.document.scenes.filter((scene) => !scene.batchId))
  const batchConflicts = computed(() => findBatchConflicts(state.value.document))

  function sceneLabel(sceneId: string): string {
    const scene = state.value.document.scenes.find((item) => item.id === sceneId)
    return scene ? `${scene.code} ${scene.title}` : '未知场次'
  }

  function batchLabel(batchId?: string): string {
    if (!batchId) return '未排期'
    const batch = state.value.document.batches.find((item) => item.id === batchId)
    if (!batch) return '未排期'
    return `${batch.name}${batch.date || batch.slot ? `（${batch.date || '未定日期'} ${batch.slot || '未定时段'}`.trim() + '）' : ''}`
  }

  const warnings = computed<WarningItem[]>(() => {
    const result: WarningItem[] = []
    for (const scene of state.value.document.scenes) {
      const actorRoles = new Map<string, string[]>()
      for (const cue of scene.cues) {
        if (cue.kind === 'dialogue' && cue.characterId) {
          const character = state.value.document.characters.find((item) => item.id === cue.characterId)
          if (character) {
            const roles = actorRoles.get(character.voiceActor) ?? []
            roles.push(character.name)
            actorRoles.set(character.voiceActor, roles)
          }
        }
        if (cue.kind === 'sfx' && cue.soundEffectId && !state.value.document.soundEffects.some((effect) => effect.id === cue.soundEffectId)) {
          result.push({
            id: `missing-${cue.id}`,
            type: 'missing-sfx',
            level: 'error',
            sceneId: scene.id,
            cueId: cue.id,
            title: `${scene.code} 音效引用缺失`,
            detail: `“${cue.text}”引用了不存在的音效 ${cue.soundEffectId}。`
          })
        }
      }
      actorRoles.forEach((roles, actor) => {
        const uniqueRoles = [...new Set(roles)]
        if (uniqueRoles.length > 1) {
          result.push({
            id: `collision-${scene.id}-${actor}`,
            type: 'collision',
            level: 'error',
            sceneId: scene.id,
            title: `${scene.code} 角色撞场`,
            detail: `${actor} 同时为 ${uniqueRoles.join('、')} 配音；同场角色需拆分演员或调整台词。`
          })
        }
      })
      const sceneDuration = durationOfScene(scene)
      if (sceneDuration > scene.durationLimit) {
        result.push({
          id: `over-${scene.id}`,
          type: 'over-time',
          level: 'warning',
          sceneId: scene.id,
          title: `${scene.code} 超出场次限额`,
          detail: `预计 ${sceneDuration.toFixed(1)} 秒，限额 ${scene.durationLimit} 秒，超出 ${(sceneDuration - scene.durationLimit).toFixed(1)} 秒。`
        })
      }
    }
    for (const conflict of batchConflicts.value) {
      result.push({
        id: `schedule-${conflict.batchId}-${conflict.otherBatchId}-${conflict.actor}-${conflict.sceneId}-${conflict.otherSceneId}`,
        type: 'schedule',
        level: 'error',
        sceneId: conflict.sceneId,
        otherSceneId: conflict.otherSceneId,
        title: `${sceneLabel(conflict.sceneId)} ↔ ${sceneLabel(conflict.otherSceneId)} 同档撞期`,
        detail: `同一天同一时段，${conflict.actor} 被同时分到「${batchLabel(conflict.batchId)}」的 ${sceneLabel(conflict.sceneId)} 与「${batchLabel(conflict.otherBatchId)}」的 ${sceneLabel(conflict.otherSceneId)}；请调整其中一个场次的批次、日期或时段。`
      })
    }
    return result
  })

  function persist() {
    state.value.updatedAt = new Date().toISOString()
    saveState.value = 'saving'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value))
      saveState.value = 'saved'
    }, 180)
  }

  function commit(label: string, mutator: (document: StudioDocument) => void, note = '') {
    const before = clone(state.value.document)
    const document = clone(state.value.document)
    mutator(document)
    undoStack.value.push(before)
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    state.value.document = document
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note,
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(document)
    })
    if (state.value.pending.length > 80) state.value.pending = state.value.pending.slice(0, 80)
    persist()
  }

  function replaceDocument(next: StudioDocument, label: string) {
    const before = clone(state.value.document)
    state.value.document = clone(next)
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note: '',
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(next)
    })
    persist()
  }

  function updateProject(field: 'title' | 'subtitle' | 'targetDuration', value: string | number) {
    commit(`更新项目${field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '目标时长'}`, (document) => {
      if (field === 'targetDuration') document.targetDuration = Number(value)
      else document[field] = String(value)
    })
  }

  function updateScene(sceneId: string, field: keyof Scene, value: string | number) {
    commit(`更新 ${state.value.document.scenes.find((scene) => scene.id === sceneId)?.code ?? '场次'} ${field}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (field === 'durationLimit') scene.durationLimit = Number(value)
      else if (field === 'code' || field === 'title' || field === 'location' || field === 'timeOfDay' || field === 'transition') scene[field] = String(value)
    })
  }

  function updateCue(cueId: string, field: keyof Cue, value: string | number | undefined) {
    commit(`修改台词 ${state.value.document.scenes.flatMap((scene) => scene.cues).find((cue) => cue.id === cueId)?.text.slice(0, 12) ?? ''}`, (document) => {
      for (const scene of document.scenes) {
        const cue = scene.cues.find((item) => item.id === cueId)
        if (!cue) continue
        if (field === 'rate') cue.rate = Number(value) as Cue['rate']
        else if (field === 'manualDuration') cue.manualDuration = value === '' || value === undefined ? undefined : Number(value)
        else if (field === 'kind') cue.kind = value as CueKind
        else cue[field] = (value ?? '') as never
        break
      }
    })
  }

  function addScene() {
    const nextNumber = state.value.document.scenes.length + 1
    const id = uid('scene')
    commit(`新增场次 S${String(nextNumber).padStart(2, '0')}`, (document) => {
      document.scenes.push({
        id,
        code: `S${String(nextNumber).padStart(2, '0')}`,
        title: '未命名场次',
        location: '待填写',
        timeOfDay: '待填写',
        transition: '淡入',
        durationLimit: 150,
        cues: []
      })
    })
    selectedSceneId.value = id
  }

  function deleteScene(sceneId: string) {
    if (state.value.document.scenes.length <= 1) return
    const scene = state.value.document.scenes.find((item) => item.id === sceneId)
    commit(`删除场次 ${scene?.code ?? ''}`, (document) => {
      document.scenes = document.scenes.filter((item) => item.id !== sceneId)
    })
    selectedSceneId.value = state.value.document.scenes[0].id
  }

  function addCue(kind: CueKind, sceneId = selectedSceneId.value) {
    const id = uid('cue')
    commit(`新增${kind === 'dialogue' ? '台词' : kind === 'sfx' ? '音效' : '转场'}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      scene.cues.push({
        id,
        kind,
        characterId: kind === 'dialogue' ? document.characters[0]?.id : undefined,
        text: kind === 'dialogue' ? '请输入台词' : kind === 'sfx' ? '音效提示' : '转场说明',
        emotion: kind === 'dialogue' ? '自然' : '',
        rate: 1,
        soundEffectId: kind === 'sfx' ? document.soundEffects[0]?.id : undefined,
        transition: kind === 'transition' ? '淡出' : '',
        manualDuration: kind === 'transition' ? 3 : undefined
      })
    })
    selectedCueId.value = id
  }

  function deleteCue(cueId: string) {
    commit('删除提示项', (document) => {
      for (const scene of document.scenes) scene.cues = scene.cues.filter((cue) => cue.id !== cueId)
    })
  }

  function moveCue(sceneId: string, cueId: string, targetCueId: string) {
    if (cueId === targetCueId) return
    commit('拖动调整台词与音效顺序', (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const fromIndex = scene.cues.findIndex((cue) => cue.id === cueId)
      const toIndex = scene.cues.findIndex((cue) => cue.id === targetCueId)
      if (fromIndex < 0 || toIndex < 0) return
      const [moved] = scene.cues.splice(fromIndex, 1)
      scene.cues.splice(toIndex, 0, moved)
    })
  }

  function moveScene(sceneId: string, direction: -1 | 1) {
    const index = state.value.document.scenes.findIndex((scene) => scene.id === sceneId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= state.value.document.scenes.length) return
    commit('调整场次顺序', (document) => {
      const [scene] = document.scenes.splice(index, 1)
      document.scenes.splice(target, 0, scene)
    })
  }

  function sceneActors(sceneId: string): string[] {
    return actorsOfScene(state.value.document, sceneId)
  }

  /**
   * 把场次归入批次（batchId 为空表示撤出）。
   * 同一天同一时段若演员已在另一个批次：点名两个场次并挡住改派，原排期和演员名单都不变。
   */
  function assignSceneBatch(sceneId: string, batchId: string): BatchConflict[] {
    const scene = state.value.document.scenes.find((item) => item.id === sceneId)
    if (!scene) return []
    const conflicts = previewAssignConflicts(state.value.document, sceneId, batchId)
    if (conflicts.length) return conflicts
    if ((scene.batchId ?? '') === batchId) return []
    const target = batchId ? state.value.document.batches.find((item) => item.id === batchId) : undefined
    commit(`${scene.code} ${target ? `归入「${target.name}」` : '撤出批次，转为未排期'}`, (document) => {
      const current = document.scenes.find((item) => item.id === sceneId)
      if (current) current.batchId = batchId || undefined
    })
    return []
  }

  function addBatch(): string {
    const id = uid('batch')
    commit('新增录制批次', (document) => {
      document.batches.push({
        id,
        name: `第${['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][document.batches.length] ?? document.batches.length + 1}批次`,
        date: new Date().toISOString().slice(0, 10),
        slot: '上午'
      })
    })
    return id
  }

  /** 改批次名称直接生效；改日期/时段若会撞档，返回冲突并保持原排期不变 */
  function updateBatch(batchId: string, field: keyof RecordingBatch, value: string): BatchConflict[] {
    const batch = state.value.document.batches.find((item) => item.id === batchId)
    if (!batch) return []
    if (batch[field] === value) return []
    if (field === 'date' || field === 'slot') {
      const patch = { date: field === 'date' ? value : batch.date, slot: field === 'slot' ? value : batch.slot }
      const conflicts = previewBatchEditConflicts(state.value.document, batchId, patch)
      if (conflicts.length) return conflicts
    }
    commit(`调整录制批次「${batch.name}」的${field === 'name' ? '名称' : field === 'date' ? '日期' : '时段'}`, (document) => {
      const target = document.batches.find((item) => item.id === batchId)
      if (target) target[field] = value
    })
    return []
  }

  function deleteBatch(batchId: string) {
    const batch = state.value.document.batches.find((item) => item.id === batchId)
    commit(`删除录制批次「${batch?.name ?? ''}」，批次内场次转为未排期`, (document) => {
      document.batches = document.batches.filter((item) => item.id !== batchId)
      for (const scene of document.scenes) {
        if (scene.batchId === batchId) scene.batchId = undefined
      }
    })
  }

  function acceptChange(changeId: string) {
    const change = state.value.pending.find((item) => item.id === changeId)
    if (!change || change.status !== 'pending') return
    change.status = 'accepted'
    persist()
  }

  function rejectChange(changeId: string) {
    const index = state.value.pending.findIndex((item) => item.id === changeId && item.status === 'pending')
    if (index < 0) return
    const change = state.value.pending[index]
    undoStack.value.push(clone(state.value.document))
    state.value.document = clone(change.before)
    for (let i = 0; i <= index; i += 1) {
      if (state.value.pending[i].status === 'pending') state.value.pending[i].status = 'rejected'
    }
    persist()
  }

  function acceptAll() {
    for (const change of state.value.pending) {
      if (change.status === 'pending') change.status = 'accepted'
    }
    persist()
  }

  function undo() {
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(clone(state.value.document))
    replaceDocument(previous, '撤销上一步修改')
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(clone(state.value.document))
    replaceDocument(next, '重做修改')
  }

  function freeze(name: string): FrozenVersion {
    const version: FrozenVersion = {
      id: uid('version'),
      name: name.trim() || `制作稿 v${state.value.frozen.length + 1}`,
      createdAt: new Date().toISOString(),
      document: clone(state.value.document),
      totalDuration: totalDuration.value
    }
    state.value.frozen.unshift(version)
    persist()
    return version
  }

  function makeScript(document: StudioDocument): string {
    const lines = [
      document.title,
      document.subtitle,
      `目标时长：${document.targetDuration} 秒`,
      '='.repeat(48),
      '',
      '【录制日程】'
    ]
    if (document.batches.length) {
      for (const batch of document.batches) {
        const scenes = document.scenes.filter((scene) => scene.batchId === batch.id)
        const actorSet = new Set<string>()
        for (const scene of scenes) for (const actor of actorsOfScene(document, scene.id)) actorSet.add(actor)
        lines.push(`${batch.name}｜日期：${batch.date || '未定'}｜时段：${batch.slot || '未定'}`)
        lines.push(`  场次：${scenes.length ? scenes.map((scene) => scene.code).join('、') : '（暂无场次）'}`)
        lines.push(`  到场演员：${actorSet.size ? [...actorSet].join('、') : '（按场次内容暂无台词演员）'}`)
      }
      const unscheduled = document.scenes.filter((scene) => !scene.batchId)
      if (unscheduled.length) {
        lines.push(`未排期：${unscheduled.map((scene) => scene.code).join('、')}（待归入录制批次）`)
      }
    } else {
      lines.push('（尚未建立录制批次，全部场次按未排期处理）')
    }
    lines.push('='.repeat(48), '')
    document.scenes.forEach((scene, sceneIndex) => {
      const batch = scene.batchId ? document.batches.find((item) => item.id === scene.batchId) : undefined
      lines.push(`${scene.code}｜${scene.title}`)
      lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
      if (batch) lines.push(`录制：${batch.name}｜${batch.date || '日期未定'} ${batch.slot || '时段未定'}`.trim())
      else lines.push('录制：未排期（待归入录制批次）')
      lines.push(`转场：${scene.transition}`)
      lines.push(`场次限额：${scene.durationLimit} 秒｜预计：${durationOfScene(scene)} 秒`)
      lines.push('-'.repeat(34))
      scene.cues.forEach((cue, cueIndex) => {
        const prefix = `${String(cueIndex + 1).padStart(2, '0')} [${durationOfCue(cue).toFixed(1)}s]`
        if (cue.kind === 'dialogue') {
          const role = document.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
          lines.push(`${prefix} ${role}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
          lines.push(`    ${cue.text}`)
        } else if (cue.kind === 'sfx') {
          const effect = document.soundEffects.find((item) => item.id === cue.soundEffectId)
          lines.push(`${prefix} 音效｜${cue.text}`)
          lines.push(`    文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
        } else {
          lines.push(`${prefix} 转场｜${cue.transition}｜${cue.text}`)
        }
      })
      if (sceneIndex < document.scenes.length - 1) lines.push('')
    })
    return lines.join('\n')
  }

  function downloadVersion(version: FrozenVersion) {
    const blob = new Blob([makeScript(version.document)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${version.document.title}-${version.name}.txt`.replace(/[\\/:*?"<>|]/g, '-')
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function resetSample() {
    commit('恢复示例数据', (document) => {
      const next = clone(sampleDocument)
      Object.assign(document, next)
    })
    selectedSceneId.value = state.value.document.scenes[0]?.id ?? ''
  }

  watch(state, persist, { deep: true })

  return {
    state,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    totalDuration,
    pendingChanges,
    warnings,
    saveState,
    durationOfCue,
    durationOfScene,
    batchActors,
    unscheduledScenes,
    batchConflicts,
    sceneActors,
    sceneLabel,
    batchLabel,
    updateProject,
    updateScene,
    updateCue,
    addScene,
    deleteScene,
    addCue,
    deleteCue,
    moveCue,
    moveScene,
    assignSceneBatch,
    addBatch,
    updateBatch,
    deleteBatch,
    acceptChange,
    rejectChange,
    acceptAll,
    undo,
    redo,
    freeze,
    downloadVersion,
    makeScript,
    resetSample,
    persist
  }
}
