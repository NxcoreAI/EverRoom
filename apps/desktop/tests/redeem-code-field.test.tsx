import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import { RedeemCodeField } from '../src/renderer/src/components/account/RedeemCodeField'

const AUTO_APPLY_HINT = '通过 Apple 或 Google 登录时会自动使用此兑换码，无需其他操作'
const SIGN_OUT_HINT = '兑换码需在登录时使用：退出登录后，在登录页输入此码并通过 Apple / Google 重新登录即可生效'

function renderField(state: 'idle' | 'valid' | 'invalid', signedIn: boolean) {
  return TestRenderer.create(
    <RedeemCodeField
      value="ER-2345-ABCD-JKLM"
      state={state}
      open
      disabled={false}
      signedIn={signedIn}
      onChange={() => undefined}
      onToggle={() => undefined}
      onVerify={() => undefined}
    />,
  )
}

describe('RedeemCodeField apply hint (#258)', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
  })

  it('在登录页核验通过后提示将随登录自动使用', () => {
    act(() => { renderer = renderField('valid', false) })
    const hints = renderer!.root.findAllByProps({ className: 'redeem-code-apply-hint' })
    expect(hints).toHaveLength(1)
    expect(hints[0].props.role).toBe('status')
    expect(hints[0].props.children).toBe(AUTO_APPLY_HINT)
  })

  it('已登录场景核验通过后提示退登重登兑换', () => {
    act(() => { renderer = renderField('valid', true) })
    const hints = renderer!.root.findAllByProps({ className: 'redeem-code-apply-hint' })
    expect(hints[0].props.children).toBe(SIGN_OUT_HINT)
  })

  it('无效码与初始态不显示使用指引', () => {
    act(() => { renderer = renderField('invalid', false) })
    expect(renderer!.root.findAllByProps({ className: 'redeem-code-apply-hint' })).toHaveLength(0)
    renderer?.unmount()
    act(() => { renderer = renderField('idle', true) })
    expect(renderer!.root.findAllByProps({ className: 'redeem-code-apply-hint' })).toHaveLength(0)
  })
})
