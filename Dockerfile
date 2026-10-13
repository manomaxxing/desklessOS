FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY server.mjs ./
COPY src ./src
COPY web ./web
# read at startup: company and research config, languages, personas, templates
COPY config ./config
COPY locales ./locales
COPY personas ./personas
COPY templates ./templates
EXPOSE 8787
CMD ["node", "server.mjs"]
