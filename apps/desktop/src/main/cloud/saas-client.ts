import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'

import type { App } from 'electron'

import type { AsrJob, CloudAccountStatus, CreateAsrJobInput } from '../../shared/sources'
import type { CredentialStore } from '../security/credential-store'

const REFRESH_TOKEN_KEY = 'everroom:saas:refresh-token'
const DEVICE_KEY_KEY = 'everroom:saas:device-key'

interface LoginResult {
  accessToken: string
  refreshToken: string
  user: { id:string; tenantId:string; email?:string|null; phone?:string|null; name?:string }
  device: { id:string; name?:string; platform?:string }
}

interface CloudJob {
  id:string
  status:string
  provider:string
  fileName:string
  transcript?:string|null
  segments?: Array<{text:string;beginTime:number;endTime:number;speakerId:number|null}>
  errorCode?:string|null
  errorMessage?:string|null
  createdAt:string
  updatedAt:string
}

interface UploadAuthorization { uploadUrl:string; objectKey:string; headers:Record<string,string> }

export class SaasClient {
  private accessToken:string|null=null
  private account:LoginResult|null=null
  readonly baseUrl:string

  constructor(private readonly credentials:CredentialStore,private readonly electronApp:App,private readonly recordingsDirectory:string){
    this.baseUrl=(process.env.NXCORE_SAAS_API_URL?.trim()||'http://127.0.0.1:4100/api/v1').replace(/\/+$/,'')
  }

  async initialize():Promise<void>{const refreshToken=await this.credentials.get(REFRESH_TOKEN_KEY);if(!refreshToken)return;try{await this.refresh(refreshToken)}catch{await this.credentials.delete(REFRESH_TOKEN_KEY)}}
  status():CloudAccountStatus{return{authenticated:Boolean(this.accessToken&&this.account),apiBaseUrl:this.baseUrl,...(this.account?{user:this.account.user,device:this.account.device}:{})}}

  async login(identifier:string,password:string):Promise<CloudAccountStatus>{
    if(!identifier.trim()||!password)throw new Error('请输入账号和密码。')
    const deviceKey=await this.deviceKey()
    const data=await this.publicRequest<LoginResult>('/app/auth/password-login',{method:'POST',body:JSON.stringify({identifier:identifier.trim(),password,deviceKey,deviceName:hostname()||'EverRoom Desktop',platform:process.platform==='win32'?'Windows':'macOS',appVersion:this.electronApp.getVersion()})})
    await this.acceptSession(data);return this.status()
  }

  async logout():Promise<CloudAccountStatus>{const refreshToken=await this.credentials.get(REFRESH_TOKEN_KEY);if(refreshToken)await this.publicRequest('/app/auth/logout',{method:'POST',body:JSON.stringify({refreshToken})}).catch(()=>undefined);this.accessToken=null;this.account=null;await this.credentials.delete(REFRESH_TOKEN_KEY);return this.status()}

  async createAsrJob(input:CreateAsrJobInput):Promise<AsrJob>{
    this.requireLogin();const filePath=this.resolveRecording(input.filePath);const info=await stat(filePath);if(!info.isFile()||info.size===0)throw new Error('录音文件不存在或为空。')
    const contentHash=await this.hashFile(filePath);const recordingId=input.recordingId??randomUUID();const mimeType=this.mimeType(filePath)
    const job=await this.request<CloudJob>('/app/asr-jobs',{method:'POST',body:JSON.stringify({deviceId:this.account!.device.id,recordingId,originPlatform:'desktop',fileName:basename(filePath),mimeType,fileSize:info.size,contentHash,estimatedDurationMs:Math.max(1000,input.durationMs??1000),idempotencyKey:`recording:${recordingId}:asr:v1`,languageHints:input.languageHints??[],diarizationEnabled:input.diarizationEnabled,...(input.contextPrompt?{contextPrompt:input.contextPrompt}:{})})})
    if(job.status==='awaiting_upload'){
      const authorization=await this.request<UploadAuthorization>(`/app/asr-jobs/${job.id}/upload-authorization`,{method:'POST'})
      await this.upload(filePath,info.size,authorization)
      const queued=await this.request<CloudJob>(`/app/asr-jobs/${job.id}/upload-complete`,{method:'POST',body:JSON.stringify({objectKey:authorization.objectKey})})
      return this.normalizeJob(queued)
    }
    return this.normalizeJob(job)
  }

