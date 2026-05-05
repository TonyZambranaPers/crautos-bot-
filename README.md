# CRautos Car Bot

A local Node.js bot that scrapes crautos.com for used car listings with filtering and price drop alerts.

## Requirements
- Node.js 18+ (no npm packages needed — uses built-in modules only)

## Setup

1. Unzip / place this folder anywhere on your computer.

2. Open a terminal in this folder and run:
   ```
   node server.js
   ```

3. Open your browser to:
   ```
   http://localhost:3333
   ```

That's it. No npm install needed.

## How it works

- **server.js** runs a local HTTP server on port 3333.
  - It fetches crautos.com directly from Node (no CORS issues).
  - Parses and filters listings server-side.
  - Keeps a `price_history.json` file so price drops survive restarts.
  - Exposes `/scan`, `/health`, and `/history` API endpoints.

- **public/index.html** is the dashboard UI served by the same server.

## Features

### Filters tab
- Filter by make, model, year range, price range, transmission.
- Choose how many pages to scan (3 = ~75 listings, 10 = ~250).
- Start/stop a scheduler that re-runs automatically (default: every 2 hours).

### Price tracker tab
- 6 hot models pre-loaded: Toyota Corolla, Fortuner, Prado, Tercel + Mitsubishi Montero & Montero Sport.
- Click any card to toggle it on/off.
- Set drop thresholds: minimum ¢ drop and/or % drop.
- Browser notifications when a drop is detected.
- Price history saved to `price_history.json` — survives server restarts.

### Results tab
- All matching listings with sort options.
- Price drops highlighted with the before/after price.

### Log tab
- Full activity log with timestamps.
- Stats: total results, drops found, scans run.

## Keeping it running

To keep the bot running in the background on Windows:
```
start /B node server.js
```

On Mac/Linux:
```
nohup node server.js &
```

Or use a process manager like PM2:
```
npm install -g pm2
pm2 start server.js --name crautos-bot
pm2 save
pm2 startup
```
