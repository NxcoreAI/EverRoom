import { SEGMENT_JOB_PREFIX } from '../recording/recording-segment-uploader'
import type { AsrJob,CreateAsrJobInput } from '../../shared/sources'
import type { SaasClient } from '../cloud/saas-client'
import type { AsrGatewayBridge } from '../gateway/asr-gateway-bridge'
import type { RealityGatewayBridge } from '../gateway/reality-gateway-bridge'
import type { PrivateAudioSyncService } from '../transcription/private-audio-sync'
import type { PrivateTranscriptionSyncService } from '../transcription/private-transcription-sync'
import type { RecordingSegmentUploader } from '../recording/recording-segment-uploader'

export class AsrCoordinator {
  constructor(
    private readonly local:AsrGatewayBridge,
    private readonly cloud:SaasClient,
    private readonly reality:RealityGatewayBridge,
    private readonly audioSync?:PrivateAudioSyncService,
    private readonly transcriptionSync?:PrivateTranscriptionSyncService,
    private readonly segmentUploader?:RecordingSegmentUploader,
  ){}
  async createJob(input:CreateAsrJobInput):Promise<AsrJob>{
    const useSegments = input.mode==='cloud'&&!!input.recordingId&&!!this.segmentUploader
    if (input.recordingId && this.audioSync) {
      const upload = this.audioSync.upload(input.filePath, input.recordingId, Math.max(0, input.durationMs ?? 0), 'audio/mp4')
      if (useSegments) {
        // 分段路径音频早已在云端，备份转入后台，不阻塞转写；失败自入队下次启动补传。
        upload.catch((error) => { console.warn('Private audio sync deferred', error) })
      } else {
        try { await upload } catch (error) { console.warn('Private audio sync deferred', error) }
      }
    }
    if(useSegments){
      // 录制中已按分钟边录边转：停止时等全部转完、合并成整篇结果；
      // 任一分钟失败则回退整段上传老路。
      const segmented=await this.segmentUploader!.finalize(input.recordingId!)
      if(segmented){const event=await this.reality.applyAsr(input.recordingId!,segmented);await this.publish(event,segmented);return segmented}
      input={...input,retryToken:input.retryToken??'seg-fallback'}
    }
    const job=input.mode==='cloud'?await this.cloud.createAsrJob(input):{...await this.local.createJob({filePath:input.filePath,languageHints:input.languageHints,diarizationEnabled:input.diarizationEnabled,...(input.contextPrompt?{contextPrompt:input.contextPrompt}:{})}),source:'local' as const};if(input.recordingId){const event=await this.reality.applyAsr(input.recordingId,job);await this.publish(event,job)}return job
  }
  async getJob(id:string):Promise<AsrJob>{
    if(id.startsWith(SEGMENT_JOB_PREFIX)&&this.segmentUploader){
      const recordingId=id.slice(SEGMENT_JOB_PREFIX.length)
      const job=await this.segmentUploader.getMergedJob(recordingId)
      if(!job)throw new Error('转写任务不存在或已过期。')
      if(job.status==='completed'){const event=await this.reality.applyAsrByJob(job).catch(()=>undefined);if(event)await this.publish(event,job)}
      return job
    }
    const job=id.startsWith('saas:')?await this.cloud.getAsrJob(id):{...await this.local.getJob(id),source:'local' as const};const event=await this.reality.applyAsrByJob(job).catch(()=>undefined);if(event)await this.publish(event,job);return job
  }
  async renameSpeaker(id:string,speakerId:string,name:string|null):Promise<AsrJob>{
    if(id.startsWith(SEGMENT_JOB_PREFIX)&&this.segmentUploader){
      const recordingId=id.slice(SEGMENT_JOB_PREFIX.length)
      const before=await this.segmentUploader.refetchMerged(recordingId)
      if(!before||!before.anchorJobId)throw new Error('分段转写尚未完成，暂时无法标记说话人。')
      // 改名在 SaaS 侧落到用户级声纹会话并联动所有任务快照：用任一已完成分钟任务当锚点。
      await this.cloud.renameAsrSpeaker(`saas:${before.anchorJobId}`,speakerId,name)
      const after=await this.segmentUploader.refetchMerged(recordingId)
      const merged=after!.merged
      // 合并任务的 updatedAt 每次合并现取，天然顶高 resultVersion，本地事件不会被版本守卫跳过。
      const event=await this.reality.applyAsr(recordingId,merged).catch(()=>undefined)
      if(event)await this.publish(event,merged)
      return merged
    }
    if(!id.startsWith('saas:'))throw new Error('仅云端转写支持标记说话人。')
    await this.cloud.renameAsrSpeaker(id,speakerId,name)
    const job=await this.cloud.getAsrJob(id)
    const event=await this.reality.applyAsrByJob(job,Date.now()).catch(()=>undefined)
    if(event)await this.publish(event,job)
    return job
  }
  private async publish(event: Awaited<ReturnType<RealityGatewayBridge['applyAsr']>>, job: AsrJob): Promise<void> {
    if (job.status !== 'completed' || !job.result || !this.transcriptionSync) return
    await this.transcriptionSync.publishLocalTranscription(event, job.result, job.provider).catch((error) => {
      console.warn('Private transcription source publication deferred', error)
    })
  }
}
