FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY README.md ./
RUN mkdir -p /app/data
CMD ["node", "src/app.js"]
