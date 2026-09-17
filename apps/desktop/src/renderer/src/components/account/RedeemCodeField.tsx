import { AlertCircle, CheckCircle2, ChevronDown, LoaderCircle, TicketCheck } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'
import './RedeemCodeField.css'

type RedeemState = 'idle' | 'validating' | 'valid' | 'invalid' | 'error'

function isInvalidRedeemError(error:unknown):boolean{
  return error instanceof Error&&/INVITATION_CODE_INVALID|invitation code is invalid|invalid or unavailable/i.test(error.message)
}

export function useRedeemCode() {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [state, setState] = useState<RedeemState>('idle')

  const change = (value:string) => {
    setCode(value.toUpperCase())
    setState('idle')
  }

  const prepare = async ():Promise<string|undefined> => {
    const normalized=code.trim().toUpperCase()
    if(!normalized)return undefined
    if(state!=='valid'){
      const accountApi=window.nxcore?.account
      if(!accountApi)throw new Error('Account service is unavailable')
      setState('validating')
      try{
        await accountApi.validateInvitationCode(normalized)
        setState('valid')
      }catch(error){
        setState(isInvalidRedeemError(error)?'invalid':'error')
        throw error
      }
    }
    return normalized
  }

  const reset = () => {
    setCode('')
    setState('idle')
    setOpen(false)
  }

  return { open, setOpen, code, state, change, prepare, reset, markInvalid:()=>setState('invalid') }
}

export function RedeemCodeField({value,state,open,disabled,onChange,onToggle,onVerify}:{value:string;state:RedeemState;open:boolean;disabled:boolean;onChange(value:string):void;onToggle():void;onVerify():void}){
  const{t}=useLocale()
  const feedback=state==='valid'
    ?{tone:'valid',text:t('surface:settings.redeemCodeValid')}
    :state==='invalid'
      ?{tone:'invalid',text:t('surface:settings.redeemCodeInvalid')}
      :state==='error'
        ?{tone:'invalid',text:t('surface:settings.redeemCodeValidationFailed')}
        :null
  const canVerify=!disabled&&Boolean(value.trim())&&state!=='validating'

  return <div className="redeem-code-field" data-open={open} data-state={state}>
    <button type="button" className="redeem-code-toggle" aria-expanded={open} disabled={disabled} onClick={onToggle}>
      <span className="redeem-code-ticket" aria-hidden="true"><TicketCheck/></span>
      <span className="redeem-code-heading">
        <strong>{t('surface:settings.haveRedeemCode')}</strong>
        <small>{t('surface:settings.redeemCodeBenefit')}</small>
      </span>
      <span className="redeem-code-disclosure" aria-hidden="true"><ChevronDown/></span>
    </button>
    {open?<div className="redeem-code-body">
      <label className="redeem-code-input">
        <span className="redeem-code-input-label">{t('surface:settings.redeemCodeLabel')}</span>
        <input autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={32} disabled={disabled} placeholder="ER-XXXX-XXXX-XXXX" value={value}
          onChange={event=>onChange(event.target.value)}
          onKeyDown={event=>{if(event.key==='Enter'&&canVerify){event.preventDefault();onVerify()}}}/>
        <span className="redeem-code-input-state" aria-hidden="true">
          {state==='validating'?<LoaderCircle className="spin"/>:state==='valid'?<CheckCircle2 className="valid"/>:state==='invalid'||state==='error'?<AlertCircle className="invalid"/>:null}
        </span>
      </label>
      <div className="redeem-code-foot">
        {feedback?<p className={`redeem-code-feedback ${feedback.tone}`} role={feedback.tone==='invalid'?'alert':'status'}>{feedback.text}</p>:null}
        <button type="button" className="redeem-code-verify" disabled={!canVerify} onClick={onVerify}>
          {state==='validating'?<LoaderCircle className="spin" aria-hidden="true"/>:null}
          {t('surface:settings.redeemCodeVerify')}
        </button>
      </div>
    </div>:null}
  </div>
}
