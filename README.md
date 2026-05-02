# R2 + RunningHub Backend

This is the minimal backend for the native iOS app photo retouch workflow.

The iPhone app should never store R2 credentials or a RunningHub API key. It only talks to this backend.

Current independent Render service:

```text
https://jin-native-ai-backend.onrender.com
```

Render production environment template:

```text
../RENDER_PRODUCTION_ENV.md
render.production.env.example
render.yaml
```

## Flow

```text
iOS App -> POST /api/projects/:projectId/upload-targets
iOS App -> PUT photo data to signed R2 URL
iOS App -> POST /api/projects/:projectId/uploads/complete
iOS App -> POST /api/projects/:projectId/photo-retouch-jobs
iOS App -> GET  /api/projects/:projectId/jobs/:jobId
```

## Account, Credits, and IAP Flow

The app now creates a per-install `appAccountToken` and sends it to this backend. Credits are tracked in the backend `data/db.json` ledger, so the app does not need to trust a purely local balance.

```text
iOS App -> POST /api/account/bootstrap
iOS App -> GET  /api/account/credits
iOS App -> POST /api/account/credits/spend
iOS App -> POST /api/account/credits/refund
iOS App -> POST /api/account/delete
iOS App -> StoreKit purchase with appAccountToken
iOS App -> POST /api/iap/transactions with signedTransactionInfo
Backend -> validates product + bundle id + transaction idempotency
Backend -> credits the account ledger
```

`/api/account/delete` deletes the automatically generated app account record, credit ledger, generated jobs, uploaded cloud objects, and uploaded assets associated with the app account token. It does not cancel Apple subscriptions; users must manage billing through Apple ID subscriptions.

Product credit mapping:

```text
com.jinrealestate.pro.monthly = 30 credits
com.jinrealestate.credits.20 = 20 credits
com.jinrealestate.credits.100 = 100 credits
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

For paid App Store release, also set:

```env
APPLE_BUNDLE_ID=com.jin.realestatemarketing
APPLE_IAP_VALIDATION_MODE=strict
DEFAULT_STARTING_CREDITS=0
PUBLIC_API_BASE_URL=https://jin-native-ai-backend.onrender.com
ADMIN_EMAILS=zhoujin0618@gmail.com
ADMIN_PIN=...
ADMIN_SESSION_SECRET=...
```

`APPLE_IAP_VALIDATION_MODE=decode` is only for local development and TestFlight wiring while you are setting up App Store Connect products. Production should use `strict`, and App Store Server Notifications should point to:

```text
POST /api/apple/notifications
```

Production RunningHub is wired through the environment-driven workflow mapping. Set the workflow id and input node mapping in `.env`; the iOS app should only call this backend.

Run the production readiness check before submitting a build:

```bash
npm run check:production
```

This check only reports missing or unsafe configuration. It does not print secret values.

After deployment, verify:

```text
GET /api/health
GET /api/readiness
```

`/api/readiness` returns a non-secret readiness report. All checks should be `true` before App Store review.

You can also verify the deployed backend from your local machine:

```bash
npm run verify:live
```

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
