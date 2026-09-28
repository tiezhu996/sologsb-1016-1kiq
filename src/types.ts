export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2
export type TimeSlot = 'morning' | 'afternoon' | 'evening'

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

export interface Scene {
  id: string
  code: string
  title: string
  location: string
  timeOfDay: string
  transition: string
  durationLimit: number
  cues: Cue[]
  batchId?: string
}

export interface RecordingBatch {
  id: string
  date: string
  slot: TimeSlot
  note: string
}

export interface StudioDocument {
  title: string
  subtitle: string
  targetDuration: number
  characters: Character[]
  soundEffects: SoundEffect[]
  scenes: Scene[]
  batches: RecordingBatch[]
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

export type WarningType = 'collision' | 'missing-sfx' | 'over-time' | 'double-book'

export interface WarningItem {
  id: string
  type: WarningType
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
}

export interface BatchAssignmentConflict {
  batchId: string
  actors: Array<{
    actor: string
    sceneIds: string[]
  }>
}
