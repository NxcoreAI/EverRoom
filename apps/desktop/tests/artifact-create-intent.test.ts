import { describe, expect, it } from 'vitest'

import {
  consumeArtifactCreateIntent,
  requestArtifactCreateIntent,
} from '../src/renderer/src/components/context-room/artifactCreateIntent'

describe('产物库自动展开新建面板的一次性意图', () => {
  it('目标 Room 匹配时消费成功，且只生效一次', () => {
    requestArtifactCreateIntent('room-a')
    expect(consumeArtifactCreateIntent('room-a')).toBe(true)
    // 一次性：浮层重挂载（如切换板块再回来）不应再次自动展开。
    expect(consumeArtifactCreateIntent('room-a')).toBe(false)
  })

  it('Room 不匹配时不触发，并清掉陈旧意图', () => {
    requestArtifactCreateIntent('room-a')
    expect(consumeArtifactCreateIntent('room-b')).toBe(false)
    // 用户中途改看别的 Room 后，原意图不应在之后误触发。
    expect(consumeArtifactCreateIntent('room-a')).toBe(false)
  })

  it('没有登记意图时消费返回 false', () => {
    expect(consumeArtifactCreateIntent('room-a')).toBe(false)
  })
})
