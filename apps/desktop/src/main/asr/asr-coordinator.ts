import type { AsrJob,CreateAsrJobInput } from '../../shared/sources'
import type { SaasClient } from '../cloud/saas-client'
import type { AsrGatewayBridge } from '../gateway/asr-gateway-bridge'
import type { RealityGatewayBridge } from '../gateway/reality-gateway-bridge'
import type { PrivateAudioSyncService } from '../transcription/private-audio-sync'

export class AsrCoordinator {
  constructor(
    private readonly local:AsrGatewayBridge,
    private readonly cloud:SaasClient,
    private readonly reality:RealityGatewayBridge,
    private readonly audioSync?: PrivateAudioSyncService,
  ){}
  async createJob(input:CreateAsrJobInput):Promise<AsrJob>{
    if (input.recordingId && this.audioSync) {
      try { await this.audioSync.upload(input.filePath, input.recordingId, Math.max(0, input.durationMs ?? 0), 'audio/mp4') }
      catch (error) { console.warn('Private audio sync deferred', error) }
    }
    const job=input.mode==='cloud'?await this.cloud.createAsrJob(input):{...await this.local.createJob({filePath:input.filePath,languageHints:input.languageHints,diarizationEnabled:input.diarizationEnabled,...(input.contextPrompt?{contextPrompt:input.contextPrompt}:{})}),source:'local' as const};if(input.recordingId)await this.reality.applyAsr(input.recordingId,job);return job}
  async getJob(id:string):Promise<AsrJob>{const job=id.startsWith('saas:')?await this.cloud.getAsrJob(id):{...await this.local.getJob(id),source:'local' as const};await this.reality.applyAsrByJob(job).catch(()=>undefined);return job}
}
