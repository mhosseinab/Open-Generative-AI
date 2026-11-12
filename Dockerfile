# syntax=docker/dockerfile:1
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Install dependencies
FROM base AS deps
COPY package*.json ./
COPY packages/Vibe-Workflow/packages/workflow-builder/package*.json ./packages/Vibe-Workflow/packages/workflow-builder/
COPY packages/Open-Poe-AI/packages/agents/package*.json ./packages/Open-Poe-AI/packages/agents/
COPY packages/Open-AI-Design-Agent/packages/design-agent/package*.json ./packages/Open-AI-Design-Agent/packages/design-agent/
COPY packages/studio/package*.json ./packages/studio/
RUN --mount=type=cache,target=/root/.npm npm ci

# Build sub-packages
FROM deps AS build
COPY . .
RUN npm run build:packages
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

# Assemble a runtime from the same pinned Node/musl build. Package managers,
# headers, compilers, and the build-stage filesystem do not enter the final image.
FROM scratch AS runtime-files
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=base /lib/ /lib/
COPY --from=base /usr/lib/ /usr/lib/
COPY --from=base /etc/ssl/ /etc/ssl/
COPY --from=base /etc/passwd /etc/group /etc/
COPY --from=base --chown=1000:1000 /tmp/ /tmp/
# The ARM64 source-built Node base omits the packaged license file.
COPY licenses/node-LICENSE /usr/local/LICENSE

FROM scratch AS runner
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
ENV PATH=/usr/local/bin
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/mhosseinab/Open-Generative-AI" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.title="GenerativeAIStudio" \
      org.opencontainers.image.licenses="MIT"
COPY --from=runtime-files / /
COPY --from=build --chown=1000:1000 /app/.next/standalone ./
COPY --from=build --chown=1000:1000 /app/.next/static ./.next/static
COPY --from=build --chown=1000:1000 /app/public ./public
COPY --from=build /app/LICENSE /app/LICENSE
COPY --from=build --chown=1000:1000 /app/scripts/archive-existing-media.cjs ./scripts/archive-existing-media.cjs
COPY --from=build --chown=1000:1000 /app/src/lib/videoStorage.cjs ./src/lib/videoStorage.cjs
USER 1000:1000

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/studio').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
