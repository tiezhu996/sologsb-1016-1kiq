import assert from 'node:assert'
import { sampleDocument } from '../src/sample'
import { actorsOfScene, findBatchConflicts, previewAssignConflicts, previewBatchEditConflicts } from '../src/useStudio'
import type { StudioDocument } from '../src/types'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

// 1. 示例数据：同日不同时段（陈默：上午 S01 / 下午 S02）不冲突
let doc = clone(sampleDocument)
assert.deepEqual(findBatchConflicts(doc), [], 'sample should have no cross-batch conflicts')

// 2. 到场演员实时重算
const a1 = actorsOfScene(doc, 'scene-1').sort()
assert.deepEqual(a1, ['周岚', '陈默'], 'S01 actors')
// 删掉周岚的全部台词（林夏 + 房东）后，到场演员应实时变化
const mutated = clone(doc)
const s1 = mutated.scenes.find((s) => s.id === 'scene-1')!
s1.cues = s1.cues.filter((c) => c.characterId !== 'char-lin' && c.characterId !== 'char-landlord')
assert.deepEqual(actorsOfScene(mutated, 'scene-1'), ['陈默'], 'actor removed with cues')

// 3. S03（周岚）改派到 batch-1：S01 已在 batch-1 内，同批次合并不算冲突；
//    要挡的是“另一个批次”同日同时段。构造 batch-x（10-08 上午）放入 S04 再试。
assert.deepEqual(previewAssignConflicts(doc, 'scene-3', 'batch-1'), [], 'merge into same batch is allowed')
const doc2 = clone(doc)
doc2.batches.push({ id: 'batch-x', name: '插批次', date: '2026-10-08', slot: '上午' })
doc2.scenes.push({
  id: 'scene-4', code: 'S04', title: '加录场', location: '棚A', timeOfDay: '夜', transition: '', durationLimit: 60,
  batchId: 'batch-x',
  cues: [{ id: 'cue-4-1', kind: 'dialogue', characterId: 'char-landlord', text: '我也在。', emotion: '自然', rate: 1, transition: '' }]
})
// S03（周岚、陈默）对同档的另一个批次：batch-1 的 S01 有两个共同演员；
// S04 虽也同档但属于本次目标 batch-x 内部并入，不拦截。
let conflicts = previewAssignConflicts(doc2, 'scene-3', 'batch-x')
assert.equal(conflicts.length, 2)
const keyOf = (c: (typeof conflicts)[number]) => `${c.actor}@${c.otherSceneId}`
assert.deepEqual(conflicts.map(keyOf).sort(), ['周岚@scene-1', '陈默@scene-1'])
assert.ok(conflicts.every((c) => c.batchId === 'batch-x' && c.otherBatchId !== 'batch-x'))

// 4. 同天下午（batch-2）不冲突；跨天上午（batch-3 已在）由撤出处理
assert.deepEqual(previewAssignConflicts(doc, 'scene-3', 'batch-2'), [], 'same date different slot ok')
assert.deepEqual(previewAssignConflicts(doc, 'scene-1', ''), [], 'unschedule never conflicts')

// 5. 改批次日期/时段：batch-2 改成 10-09 上午 → 与 batch-3 的 S03 撞（周岚、陈默）
const editConflicts = previewBatchEditConflicts(doc, 'batch-2', { date: '2026-10-09', slot: '上午' })
const editActors = editConflicts.map((c) => c.actor).sort()
assert.deepEqual(editActors, ['周岚', '陈默'])
assert.ok(editConflicts.every((c) => new Set([c.sceneId, c.otherSceneId]).size === 2))

// 6. 旧数据迁移：没有 batches 字段时按未排期打开，原数据不变
const old = clone(doc)
delete (old as Partial<StudioDocument>).batches
for (const s of old.scenes) delete s.batchId
if (!Array.isArray((old as StudioDocument).batches)) (old as StudioDocument).batches = []
assert.deepEqual(findBatchConflicts(old), [], 'old data unscheduled')
assert.equal(old.scenes[0].cues.length, 6, 'original cues intact')
assert.deepEqual(actorsOfScene(old, 'scene-1').sort(), ['周岚', '陈默'])

// 7. 稳态冲突检测：S03 已落在 batch-x（与 batch-1 同日同时段）后应被全局检查发现
const broken = clone(doc2)
broken.scenes.find((s) => s.id === 'scene-3')!.batchId = 'batch-x'
const steady = findBatchConflicts(broken)
const steadyKeys = steady.map((c) => `${c.actor}@${[c.sceneId, c.otherSceneId].sort().join('|')}`).sort()
assert.deepEqual(steadyKeys, ['周岚@scene-1|scene-3', '周岚@scene-1|scene-4', '陈默@scene-1|scene-3'])

console.log('all batch logic assertions passed')
