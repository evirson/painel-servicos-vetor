# Build a partir da raiz do monorepo:  docker build -f apps/worker/Dockerfile .
FROM node:20-slim
WORKDIR /app

# openssl para o Prisma; iputils-ping para a sonda `ping`
RUN apt-get update && apt-get install -y openssl iputils-ping && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm install
RUN npx prisma generate --schema packages/db/prisma/schema.prisma

EXPOSE 4400

# Sincroniza o schema no banco e sobe a API + agendador.
CMD ["sh", "-c", "npx prisma db push --schema packages/db/prisma/schema.prisma --skip-generate && npm --workspace @vetor/worker run start"]
