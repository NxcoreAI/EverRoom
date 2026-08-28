import { AlertCircle, CheckCircle2, ChevronDown, LoaderCircle, TicketCheck } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'
import './InvitationCodeField.css'

type InvitationState = 'idle' | 'validating' | 'valid' | 'invalid' | 'error'

function isInvalidInvitationError(error:unknown):boolean{
  return error instanceof Error&&/INVITATION_CODE_INVALID|invitation code is invalid|invalid or unavailable/i.test(error.message)
}

export function useInvitationCode() {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [state, setState] = useState<InvitationState>('idle')

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
        setState(isInvalidInvitationError(error)?'invalid':'error')
        throw error
      }
    }
    return normalized
  }

  return { open, setOpen, code, state, change, prepare, markInvalid:()=>setState('invalid') }
}

export function InvitationCodeField({value,state,open,disabled,onChange,onToggle}:{value:string;state:InvitationState;open:boolean;disabled:boolean;onChange(value:string):void;onToggle():void}){
  const{t}=useLocale()
  const feedback=state==='valid'
    ?{tone:'valid',text:t('surface:settings.invitationCodeValid')}
    :state==='invalid'
      ?{tone:'invalid',text:t('surface:settings.invitationCodeInvalid')}
      :state==='error'
        ?{tone:'invalid',text:t('surface:settings.invitationCodeValidationFailed')}
        :null

  return <div className="invitation-code-field" data-open={open} data-state={state}>
    <button type="button" className="invitation-code-toggle" aria-expanded={open} disabled={disabled} onClick={onToggle}>
      <span className="invitation-code-ticket" aria-hidden="true"><TicketCheck/></span>
      <span className="invitation-code-heading">
        <strong>{t('surface:settings.haveInvitationCode')}</strong>
        <small>{t('surface:settings.invitationCodeBenefit')}</small>
      </span>
      <span className="invitation-code-disclosure" aria-hidden="true"><ChevronDown/></span>
    </button>
    {open?<div className="invitation-code-body">
      <label className="invitation-code-input">
        <span className="invitation-code-input-label">{t('surface:settings.invitationCodeLabel')}</span>
        <input autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={32} disabled={disabled} placeholder="ER-XXXX-XXXX-XXXX" value={value} onChange={event=>onChange(event.target.value)}/>
        <span className="invitation-code-input-state" aria-hidden="true">
          {state==='validating'?<LoaderCircle className="spin"/>:state==='valid'?<CheckCircle2 className="valid"/>:state==='invalid'||state==='error'?<AlertCircle className="invalid"/>:null}
        </span>
      </label>
      {feedback?<p className={`invitation-code-feedback ${feedback.tone}`} role={feedback.tone==='invalid'?'alert':'status'}>{feedback.text}</p>:null}
    </div>:null}
  </div>
}
