# Color Hunt

A mobile browser game for kids: you're shown a random color, and you go hunt
for it in the real world using your phone's camera.

## How it works

- **Target color** — a random color is generated each round and shown as a swatch.
- **Live camera color** — the app continuously reads frames from the rear
  camera, downsamples them, and picks the *most common* color in view (via a
  coarse color histogram) rather than a plain average. This means a dominant
  object's color wins, while pointing the camera at a mix of things naturally
  blends into an in-between color.
- **Capture** — tap the shutter button to lock in the current camera color as
  an attempt. If it's close enough to the target (based on the chosen
  difficulty), the round is won.
- **Difficulty** — Easy / Medium / Hard controls how close (in RGB distance)
  an attempt must be to count as a match.
- **Scoring** — the number of taps ("attempts") needed to find each color is
  tracked per round, along with your best (fewest-attempts) round and total
  rounds won, persisted in `localStorage` across sessions.

## Running it

This is a static site (`index.html`, `style.css`, `app.js`) — no build step.

Camera access requires a **secure context**: `https://` or `localhost`.
Plain `http://` on a phone will *not* be allowed to use the camera.

Local testing options:

```bash
# Serve locally (camera works on localhost even without HTTPS)
npx serve .
# then open http://localhost:3000 on the same machine,
# or use a tool like ngrok/Cloudflare Tunnel to test on a phone over HTTPS.
```

For real phone testing, the simplest path is deploying to any static HTTPS
host (e.g. GitHub Pages, Netlify, Vercel) and opening the URL on the device.

## Browser support

Requires `navigator.mediaDevices.getUserMedia` (all modern mobile browsers:
Safari iOS 11+, Chrome/Firefox Android). The rear camera is requested via
`facingMode: 'environment'`.
