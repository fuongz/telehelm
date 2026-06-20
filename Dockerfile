FROM node:22-alpine

WORKDIR /app

# Install production deps first for layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Run as the unprivileged built-in node user.
USER node

CMD ["node", "src/index.js"]
