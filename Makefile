SHELL := /bin/bash

# Everything in this Makefile is scoped to the *current checkout* (worktree or
# main). Two flows live here:
#   1. Local iteration: `make deploy` (HMR foreground) or `make serve` (built,
#      detached). Both bind to a derived port, write to a worktree-local data
#      dir, and never touch the systemd-supervised long-term service.
#   2. Long-term devbox install: `make install` (re)writes the user-systemd
#      unit `citadel.service` to point at $(CURDIR) and brings it up. This is
#      what you run once per machine — and again whenever you want to swap the
#      long-running daemon to a different checkout.

# Worktree-derived ports. cksum-mod-100 is deterministic per absolute path, so
# `make deploy` from the same worktree always lands on the same ports. The
# daemon may shift to the next free port on EADDRINUSE and persist that to
# .citadel/dev.json; the deploy hook and EFFECTIVE_PORT below pick that up so
# the URLs printed here match where the daemon actually listens.
WORKTREE_PORT     := $(shell printf '%s' "$(CURDIR)"      | cksum 2>/dev/null | awk '{print 4110 + ($$1 % 100)}')
WORKTREE_WEB_PORT := $(shell printf '%s' "$(CURDIR)/web"  | cksum 2>/dev/null | awk '{print 5210 + ($$1 % 100)}')
WORKTREE_DATA_DIR := $(CURDIR)/.citadel/data
WORKTREE_LOGS_DIR := $(CURDIR)/.citadel/logs
WORKTREE_PID      := $(WORKTREE_LOGS_DIR)/daemon.pid
WORKTREE_LOG      := $(WORKTREE_LOGS_DIR)/daemon.log
DEV_STATE         := $(CURDIR)/.citadel/dev.json

EFFECTIVE_PORT     := $(shell [ -r $(DEV_STATE) ] && command -v jq >/dev/null 2>&1 && jq -r '.port // empty'    $(DEV_STATE) 2>/dev/null || echo $(WORKTREE_PORT))
EFFECTIVE_WEB_PORT := $(shell [ -r $(DEV_STATE) ] && command -v jq >/dev/null 2>&1 && jq -r '.webPort // empty' $(DEV_STATE) 2>/dev/null || echo $(WORKTREE_WEB_PORT))

.PHONY: help setup deploy serve install build check typecheck lint test coverage e2e smoke performance clean stop logs

help:
	@echo "Citadel — scoped to: $(CURDIR)"
	@echo ""
	@echo "  make setup       Install pnpm dependencies"
	@echo "  make deploy      Run worktree-local dev stack with HMR (foreground)"
	@echo "                     daemon  → http://localhost:$(EFFECTIVE_PORT)"
	@echo "                     cockpit → http://localhost:$(EFFECTIVE_WEB_PORT) (vite, hot-reload)"
	@echo "  make serve       Build + run worktree-local daemon detached (used by Redeploy hook)"
	@echo "                     served at http://localhost:$(EFFECTIVE_PORT)"
	@echo "  make install     Install/reinstall systemd user service citadel.service pointing here"
	@echo "  make stop        Stop the worktree's detached daemon (no-op for HMR foreground)"
	@echo "  make logs        Tail the detached daemon's log"
	@echo ""
	@echo "  make check       typecheck + lint + test + build"
	@echo "  make smoke       Local API smoke against a running daemon"
	@echo "  make e2e         Playwright happy-path"
	@echo "  make performance Local performance smoke"

setup:
	pnpm install

build:
	pnpm build

check:
	pnpm check

typecheck:
	pnpm typecheck

lint:
	pnpm lint

test:
	pnpm test

coverage:
	pnpm coverage

e2e:
	pnpm e2e

smoke:
	pnpm smoke

performance:
	pnpm performance

clean:
	rm -rf apps/*/dist packages/*/dist coverage test-results playwright-report

# `make deploy` is the everyday command. Runs the daemon (tsx watch) and the
# cockpit (vite) in parallel, scoped to this checkout. Vite proxies /api,
# /events, /terminals → the worktree daemon, so the cockpit hits the same
# branch's backend. Foreground process — Ctrl-C stops everything.
deploy:
	@mkdir -p $(WORKTREE_LOGS_DIR) $(WORKTREE_DATA_DIR)
	@echo "→ Worktree dev stack (HMR)"
	@echo "   daemon  → http://localhost:$(WORKTREE_PORT)"
	@echo "   cockpit → http://localhost:$(WORKTREE_WEB_PORT)"
	@echo "   data    → $(WORKTREE_DATA_DIR)"
	@CITADEL_PORT=$(WORKTREE_PORT) \
	 CITADEL_DATA_DIR=$(WORKTREE_DATA_DIR) \
	 CITADEL_DAEMON_URL=http://127.0.0.1:$(WORKTREE_PORT) \
	 CITADEL_WEB_PORT=$(WORKTREE_WEB_PORT) \
	 pnpm dev

