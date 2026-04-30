# R2 + RunningHub Backend

This is the minimal backend for the native iOS app photo retouch workflow.

The iPhone app should never store R2 credentials or a RunningHub API key. It only talks to this backend.

## Flow

```text
iOS App -> POST /api/projects/:projectId/upload-targets
iOS App -> PUT photo data to signed R2 URL
iOS App -> POST /api/projects/:projectId/uploads/complete
iOS App -> POST /api/projects/:projectId/photo-retouch-jobs
iOS App -> GET  /api/projects/:projectId/jobs/:jobId
```

## Local Mock Mode

Copy `.env.example` to `.env`, keep:

```env
R2_MOCK=true
RUNNINGHUB_MOCK=true
```

Then run:

```bash
npm install
npm run dev
```

Mock mode stores uploaded files under `data/mock-r2/` and marks AI jobs completed after a short delay.

## Production Mode

Set:

```env
R2_MOCK=false
RUNNINGHUB_MOCK=false
R2_KEY_PREFIX=native-app
R2_ACCOUNT_ID=...
R2_BUCKET=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
RUNNINGHUB_API_KEY=...
RUNNINGHUB_WORKFLOW_ID=...
```

Production RunningHub is wired through the environment-driven workflow mapping. Set the workflow id and input node mapping in `.env`; the iOS app should only call this backend.

## Reusing The Website Configuration

The existing website backend stores secrets with `METROVAN_...` names. This native app backend can read those same names, so you can copy the needed values into this backend's own `.env` without changing the website.

Do not put any of these values into Swift or the iOS app bundle.

Minimum production values:

```env
R2_MOCK=false
RUNNINGHUB_MOCK=false

METROVAN_OBJECT_STORAGE_ENDPOINT=...
METROVAN_OBJECT_STORAGE_BUCKET=...
METROVAN_OBJECT_STORAGE_ACCESS_KEY_ID=...
METROVAN_OBJECT_STORAGE_SECRET_ACCESS_KEY=...
METROVAN_OBJECT_STORAGE_REGION=auto

METROVAN_RUNNINGHUB_API_KEY=...
METROVAN_RUNNINGHUB_DEFAULT_WORKFLOW_ID=...
METROVAN_RUNNINGHUB_DEFAULT_INSTANCE_TYPE=plus
METROVAN_RUNNINGHUB_DEFAULT_INPUT_NODE_ID=...
METROVAN_RUNNINGHUB_DEFAULT_INPUT_FIELD=image
METROVAN_RUNNINGHUB_DEFAULT_INPUT_MODE=image
```

The production photo flow is:

```text
iOS app uploads originals to signed R2 PUT URLs
Backend downloads each original from R2
Backend uploads the image to RunningHub
Backend creates and polls the RunningHub task
Backend downloads the RunningHub output
Backend writes the result image back to R2
iOS app polls /api/projects/:projectId/jobs/:jobId
```
