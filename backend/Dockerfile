# ---------- build stage ----------
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---------- runtime stage ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# если у тебя есть какие-то статические файлы/шаблоны - добавишь сюда
# COPY --from=builder /app/some_folder ./some_folder

EXPOSE 3000
CMD ["node", "dist/main.js"]
