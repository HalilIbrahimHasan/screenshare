# Screen Share App

Single-service screen sharing app for desktop hosts and mobile viewers. The server handles
Socket.IO signaling and serves the built React frontend, which makes it a good fit for a
single Render web service.

## Local development

```bash
npm install
npm run dev
```

- Frontend dev server: `http://localhost:5173`
- Signaling server: `http://localhost:3001`

## Production build

```bash
npm run build
npm run start -w server
```

The Node server serves the built frontend from `client/dist` and exposes a health endpoint
at `/health`.

## Deploy to Render

This repo includes `render.yaml`, so Render can create the service automatically.

### Recommended setup

1. Create a new **Web Service** in Render from this repository.
2. Let Render detect `render.yaml`, or use these values manually:
   - Build command: `npm install && npm run build`
   - Start command: `npm run start -w server`
   - Health check path: `/health`
   - Node version: `22.12.0`
3. Deploy.

### Notes

- Render provides the `PORT` environment variable automatically.
- WebSockets are supported on Render web services, which is required for Socket.IO signaling.
- The app stores session state in memory, so active sessions end when the service restarts.
