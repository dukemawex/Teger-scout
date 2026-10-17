FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build:web && npx eve build
ENV PORT=8080 TEGER_DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "scripts/start.mjs"]
