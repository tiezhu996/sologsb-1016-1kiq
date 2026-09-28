import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import type { Cue, CueKind, FrozenVersion, PendingChange, RecordingBatch, Scene, StudioDocument, StudioState, TimeSlot, WarningItem } from './types'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export const SLOT_LABELS: Record<TimeSlot, string> = {
  morning: '上午',
  afternoon: '下午',
  evening: '晚间'
}

export function slotLabel(slot: string): string {
  return SLOT_LABELS[slot as TimeSlot] ?? slot
}

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StudioState
      if (parsed.document?.scenes?.length) {
        // 旧版本数据没有批次表：按未排期打开，不改动原有场次与演员内容。
        if (!Array.isArray(parsed.document.batches)) parsed.document.batches = []
        for (const scene of parsed.document.scenes) {
          if (scene.batchId && !parsed.document.batches.some((batch) => batch.id === scene.batchId)) {
            scene.batchId = undefined
          }
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

  function actorsInScene(document: StudioDocument, scene: Scene): string[] {
    const actors = new Set<string>()
    for (const cue of scene.cues) {
      if (cue.kind !== 'dialogue' || !cue.characterId) continue
      const character = document.characters.find((item) => item.id === cue.characterId)
      if (character?.voiceActor) actors.add(character.voiceActor)
    }
    return [...actors]
  }

  // 到场演员完全由批次内场次的台词实时派生，不单独保存，场次内容一变即重算。
  const batchActorsMap = computed<Map<string, string[]>>(() => {
    const map = new Map<string, Set<string>>()
    for (const scene of state.value.document.scenes) {
      if (!scene.batchId) continue
      const set = map.get(scene.batchId) ?? new Set<string>()
      for (const actor of actorsInScene(state.value.document, scene)) set.add(actor)
      map.set(scene.batchId, set)
    }
    return new Map([...map].
      map(([batchId, set]) => [batchId, [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'))] as const))
  })

  const scenesByBatch = computed<Map<string, Scene[]>>(() => {
    const map = new Map<string, Scene[]>()
    for (const scene of state.value.document.scenes) {
      if (!scene.batchId) continue
      const list = map.get(scene.batchId) ?? []
      list.push(scene)
      map.set(scene.batchId, list)
    }
    return map
  })

  function actorsForBatch(batchId: string): string[] {
    return batchActorsMap.value.get(batchId) ?? []
  }

  function scenesForBatch(batchId: string): Scene[] {
    return scenesByBatch.value.get(batchId) ?? []
  }

  const batchById = (batchId: string) => state.value.document.batches.find((batch) => batch.id === batchId)

  function batchLabelOf(batchId?: string): string {
    if (!batchId) return '未排期'
    const batch = batchById(batchId)
    if (!batch) return '未排期'
    return `${batch.date} ${slotLabel(batch.slot)}`
  }

  interface DoubleBooking {
    key: string
    date: string
    slot: TimeSlot
    actor: string
    batchIds: string[]
    sceneIds: string[]
  }

  // 同一天同一时段内，同一配音演员出现在两个批次即构成撞档；可传入覆盖项模拟改派/改时段后的局面。
  function collectDoubleBookings(
    document: StudioDocument,
    override?: { sceneId?: string; batchId?: string; batch?: RecordingBatch }
  ): DoubleBooking[] {
    const groups = new Map<string, { actor: string; date: string; slot: TimeSlot; batches: Map<string, string[]> }>()
    for (const scene of document.scenes) {
      let batchId = scene.batchId
      if (override?.sceneId === scene.id) batchId = override.batchId
      if (!batchId) continue
      const batch = override?.batch && override.batch.id === batchId ? override.batch : document.batches.find((item) => item.id === batchId)
      if (!batch) continue
      for (const actor of actorsInScene(document, scene)) {
        const key = `${batch.date}|${batch.slot}|${actor}`
        const group = groups.get(key) ?? { actor, date: batch.date, slot: batch.slot, batches: new Map<string, string[]>() }
        const scenes = group.batches.get(batchId) ?? []
        if (!scenes.includes(scene.id)) scenes.push(scene.id)
        group.batches.set(batchId, scenes)
        groups.set(key, group)
      }
    }
    const result: DoubleBooking[] = []
    groups.forEach((group, key) => {
      if (group.batches.size < 2) return
      const batchIds = [...group.batches.keys()]
      result.push({
        key,
        date: group.date,
        slot: group.slot,
        actor: group.actor,
        batchIds,
        sceneIds: batchIds.flatMap((id) => group.batches.get(id) ?? [])
      })
    })
    return result
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
    const sceneCode = (sceneId: string) => state.value.document.scenes.find((scene) => scene.id === sceneId)?.code ?? '?'
    for (const conflict of collectDoubleBookings(state.value.document)) {
      const sceneCodes = conflict.sceneIds.map(sceneCode)
      const detail = `${conflict.date} ${slotLabel(conflict.slot)}，配音演员“${conflict.actor}”同时被排进 ${conflict.batchIds.length} 个批次：场次 ${sceneCodes.join('、')}。请调整其中一场的批次或日期时段。`
      for (const sceneId of conflict.sceneIds) {
        result.push({
          id: `doublebook-${conflict.key}-${sceneId}`,
          type: 'double-book',
          level: 'error',
          sceneId,
          title: `${sceneCode(sceneId)} 录制撞档 · ${conflict.actor}`,
          detail
        })
      }
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

  const unscheduledScenes = computed(() => state.value.document.scenes.filter((scene) => !scene.batchId || !batchById(scene.batchId)))

  function formatConflictList(conflicts: DoubleBooking[]): string {
    const sceneCode = (sceneId: string) => state.value.document.scenes.find((scene) => scene.id === sceneId)?.code ?? '?'
    return conflicts
      .map((conflict) => `${conflict.date} ${slotLabel(conflict.slot)} “${conflict.actor}”：场次 ${conflict.sceneIds.map(sceneCode).join('、')}`)
      .join('；')
  }

  // 场次改派：撞档时点名两个场次并挡住，原排期与演员名单均不变。
  function assignSceneBatch(sceneId: string, batchId: string | undefined): { ok: boolean; conflicts: DoubleBooking[] } {
    const scene = state.value.document.scenes.find((item) => item.id === sceneId)
    if (!scene) return { ok: false, conflicts: [] }
    const currentId = scene.batchId && batchById(scene.batchId) ? scene.batchId : undefined
    if ((batchId ?? undefined) === currentId) return { ok: true, conflicts: [] }
    if (batchId && !batchById(batchId)) return { ok: false, conflicts: [] }
    const conflicts = collectDoubleBookings(state.value.document, { sceneId, batchId })
    if (conflicts.length) return { ok: false, conflicts }
    const targetCode = batchId ? batchLabelOf(batchId) : '未排期'
    commit(`改派 ${scene.code} 至 ${targetCode}`, (document) => {
      const target = document.scenes.find((item) => item.id === sceneId)
      if (!target) return
      target.batchId = batchId
    })
    return { ok: true, conflicts: [] }
  }

  function addBatch(date: string, slot: TimeSlot, note: string): string {
    const id = uid('batch')
    const count = state.value.document.batches.length + 1
    commit(`新增录制批次 ${count}`, (document) => {
      document.batches.push({ id, date, slot, note: note.trim() })
    })
    return id
  }

  // 修改批次日期/时段：撞档时挡住，原日期时段不变。
  function updateBatch(batchId: string, patch: { date?: string; slot?: TimeSlot; note?: string }): { ok: boolean; conflicts: DoubleBooking[] } {
    const batch = batchById(batchId)
    if (!batch) return { ok: false, conflicts: [] }
    const nextDate = patch.date ?? batch.date
    const nextSlot = patch.slot ?? batch.slot
    if (nextDate === batch.date && nextSlot === batch.slot && (patch.note ?? batch.note) === batch.note) {
      return { ok: true, conflicts: [] }
    }
    if (nextDate !== batch.date || nextSlot !== batch.slot) {
      const conflicts = collectDoubleBookings(state.value.document, { batch: { ...batch, date: nextDate, slot: nextSlot } })
      if (conflicts.length) return { ok: false, conflicts }
    }
    commit(`修改批次 ${nextDate} ${slotLabel(nextSlot)}`, (document) => {
      const target = document.batches.find((item) => item.id === batchId)
      if (!target) return
      target.date = nextDate
      target.slot = nextSlot
      if (patch.note !== undefined) target.note = patch.note
    })
    return { ok: true, conflicts: [] }
  }

  function deleteBatch(batchId: string) {
    const batch = batchById(batchId)
    if (!batch) return
    commit(`删除批次 ${batch.date} ${slotLabel(batch.slot)}`, (document) => {
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
      ''
    ]

    const findBatch = (batchId?: string) => (batchId ? document.batches.find((batch) => batch.id === batchId) : undefined)
    const scheduled = document.scenes.filter((scene) => findBatch(scene.batchId))
    if (scheduled.length) {
      lines.push('录制排期')
      const ordered = [...document.batches].sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot))
      for (const batch of ordered) {
        const scenes = document.scenes.filter((scene) => scene.batchId === batch.id)
        if (!scenes.length) continue
        const actors = new Set<string>()
        for (const scene of scenes) for (const actor of actorsInScene(document, scene)) actors.add(actor)
        lines.push(`${batch.date} ${slotLabel(batch.slot)}${batch.note ? `｜${batch.note}` : ''}`)
        lines.push(`  场次：${scenes.map((scene) => scene.code).join('、') || '无'}`)
        lines.push(`  到场演员：${[...actors].join('、') || '暂无台词角色'}`)
      }
      const unscheduled = document.scenes.filter((scene) => !findBatch(scene.batchId))
      if (unscheduled.length) lines.push(`未排期场次：${unscheduled.map((scene) => scene.code).join('、')}`)
      lines.push('='.repeat(48))
      lines.push('')
    } else {
      lines.push('录制排期：全部场次未排期')
      lines.push('='.repeat(48))
      lines.push('')
    }

    document.scenes.forEach((scene, sceneIndex) => {
      lines.push(`${scene.code}｜${scene.title}`)
      const batch = findBatch(scene.batchId)
      if (batch) {
        lines.push(`录制批次：${batch.date} ${slotLabel(batch.slot)}${batch.note ? `｜${batch.note}` : ''}`)
      } else {
        lines.push('录制批次：未排期')
      }
      lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
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
    formatConflictList,
    actorsForBatch,
    scenesForBatch,
    actorsInScene: (scene: Scene) => actorsInScene(state.value.document, scene),
    unscheduledScenes,
    batchLabelOf,
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
