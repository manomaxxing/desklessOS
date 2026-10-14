#!/usr/bin/env bash
# DesklessOS on Google Cloud Run, in the EU. Safe to run again: it creates what's missing
# and deploys a new revision.
#
#   PROJECT=<gcp project> deploy/cloudrun.sh                 (REGION defaults to europe-west1)
#
# Before the first run: a Supabase project (EU) and deploy/env.production (from deploy/env.example).
# What it sets up (see docs/architecture.md, "Deployment"):
#   - a service account for the service, allowed to call Vertex AI (no key file anywhere)
#   - one Secret Manager secret holding deploy/env.production, mounted at /secrets/env
#   - the Cloud Run service: request-based billing (CPU only while a request is open),
#     0 to MAX_INSTANCES instances, 60-minute requests (a call is one WebSocket)
#   - a Cloud Scheduler job: POST /internal/tick every minute (background work, and it keeps
#     an instance warm and the database awake)
set -euo pipefail

PROJECT=${PROJECT:?set PROJECT to the Google Cloud project id}
REGION=${REGION:-europe-west1}
SERVICE=${SERVICE:-desklessos}
ENV_FILE=${ENV_FILE:-deploy/env.production}
MAX_INSTANCES=${MAX_INSTANCES:-3}
SA="$SERVICE-run@$PROJECT.iam.gserviceaccount.com"
SECRET="$SERVICE-env"
g() { gcloud --project "$PROJECT" --quiet "$@"; }

[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE: copy deploy/env.example and fill it in" >&2; exit 1; }
TICK_TOKEN=$(grep -E '^TICK_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$TICK_TOKEN" ] || { echo "$ENV_FILE: TICK_TOKEN is empty (openssl rand -hex 24)" >&2; exit 1; }
grep -qE '^DATABASE_URL=postgres' "$ENV_FILE" || { echo "$ENV_FILE: DATABASE_URL must be a postgres:// URL" >&2; exit 1; }

echo "→ APIs"
g services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com aiplatform.googleapis.com

echo "→ service account $SA"
g iam service-accounts describe "$SA" >/dev/null 2>&1 || g iam service-accounts create "$SERVICE-run" --display-name "DesklessOS (Cloud Run)"
g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role roles/aiplatform.user --condition None >/dev/null

echo "→ secret $SECRET (from $ENV_FILE)"
g secrets describe "$SECRET" >/dev/null 2>&1 || g secrets create "$SECRET" --replication-policy automatic
g secrets versions add "$SECRET" --data-file "$ENV_FILE" >/dev/null
g secrets add-iam-policy-binding "$SECRET" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
# Only the newest version is needed: older ones are disabled (6 active versions are free).
for v in $(g secrets versions list "$SECRET" --filter "state=ENABLED" --sort-by "~createTime" --format "value(name.basename())" | tail -n +2); do
  g secrets versions disable "$v" --secret "$SECRET" >/dev/null
done

URL="https://$SERVICE-$(g projects describe "$PROJECT" --format 'value(projectNumber)').$REGION.run.app"
echo "→ Cloud Run service $SERVICE ($URL)"
g run deploy "$SERVICE" --source . --region "$REGION" \
  --service-account "$SA" --allow-unauthenticated \
  --execution-environment gen2 --cpu 1 --memory 1Gi --cpu-throttling --cpu-boost \
  --concurrency 20 --min-instances 0 --max-instances "$MAX_INSTANCES" --timeout 3600 \
  --set-secrets "/secrets/env=$SECRET:latest" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT,PUBLIC_URL=$URL,BACKGROUND=http"

echo "→ Cloud Scheduler: $SERVICE-tick, every minute"
JOB=(--location "$REGION" --schedule "* * * * *" --uri "$URL/internal/tick" --http-method POST --attempt-deadline 120s --time-zone Etc/UTC)
if g scheduler jobs describe "$SERVICE-tick" --location "$REGION" >/dev/null 2>&1; then
  g scheduler jobs update http "$SERVICE-tick" "${JOB[@]}" --update-headers "X-Tick-Token=$TICK_TOKEN"
else
  g scheduler jobs create http "$SERVICE-tick" "${JOB[@]}" --headers "X-Tick-Token=$TICK_TOKEN"
fi

echo
echo "Deployed: $URL"
echo "  health:   curl $URL/api/health"
echo "  Twilio:   the number's voice webhook → $URL/twilio/voice (POST)"
echo "  Dial:     npm run dial -- activate wss://${URL#https://}/dial"
echo "  logs:     gcloud --project $PROJECT run services logs tail $SERVICE --region $REGION"
