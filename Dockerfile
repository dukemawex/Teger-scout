FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
# Non-secret model selection, set before `eve build` so the compiled agent
# metadata names the model that is actually called. Override at runtime.
ENV TEGER_MODEL_PROVIDER=auto \
    TEGER_OPENROUTER_MODEL_ID=poolside/laguna-s-2.1:free \
    TEGER_MODEL_FALLBACKS=poolside/laguna-xs-2.1:free,nvidia/nemotron-3-super-120b-a12b:free \
    CREATEOS_SANDBOX_BASE_URL=https://api-eu.sb.createos.sh \
    TEGER_SANDBOX_ROOTFS=desktop:1 \
    TEGER_SANDBOX_SHAPE=s-1vcpu-1gb
RUN npm run build:web && npx eve build
ENV PORT=8080 TEGER_DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "scripts/start.mjs"]
