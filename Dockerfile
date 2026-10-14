FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# SMART_TURN=1 (--build-arg SMART_TURN=1): the turn detector's runtime (onnxruntime-node,
# ~250 MB) and model; then set TURN_DETECTOR=smart-turn. Without it the image stays small.
ARG SMART_TURN=0
COPY package.json package-lock.json ./
RUN if [ "$SMART_TURN" = "1" ]; then npm ci --omit=dev; else npm ci --omit=dev --omit=optional; fi
COPY server.mjs ./
COPY src ./src
COPY web ./web
# read at startup: the research framework, languages, personas, templates
COPY config ./config
COPY locales ./locales
COPY personas ./personas
COPY templates ./templates
COPY scripts/smart-turn-fetch.mjs ./scripts/smart-turn-fetch.mjs
RUN if [ "$SMART_TURN" = "1" ]; then node scripts/smart-turn-fetch.mjs; fi
# No state in the image or on its disk: everything lives in Postgres.
USER node
# Cloud Run sets PORT (8080). The secrets come as one file (Secret Manager, mounted at /secrets/env).
CMD ["node", "--env-file-if-exists=/secrets/env", "server.mjs"]
