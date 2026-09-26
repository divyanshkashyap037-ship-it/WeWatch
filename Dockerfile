# ---- build React client ----
FROM node:20-slim AS build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- run server ----
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public/ ./public/
COPY --from=build /app/client/dist ./client/dist
RUN mkdir -p uploads
EXPOSE 3000
CMD ["node", "server.js"]
