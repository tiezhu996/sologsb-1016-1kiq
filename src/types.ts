export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2

export interface Character {
  id: string
  name: string
  voiceActor: string
  color: string
}

export interface SoundEffect {
  id: string
  name: string
  duration: number
  source: string
  note: string
}

export interface Cue {
  id: string
  kind: CueKind
  characterId?: string
  text: string
  emotion: string
  rate: Rate
  soundEffectId?: string
  transition: string
  manualDuration?: number
}

export interface RecordingBatch {
  id: string
  name: string
  /** 录制日期，格式 yyyy-MM-dd；空串表示尚未定档 */
  date: string
  /** 时段，例如“上午”“下午”“14:00–18:00” */
  slot: string
}

export interface Scene {
  id: string
  code: string
  title: string
  location: string
  timeOfDay: string
  transition: string
  durationLimit: number
  cues: Cue[]
  /** 所属录制批次；缺省表示未排期（旧数据按此打开） */
  batchId?: string
}

export interface StudioDocument {
  title: string
  subtitle: string
  targetDuration: number
  characters: Character[]
  soundEffects: SoundEffect[]
  batches: RecordingBatch[]
  scenes: Scene[]
}

export interface BatchActor {
  actor: string
  roles: string[]
  sceneIds: string[]
}

export interface BatchConflict {
  actor: string
  batchId: string
  sceneId: string
  otherBatchId: string
  otherSceneId: string
}

export interface AssignResult {
  ok: boolean
  conflicts?: BatchConflict[]
  batchId?: string
}

export interface PendingChange {
  id: string
  label: string
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  before: StudioDocument
  after: StudioDocument
  note: string
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  document: StudioDocument
  totalDuration: number
}

export interface StudioState {
  document: StudioDocument
  pending: PendingChange[]
  frozen: FrozenVersion[]
  updatedAt: string
}

export interface WarningItem {
  id: string
  type: 'collision' | 'missing-sfx' | 'over-time' | 'schedule'
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  otherSceneId?: string
  title: string
  detail: string
}
