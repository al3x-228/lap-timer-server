const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage
let laps = [];
let currentSession = {
  startTime: null,
  lapStartTime: null,
  bestLap: null,
  lapCount: 0,
  currentSpeed: 0,
  currentLat: 0,
  currentLon: 0,
  maxSpeedThisLap: 0,
  trackPoints: [], // live trace of current lap
  finishLine: null  // {lat, lon} set by user or preset
};

// Nurburgring Nordschleife tourist section start/finish
const TRACKS = {
  nurburgring: {
    name: "Nürburgring Nordschleife",
    lat: 50.3356,
    lon: 6.9475,
    minLapSeconds: 300 // 5 min minimum lap
  }
};

// Broadcast to all connected dashboard clients
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// Calculate distance between two GPS points in meters
function gpsDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── ESP32 sends GPS data here ──
app.post('/gps', (req, res) => {
  const { lat, lon, speed, satellites, hdop } = req.body;

  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

  const now = Date.now();

  // Update current position
  currentSession.currentLat = lat;
  currentSession.currentLon = lon;
  currentSession.currentSpeed = speed || 0;

  // Track session start
  if (!currentSession.startTime) {
    currentSession.startTime = now;
    currentSession.lapStartTime = now;
  }

  // Add point to current lap trace
  currentSession.trackPoints.push({ lat, lon, speed, time: now });

  // Update max speed this lap
  if (speed > currentSession.maxSpeedThisLap) {
    currentSession.maxSpeedThisLap = speed;
  }

  // Check finish line crossing
  if (currentSession.finishLine) {
    const dist = gpsDistance(lat, lon,
      currentSession.finishLine.lat,
      currentSession.finishLine.lon);

    const minLap = currentSession.finishLine.minLapSeconds || 60;
    const lapElapsed = (now - currentSession.lapStartTime) / 1000;

    if (dist < 20 && lapElapsed > minLap) {
      // LAP COMPLETE
      const lapTime = now - currentSession.lapStartTime;
      currentSession.lapCount++;

      const lap = {
        number: currentSession.lapCount,
        time: lapTime,
        timeFormatted: formatLapTime(lapTime),
        maxSpeed: Math.round(currentSession.maxSpeedThisLap),
        points: [...currentSession.trackPoints],
        timestamp: now
      };

      laps.push(lap);

      // Update best lap
      if (!currentSession.bestLap || lapTime < currentSession.bestLap.time) {
        currentSession.bestLap = lap;
      }

      // Reset for next lap
      currentSession.lapStartTime = now;
      currentSession.maxSpeedThisLap = 0;
      currentSession.trackPoints = [];

      // Broadcast lap complete
      broadcast({
        type: 'LAP_COMPLETE',
        lap,
        bestLap: currentSession.bestLap,
        totalLaps: currentSession.lapCount
      });
    }
  }

  // Broadcast live position
  broadcast({
    type: 'POSITION',
    lat,
    lon,
    speed: Math.round(speed || 0),
    satellites,
    hdop,
    lapTime: currentSession.lapStartTime
      ? formatLapTime(now - currentSession.lapStartTime)
      : '00:00.000',
    lapCount: currentSession.lapCount,
    bestLap: currentSession.bestLap
      ? currentSession.bestLap.timeFormatted
      : '--:--.---'
  });

  res.json({ ok: true });
});

// ── Set finish line ──
app.post('/setfinish', (req, res) => {
  const { lat, lon, track } = req.body;

  if (track && TRACKS[track]) {
    currentSession.finishLine = TRACKS[track];
    broadcast({ type: 'FINISH_SET', finishLine: TRACKS[track], trackName: TRACKS[track].name });
    return res.json({ ok: true, track: TRACKS[track].name });
  }

  if (lat && lon) {
    currentSession.finishLine = { lat, lon, minLapSeconds: 60 };
    broadcast({ type: 'FINISH_SET', finishLine: currentSession.finishLine, trackName: 'Custom' });
    return res.json({ ok: true, track: 'Custom' });
  }

  res.status(400).json({ error: 'Provide lat/lon or track name' });
});

// ── Get all laps ──
app.get('/laps', (req, res) => {
  res.json({ laps, bestLap: currentSession.bestLap, session: currentSession });
});

// ── Reset session ──
app.post('/reset', (req, res) => {
  laps = [];
  currentSession = {
    startTime: null,
    lapStartTime: null,
    bestLap: null,
    lapCount: 0,
    currentSpeed: 0,
    currentLat: 0,
    currentLon: 0,
    maxSpeedThisLap: 0,
    trackPoints: [],
    finishLine: currentSession.finishLine // keep finish line
  };
  broadcast({ type: 'RESET' });
  res.json({ ok: true });
});

// ── Get available tracks ──
app.get('/tracks', (req, res) => {
  res.json(TRACKS);
});

function formatLapTime(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}.${String(millis).padStart(3,'0')}`;
}

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Dashboard connected');
  // Send current state on connect
  ws.send(JSON.stringify({
    type: 'INIT',
    laps,
    bestLap: currentSession.bestLap,
    lapCount: currentSession.lapCount,
    finishLine: currentSession.finishLine,
    currentLat: currentSession.currentLat,
    currentLon: currentSession.currentLon
  }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Lap timer server running on port ${PORT}`);
});
