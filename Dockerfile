FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY . .

ENV HOST=0.0.0.0 PORT=8791
EXPOSE 8791
USER node
CMD ["node", "--import", "tsx", "dev.ts"]
