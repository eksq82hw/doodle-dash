# Doodle Dash

A real-time multiplayer drawing and guessing party game. One player draws a secret word, everyone else races to guess it in chat. Faster guesses score more, and the drawer earns points when people guess right.

## Run it locally

    npm install
    npm start

Open http://localhost:3000, create a room, and share the code or invite link. Open a second browser tab to test with yourself.

## How a game works

1. The host creates a room and friends join with the 4 letter code (2 to 10 players)
2. Each round every player draws once, choosing from 3 random words
3. Letters are revealed as hints while the timer runs down
4. Guessers score up to 450 points depending on speed, and the drawer earns a share of each correct guess
5. The highest score after the final round wins

## Deploy

The server is a single Node process with no database. It needs WebSocket support and the PORT environment variable, which most hosts set for you.

- Render, Railway, or Fly.io: connect the repo, build command npm install, start command npm start
- Docker: docker build -t doodle-dash . then docker run -p 3000:3000 doodle-dash
- Health check path: /healthz

Rooms live in memory, so run a single instance. Restarting the server ends active games.

## Project layout

- server.js holds the static file server, rooms, game flow, scoring, and WebSocket handling
- words.js is the word list, edit it to add your own words or themes
- public/index.html is the whole client, with UI, canvas drawing, and networking

## Ideas for next steps

- Reconnect support so a dropped phone can rejoin its seat
- Paint bucket tool, since drawing is synced as replayable operations
- Custom word lists per room and a language option
- Redis based rooms if you need to scale past one instance
