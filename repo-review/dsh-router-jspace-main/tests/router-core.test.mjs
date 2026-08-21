import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTask, coreFor, guideFor, isChatTask, modulesFor, parseMode, passFor,
  personaFor, applyPersona, addCognitionSection, MODE_REACT, MODE_SPEC, MODE_WEAK,
} from '../integrated-preset/router-jspace/router-core.mjs'

test('classifyTask chooses stable bands', () => {
  assert.equal(classifyTask('写一个网页游戏'), MODE_REACT)
  assert.equal(classifyTask('修复这个报错并排查原因'), MODE_SPEC)
  assert.equal(classifyTask('分析一下这份代码'), MODE_WEAK)
})

test('chat detection stands down short greetings', () => {
  assert.equal(isChatTask('你好'), true)
  assert.equal(isChatTask('hello!'), true)
  assert.equal(isChatTask('写一个脚本'), false)
})

test('passFor maps loop/complex/simple tasks', () => {
  assert.equal(passFor('完成仓库级多文件重构并跨文件保持一致'), 'loop')
  assert.equal(passFor('详细分析一下这个项目的架构'), 'full')
  assert.equal(passFor('你好'), 'fast')
})

test('modulesFor follows pass and task type', () => {
  assert.deepEqual(modulesFor('fast', '你好'), [])
  assert.deepEqual(modulesFor('loop', '长程任务'), ['capacity', 'broadcast', 'markers', 'self-monitoring'])
  assert.ok(modulesFor('full', '修复这个 bug').includes('introspection'))
  assert.ok(modulesFor('full', '写一个工具').includes('directed-focus'))
})

test('guideFor carries router and oh-we-need signals', () => {
  const guide = guideFor({
    round: 1,
    text: '写一个工具',
    modelId: 'deepseek-v4-flash',
    mode: MODE_REACT,
    pass: 'full',
    modules: ['directed-focus', 'empirics'],
  })
  assert.match(guide, /classify this task/)
  assert.match(guide, /We need one concrete next action/)
  assert.match(guide, /J-space pass: full/)
  assert.match(guide, /directed-focus/)
})

test('round 3 guide forces fresh classification', () => {
  const guide = guideFor({
    round: 3,
    text: '详细设计一个复杂的系统页面',
    modelId: 'deepseek-v4-pro',
    mode: MODE_WEAK,
    pass: 'loop',
    modules: ['capacity', 'broadcast'],
  })
  assert.match(guide, /NEW task/)
  assert.match(guide, /decision or an information need/)
})

test('personaFor uses model-specific weak text', () => {
  assert.match(personaFor(MODE_WEAK, 'deepseek-v4-flash'), /Think deeply first/)
  assert.match(personaFor(MODE_WEAK, 'deepseek-v4-pro'), /helpful software engineer assistant/)
})

test('coreFor keeps measured first-turn surfaces', () => {
  assert.deepEqual(coreFor(MODE_SPEC), ['read', 'edit', 'glob', 'grep'])
  assert.deepEqual(coreFor(MODE_REACT), ['read', 'write', 'edit'])
  assert.deepEqual(coreFor(MODE_WEAK), ['str_replace_editor'])
})

test('applyPersona replaces persona but preserves plan section', () => {
  const sections = [
    { name: 'persona', text: 'old', order: 0 },
    { name: 'plan', text: 'keep', order: 100 },
  ]
  const result = applyPersona(sections, 'new persona')
  assert.equal(result.find((s) => s.name === 'persona'), undefined)
  assert.equal(result.find((s) => s.name === 'plan')?.text, 'keep')
  assert.equal(result.find((s) => s.name === 'router-persona')?.text, 'new persona')
})

test('addCognitionSection appends the static protocol', () => {
  const result = addCognitionSection([{ name: 'plan', text: 'keep', order: 100 }])
  assert.equal(result.find((s) => s.name === 'cognition-protocol')?.text.length > 100, true)
})

test('parseMode accepts names, percents and decimals', () => {
  assert.equal(parseMode('spec'), MODE_SPEC)
  assert.equal(parseMode('weak'), MODE_WEAK)
  assert.equal(parseMode('react'), MODE_REACT)
  assert.equal(parseMode('50'), 0.5)
  assert.equal(parseMode('0.3'), 0.3)
  assert.equal(parseMode('auto'), 'auto')
  assert.equal(parseMode('nonsense'), null)
})
