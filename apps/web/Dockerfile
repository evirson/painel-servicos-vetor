# Build a partir da raiz do monorepo:  docker build -f apps/web/Dockerfile .
FROM node:20-slim
WORKDIR /app

COPY . .
RUN npm install

EXPOSE 3300

# Modo dev: NEXT_PUBLIC_API_URL é lido em runtime (facilita ajustar o endereço da API).
# Para produção, faça `next build` passando NEXT_PUBLIC_API_URL como build arg.
CMD ["npm", "--workspace", "@vetor/web", "run", "dev"]
