export interface UploadedAudio {
  url: string;
  cleanup?: () => Promise<void>;
}

export interface AsrAudioStorage {
  upload(filePath: string, contentType: string): Promise<UploadedAudio>;
}
