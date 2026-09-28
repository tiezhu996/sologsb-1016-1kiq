// @vitest-environment node
// 直接调用 useStudio().makeScript 验证制作稿的批次/日期段落
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
}
;(globalThis as any).window = {
  clearTimeout: clearTimeout.bind(globalThis),
  setTimeout: setTimeout.bind(globalThis)
}

const { useStudio } = await import('../src/useStudio')
const studio = useStudio()
studio.state.value.document.scenes[2].batchId = undefined // 让 S03 变成未排期，验证降级文案

const script = studio.makeScript(studio.state.value.document)
console.log(script)

if (!script.includes('【录制日程】')) throw new Error('missing schedule section')
if (!script.includes('第一批次｜日期：2026-10-08｜时段：上午')) throw new Error('missing batch line')
if (!script.includes('到场演员：周岚、陈默')) throw new Error('missing actors line')
if (!script.includes('未排期：S03')) throw new Error('missing unscheduled summary')
if (!script.includes('录制：第一批次｜2026-10-08 上午')) throw new Error('missing per-scene recording line')
if (!script.includes('录制：未排期（待归入录制批次）')) throw new Error('missing per-scene unscheduled line')
console.log('\nmakeScript assertions passed')
