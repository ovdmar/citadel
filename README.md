# Citadel

Local operator cockpit for OpenClaw agent workflows.

## Why host-native

Citadel needs direct access to host tmux sessions and local workflow state. On macOS, Docker Desktop is the wrong fit for that because host tmux sockets and host process control are not cleanly container-accessible. So v1 runs natively on the Mac, by design.

## Scripts

- `npm install`
- `npm run dev`
- `npm run build`
- `npm start`

Default ports:
- API: `4010`
- Web dev: `5173`
- Terminal bridge: dynamic `7681+`
