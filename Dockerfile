FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 NOTES_DIR=/data/notes
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY server.mjs ./
COPY src ./src
COPY web ./web
EXPOSE 8787
CMD ["node", "server.mjs"]
