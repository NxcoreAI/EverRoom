import { describe, expect, it } from 'vitest'

import { isSaasPermanentError, SaasRequestError } from './saas-client'

describe('isSaasPermanentError', () => {
  it('treats 402 quota exhaustion as permanent', () => {
    expect(isSaasPermanentError(new SaasRequestError('额度不足', 402, 'ASR_QUOTA_INSUFFICIENT'))).toBe(true)
  })

  it('treats 409 ASR_DEVICE_MISMATCH as permanent but not other 409s', () => {
    expect(isSaasPermanentError(new SaasRequestError('设备不一致', 409, 'ASR_DEVICE_MISMATCH'))).toBe(true)
    expect(isSaasPermanentError(new SaasRequestError('任务冲突', 409, 'CONFLICT'))).toBe(false)
    expect(isSaasPermanentError(new SaasRequestError('任务冲突', 409))).toBe(false)
  })

  it('ignores transient errors', () => {
    expect(isSaasPermanentError(new SaasRequestError('限流', 429, 'HTTP_429'))).toBe(false)
    expect(isSaasPermanentError(new Error('网络断开'))).toBe(false)
    expect(isSaasPermanentError(undefined)).toBe(false)
  })
})
