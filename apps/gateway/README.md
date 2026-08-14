# NxCore Gateway

Local-first backend gateway for the OpenNxCore desktop application. The gateway is a standalone Node.js service supervised by Electron in production.

## Development

```bash
pnpm install
pnpm db:generate
pnpm dev -- --data-dir .data --port 3210 --token local-development-token
```

The API documentation is available at `http://127.0.0.1:3210/docs`. Health endpoints do not require authentication; all other endpoints require `Authorization: Bearer <token>`.

When the gateway is ready it writes `<data-dir>/runtime/gateway.json`. Electron can wait for this file to discover the selected port and authentication token. Consumers must verify the manifest PID and health endpoint because an ungraceful process termination can leave stale runtime state.

Structured JSON logs are written to daily files under `<data-dir>/logs/` using
the name `gateway.YYYY-MM-DD.N.log`. The active file is rolled at midnight and
30 historical files are retained. Console logs use readable local timestamps.

In production Electron should generate a fresh high-entropy token, start the gateway with `--port 0 --token <token>`, and wait for the runtime manifest before loading application data.

## Alibaba Cloud ASR

Long-recording ASR is disabled by default. Users enable it with their own Alibaba Cloud Model Studio credentials:

```bash
NXCORE_ASR_PROVIDER=aliyun
NXCORE_ASR_ALIYUN_API_KEY=
NXCORE_ASR_ALIYUN_BASE_URL=https://dashscope.aliyuncs.com/api/v1
NXCORE_ASR_ALIYUN_MODEL=qwen-audio-3.0-asr-flash-filetrans
```

For an international workspace, set `NXCORE_ASR_ALIYUN_BASE_URL` to that workspace's regional HTTPS `/api/v1` endpoint. API keys are only read by the gateway and must not be exposed to the Electron renderer or committed to the repository.

Recordings must be non-empty files under `<data-dir>/recordings`. Create a job with `POST /v1/asr/jobs`:

```json
{
  "filePath": "meeting.wav",
  "languageHints": ["zh", "en"],
  "diarizationEnabled": true
}
```

The gateway returns a local job with HTTP 202. Poll `GET /v1/asr/jobs/:id`; while running, the gateway refreshes the Alibaba Cloud task. The Alibaba provider obtains a temporary upload policy, streams the local file to the returned OSS host, submits FileTrans, and stores the provider result in the existing SQLite `jobs` table.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```
