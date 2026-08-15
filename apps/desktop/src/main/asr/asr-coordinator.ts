import type { AsrJob,CreateAsrJobInput } from '../../shared/sources'
import type { SaasClient } from '../cloud/saas-client'
import type { AsrGatewayBridge } from '../gateway/asr-gateway-bridge'
import type { RealityGatewayBridge } from '../gateway/reality-gateway-bridge'

export class AsrCoordinator {
  constructor(
    private readonly local:AsrGatewayBridge,
    private readonly cloud:SaasClient,
    private readonly reality:RealityGatewayBridge,
  ){}
  async createJob(input:CreateAsrJobInput):Promise<AsrJob>{const job=input.mode==='cloud'?await this.cloud.createAsrJob(input):{...await this.local.createJob({filePath:input.filePath,languageHints:input.languageHints,diarizationEnabled:input.diarizationEnabled,...(input.contextPrompt?{contextPrompt:input.contextPrompt}:{})}),source:'local' as const};if(input.recordingId)await this.reality.applyAsr(input.recordingId,job);return job}
  async getJob(id:string):Promise<AsrJob>{const job=id.startsWith('saas:')?await this.cloud.getAsrJob(id):{...await this.local.getJob(id),source:'local' as const};await this.reality.applyAsrByJob(job).catch(()=>undefined);return job}
}
