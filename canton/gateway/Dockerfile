# The node's gateway: Node, with the admin API's .proto files taken from the same Canton release.
FROM digitalasset/daml-sdk:3.4.0-rc2 AS sdk

FROM node:22-slim AS protos
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
COPY --from=sdk /home/daml/.daml/sdk/3.4.0-rc2/canton/canton.jar /canton.jar
RUN unzip -q /canton.jar '*.proto' -d /protos

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY gateway.js ./
COPY --from=protos /protos /protos
ENV PROTOS=/protos
CMD ["node", "gateway.js"]
