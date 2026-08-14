import type { AsrJob,CreateAsrJobInput } from '../../shared/sources'
import type { SaasClient } from '../cloud/saas-client'
import type { AsrGatewayBridge } from '../gateway/asr-gateway-bridge'

export class AsrCoordinator {
  constructor(private readonly local:AsrGatewayBridge,private readonly cloud:SaasClient){}
  createJob(input:CreateAsrJobInput):Promise<AsrJob>{if(input.mode==='cloud')return this.cloud.createAsrJob(input);const localInput={filePath:input.filePath,languageHints:input.languageHints,diarizationEnabled:input.diarizationEnabled,...(input.contextPrompt?{contextPrompt:input.contextPrompt}:{})};return this.local.createJob(localInput).then(job=>({...job,source:'local'}))}
  getJob(id:string):Promise<AsrJob>{return id.startsWith('saas:')?this.cloud.getAsrJob(id):this.local.getJob(id).then(job=>({...job,source:'local'}))}
}