# `make serve` is the non-interactive build-then-detach path, used by the
# cockpit's Redeploy hook (.citadel/hooks/deploy). The daemon serves the built
# cockpit from apps/web/dist at its own origin — no proxy, same origin for /api
# and the bundle, so the UI a teammate visits always matches the daemon's
# branch. setsid keeps tmux/ttyd children in one process group so `make stop`
# can take everything down with `kill -- -PGID`.
serve:
	@echo "→ Building cockpit + daemon + workspace packages…"
	@pnpm build
	@mkdir -p $(WORKTREE_LOGS_DIR) $(WORKTREE_DATA_DIR)
	@if [ -f $(WORKTREE_PID) ]; then \
		pgid="$$(cat $(WORKTREE_PID) 2>/dev/null || true)"; \
		if [ -n "$$pgid" ] && kill -0 -- "-$$pgid" 2>/dev/null; then \
			echo "→ Stopping previous worktree daemon pgid=$$pgid"; \
			kill -TERM -- "-$$pgid" 2>/dev/null || true; \
			sleep 1; \
			kill -KILL -- "-$$pgid" 2>/dev/null || true; \
		fi; \
		rm -f $(WORKTREE_PID); \
	fi
	@if command -v fuser >/dev/null 2>&1; then fuser -k -n tcp $(WORKTREE_PORT) 2>/dev/null || true; fi
	@command -v setsid >/dev/null 2>&1 || { echo "setsid required — install util-linux"; exit 127; }
	@echo "→ Starting detached daemon on :$(WORKTREE_PORT)"
	@echo "   data dir: $(WORKTREE_DATA_DIR)"
	@echo "   log:      $(WORKTREE_LOG)"
	@set -e; \
		: > $(WORKTREE_LOG); \
		setsid nohup env \
			CITADEL_DATA_DIR=$(WORKTREE_DATA_DIR) \
			CITADEL_PORT=$(WORKTREE_PORT) \
			node apps/daemon/dist/index.js >>$(WORKTREE_LOG) 2>&1 & \
		pid=$$!; \
		echo "$$pid" > $(WORKTREE_PID); \
		disown "$$pid" 2>/dev/null || true; \
		sleep 0.8; \
		if kill -0 "$$pid" 2>/dev/null; then \
			lan_host=$$(hostname -I 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($$i !~ /^127\./ && $$i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$$/) { print $$i; exit } }'); \
			lan_host=$${lan_host:-127.0.0.1}; \
			echo "✓ Worktree daemon serving — http://$$lan_host:$(WORKTREE_PORT)  (pgid $$pid)"; \
		else \
			echo "✗ Worktree daemon failed to start. Last 30 lines of $(WORKTREE_LOG):"; \
			tail -n 30 $(WORKTREE_LOG); \
			exit 1; \
		fi

# `make install` is for the long-term devbox service. Writes a user-systemd
# unit pointing at THIS checkout and brings it up. Idempotent: re-run after a
# `git pull` on the long-term checkout, or to swap the supervised daemon to a
# different checkout entirely. Does NOT touch any worktree-local `serve` state.
install:
	@bash scripts/install-systemd.sh

# `make stop` only kills the detached `serve` daemon — `deploy` is foreground
# so Ctrl-C is enough. Doesn't touch the systemd unit (use `systemctl --user
# stop citadel.service` for that).
stop:
	@if [ -f $(WORKTREE_PID) ]; then \
		pgid="$$(cat $(WORKTREE_PID) 2>/dev/null || true)"; \
		if [ -n "$$pgid" ] && kill -0 -- "-$$pgid" 2>/dev/null; then \
			echo "→ Stopping worktree daemon pgid=$$pgid"; \
			kill -TERM -- "-$$pgid" 2>/dev/null || true; \
			sleep 1; \
			kill -KILL -- "-$$pgid" 2>/dev/null || true; \
		fi; \
		rm -f $(WORKTREE_PID); \
	else \
		echo "→ No detached daemon recorded for $(CURDIR) (HMR foreground? Ctrl-C the `make deploy` process)"; \
	fi

logs:
	@touch $(WORKTREE_LOG)
	@tail -n 80 -f $(WORKTREE_LOG)
