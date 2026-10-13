FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
# SMART_TURN=1 (fly deploy --build-arg SMART_TURN=1): the turn detector's runtime (onnxruntime-node,
# ~250 MB) and model; then set TURN_DETECTOR=smart-turn. Without it the image stays small.
ARG SMART_TURN=0
COPY package.json package-lock.json* ./
RUN if [ "$SMART_TURN" = "1" ]; then npm ci --omit=dev; else npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional; fi
COPY server.mjs ./
COPY src ./src
COPY web ./web
# read at startup: company and research config, languages, personas, templates
COPY config ./config
COPY locales ./locales
COPY personas ./personas
COPY templates ./templates
COPY scripts/smart-turn-fetch.mjs ./scripts/smart-turn-fetch.mjs
RUN if [ "$SMART_TURN" = "1" ]; then node scripts/smart-turn-fetch.mjs; fi
EXPOSE 8787
CMD ["node", "server.mjs"]
