# syntax=docker/dockerfile:1

# Use the smallest official Node image (Alpine-based)
FROM node:22-alpine

WORKDIR /app

# Copy each app and install production deps
COPY scrumboard/package.json scrumboard/
RUN cd scrumboard && npm install --omit=dev

COPY outlook/package.json outlook/
RUN cd outlook && npm install --omit=dev

COPY teams/package.json teams/
RUN cd teams && npm install --omit=dev

# Copy app source after deps (better layer caching)
COPY scrumboard/ scrumboard/
COPY outlook/  outlook/
COPY teams/    teams/
COPY cross_site/ cross_site/

# Copy evaluator and query indexes
COPY evaluator.cjs .
COPY *.jsonl ./

# Copy startup script
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

EXPOSE 3100 3101 3102

ENTRYPOINT ["sh", "entrypoint.sh"]