  async getAsrJob(prefixedId:string):Promise<AsrJob>{const id=this.cloudId(prefixedId);const job=await this.request<CloudJob>(`/app/asr-jobs/${id}`);if(job.status==='completed'){const result=await this.request<{rawTranscript:string;segments:CloudJob['segments']}>(`/app/asr-jobs/${id}/result`);job.transcript=result.rawTranscript;job.segments=result.segments}return this.normalizeJob(job)}

  private async upload(filePath:string,size:number,authorization:UploadAuthorization){const body=Readable.toWeb(createReadStream(filePath)) as BodyInit;const response=await fetch(authorization.uploadUrl,{method:'PUT',headers:{...authorization.headers,'Content-Length':String(size)},body,duplex:'half'} as RequestInit&{duplex:'half'});if(!response.ok)throw new Error(`OSS 上传失败（${response.status}）`)}
  private async refresh(refreshToken:string){const data=await this.publicRequest<LoginResult>('/app/auth/refresh',{method:'POST',body:JSON.stringify({refreshToken})});await this.acceptSession(data)}
  private async acceptSession(data:LoginResult){this.accessToken=data.accessToken;this.account=data;await this.credentials.setNamed(REFRESH_TOKEN_KEY,data.refreshToken)}
  private async deviceKey(){const existing=await this.credentials.get(DEVICE_KEY_KEY);if(existing)return existing;const value=randomUUID();await this.credentials.setNamed(DEVICE_KEY_KEY,value);return value}

  private async request<T>(path:string,init:RequestInit={}):Promise<T>{this.requireLogin();let response=await this.fetch(path,init,this.accessToken!);if(response.status===401){const refreshToken=await this.credentials.get(REFRESH_TOKEN_KEY);if(!refreshToken)throw new Error('登录已过期，请重新登录。');await this.refresh(refreshToken);response=await this.fetch(path,init,this.accessToken!)}return this.unwrap<T>(response)}
  private async publicRequest<T>(path:string,init:RequestInit):Promise<T>{return this.unwrap<T>(await this.fetch(path,init))}
  private fetch(path:string,init:RequestInit,token?:string){return fetch(`${this.baseUrl}${path}`,{...init,headers:{Accept:'application/json',...(init.body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{}) ,...init.headers}})}
  private async unwrap<T>(response:Response):Promise<T>{const body=await response.json().catch(()=>null) as {data?:T;detail?:string;message?:string}|null;if(!response.ok)throw new Error(body?.detail??body?.message??`SaaS 请求失败（${response.status}）`);if(!body||!('data'in body))throw new Error('SaaS 返回了无效响应。');return body.data as T}
  private requireLogin(){if(!this.accessToken||!this.account)throw new Error('请先登录 EverRoom，或切换为本地自有配置。')}
  private resolveRecording(fileName:string){const candidate=isAbsolute(fileName)?fileName:join(this.recordingsDirectory,fileName);const resolved=resolve(candidate);const fromRoot=relative(resolve(this.recordingsDirectory),resolved);if(fromRoot.startsWith('..')||isAbsolute(fromRoot))throw new Error('录音文件不在允许的目录中。');return resolved}
  private hashFile(filePath:string){return new Promise<string>((resolveHash,reject)=>{const hash=createHash('sha256');const stream=createReadStream(filePath);stream.on('data',chunk=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>resolveHash(hash.digest('hex')))})}
  private mimeType(filePath:string){const types:Record<string,string>={'.m4a':'audio/mp4','.mp4':'video/mp4','.webm':'audio/webm','.ogg':'audio/ogg','.wav':'audio/wav','.mp3':'audio/mpeg','.flac':'audio/flac','.aac':'audio/aac'};return types[extname(filePath).toLowerCase()]??'audio/webm'}
  private cloudId(value:string){if(!value.startsWith('saas:'))throw new Error('无效的云端转写任务标识。');return value.slice(5)}
  private normalizeJob(job:CloudJob):AsrJob{const terminal=new Set(['completed','failed','cancelled']);return{id:`saas:${job.id}`,source:'saas',provider:job.provider,status:job.status==='completed'?'completed':job.status==='failed'?'failed':job.status==='cancelled'||job.status==='expired'?'cancelled':terminal.has(job.status)?'failed':'running',fileName:job.fileName,languageHints:[],diarizationEnabled:true,contextPrompt:'',result:job.status==='completed'&&job.transcript?{transcript:job.transcript,segments:job.segments??[]}:null,error:job.errorMessage??job.errorCode??null,createdAt:job.createdAt,updatedAt:job.updatedAt}}
}
