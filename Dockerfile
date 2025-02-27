FROM node:22-alpine AS base

WORKDIR /app
COPY . .
RUN npm install --force && npm run build
EXPOSE 3000

CMD ["node", "build/index.js"]
