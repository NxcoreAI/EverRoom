import type { AsrJob,CreateAsrJobInput } from '../../shared/sources'
import type { SaasClient } from '../cloud/saas-client'
import type { AsrGatewayBridge } from '../gateway/asr-gateway-bridge'
import type { RealityGatewayBridge } from '../gateway/reality-gateway-bridge'
import type { PrivateAudioSyncService } from '../transcription/private-audio-sync'
import type { PrivateTranscriptionSyncService } from '../transcription/private-transcription-sync'

export class AsrCoordinator {
  constructor(
    private readonly local:AsrGatewayBridge,
    private readonly cloud:SaasClient,
    private readonly reality:RealityGatewayBridge,
    private readonly audioSync?: PrivateAudioSyncService,
    private readonly transcriptionSync?: PrivateTranscriptionSyncService,
  ){}
  async createJob(input:CreateAsrJobInput):Promise<AsrJob>{
    if (input.recordingId && this.audioSync) {
      try { await this.audioSync.upload(input.filePath, input.recordingId, Math.max(0, input.durationMs ?? 0), 'audio/mp4') }
      catch (error) { console.warn('Private audio sync deferred', error) }
    }
    const job=input.mode==='cloud'?await this.cloud.createAsrJob(input):{...await this.local.createJob({filePath:input.filePath,languageHints:input.languageHints,diarizationEnabled:input.diarizationEnabled,...(input.contextPrompt?{contextPrompt:input.contextPrompt}:{})}),source:'local' as const};if(input.recordingId){const event=await this.reality.applyAsr(input.recordingId,job);await this.publish(event,job)}return job}
  async getJob(id:string):Promise<AsrJob>{const job=id.startsWith('saas:')?await this.cloud.getAsrJob(id):{...await this.local.getJob(id),source:'local' as const};const event=await this.reality.applyAsrByJob(job).catch(()=>undefined);if(event)await this.publish(event,job);return job}
  private async publish(event: Awaited<ReturnType<RealityGatewayBridge['applyAsr']>>, job: AsrJob): Promise<void> {
    if (job.status !== 'completed' || !job.result || !this.transcriptionSync) return
    await this.transcriptionSync.publishLocalTranscription(event, job.result, job.provider).catch((error) => {
      console.warn('Private transcription source publication deferred', error)
    })
  }
}
