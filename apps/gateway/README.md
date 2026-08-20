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
NXCORE_ASR_ALIYUN_OSS_REGION=oss-cn-beijing
NXCORE_ASR_ALIYUN_OSS_BUCKET=
NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_ID=
NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_SECRET=
NXCORE_ASR_ALIYUN_OSS_PREFIX=nxcore-asr
```

For an international workspace, set `NXCORE_ASR_ALIYUN_BASE_URL` and the OSS region to matching regional endpoints. API and OSS keys are only read by the gateway and must not be exposed to the Electron renderer or committed to the repository. Use a private Bucket and a RAM policy restricted to the configured Bucket and prefix. An STS token can be supplied with `NXCORE_ASR_ALIYUN_OSS_STS_TOKEN`.

Recordings must be non-empty files under `<data-dir>/recordings`. Create a job with `POST /v1/asr/jobs`:

```json
{
  "filePath": "meeting.wav",
  "languageHints": ["zh", "en"],
  "diarizationEnabled": true
}
```

The gateway returns a local job with HTTP 202. Poll `GET /v1/asr/jobs/:id`; while running, the gateway refreshes the Alibaba Cloud task. The provider uploads to the private Bucket, submits a six-hour signed HTTPS URL to FileTrans, and deletes the object after the task reaches a terminal state. Configure a 24-hour Bucket lifecycle rule as cleanup fallback. FileTrans submission fails immediately with an actionable configuration error when OSS is missing; Model Studio's temporary private upload is not used because it is not readable by this model in every region.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Mail connectors

The optional connector manager uses an externally operated self-hosted Nango instance for OAuth and provider proxying. Set both `NXCORE_NANGO_URL` and `NXCORE_NANGO_SECRET`; HTTPS is required except for a loopback development server. Gmail and Outlook provider configuration keys default to `google-mail` and `microsoft-mail`.

EverRoom starts Nango Connect Sessions on behalf of the user. The user selects Gmail or Outlook in the desktop console, completes authorization in the system browser, and EverRoom polls Nango by a server-generated attempt tag before registering the connection automatically. The Nango key must include `environment:connect_sessions:write` and `environment:connections:list`; it remains in Gateway and is never exposed to the renderer. Self-hosted Nango must serve Connect UI (`FLAG_SERVE_CONNECT_UI=true`) and configure `NANGO_PUBLIC_CONNECT_URL`. The one-time Nango integrations and Google/Microsoft OAuth applications remain operator configuration, but end users never need Nango console access or a Connection ID.

Connector state and structured records are stored in `<data-dir>/database/connectors.sqlite`. Mail is normalized into a versioned JSON envelope in `connector_records`; the existing relational mail tables remain as query indexes. Consumers can read the JSON representation from `GET /v1/connectors/connections/:id/records?type=mail`. Calendar records use the same envelope with `type=calendar`.

Document connectors write Markdown files under `<data-dir>/connectors/documents/<provider>/<connection-id>/`. Connector documents are not sent to MemoryCore or the Evidence pipeline. Access tokens and arbitrary raw provider responses are never stored.

The connector database has its own schema and lifecycle and is not part of `gateway.sqlite`. The gateway owns polling and provider cursors; Nango schedules for these connections must remain disabled. All `/v1/connectors/*` routes use the normal gateway bearer token.

For desktop development, set `NXCORE_CONNECTOR_DEBUG_UI=1` in the repository root `.env`, then open **Settings > Developer Tools > Connector Debug Console**. The console is intentionally absent from normal navigation. `NXCORE_CONNECTOR_DEBUG_FAULTS=1` only reveals the fault controls; the real Nango executor rejects fault injection unless a mock executor is installed.
