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

EFFECTIVE_PORT     := $(shell v=$$([ -r $(DEV_STATE) ] && command -v jq >/dev/null 2>&1 && jq -r '.port    // empty' $(DEV_STATE) 2>/dev/null); echo $${v:-$(WORKTREE_PORT)})
EFFECTIVE_WEB_PORT := $(shell v=$$([ -r $(DEV_STATE) ] && command -v jq >/dev/null 2>&1 && jq -r '.webPort // empty' $(DEV_STATE) 2>/dev/null); echo $${v:-$(WORKTREE_WEB_PORT)})

.PHONY: help setup deploy install tmux-service build check typecheck lint test coverage e2e smoke performance clean stop logs

help:
	@echo "Citadel — scoped to: $(CURDIR)"
	@echo ""
	@echo "Two commands you actually use:"
	@echo "  make install     For users: install/reinstall the long-term systemd service citadel.service"
	@echo "                   pointing at this checkout. Idempotent. Use this on your devbox once you"
	@echo "                   want Citadel running 24/7 in the background."
	@echo "  make deploy      For devs: start a worktree-isolated HMR dev stack (detached). Daemon +"
	@echo "                   vite, both watching for changes. Used by the cockpit's Redeploy chip."
	@echo "                     cockpit → http://localhost:$(EFFECTIVE_WEB_PORT) (vite, HMR)"
	@echo "                     daemon  → http://localhost:$(EFFECTIVE_PORT)"
	@echo ""
	@echo "Lifecycle:"
	@echo "  make setup        pnpm install"
	@echo "  make stop         Stop this worktree's deploy stack"
	@echo "  make logs         Tail the deploy stack's combined log (daemon + vite)"
	@echo "  make tmux-service Restart citadel-tmux.service (DESTRUCTIVE — kills live tmux sessions;"
	@echo "                    boot-restore resumes them via claude --resume). Use only to apply"
	@echo "                    tmux-unit changes or recover from an orphan tmux server."
	@echo ""
	@echo "Quality:"
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

# `make deploy` is the everyday dev command. Detached HMR stack: daemon
# (tsx watch, restarts on source change) + vite (HMR), running in one process
# group. Idempotent: the next invocation kills the previous pgid before
# starting fresh. The cockpit's Redeploy hook calls this same target, which is
# the whole point — clicking Redeploy gives you the same HMR-enabled stack
# you'd get from a terminal.
#
# Why detached: a button can't trigger a foreground long-running process. The
# user gets their terminal back; live output is one `make logs` away.
#
# Doesn't depend on `make install` — fully self-contained in $(CURDIR)/.citadel.
deploy:
	@if [ ! -d node_modules ]; then \
		echo "✗ node_modules missing — run 'make setup' first"; \
		exit 1; \
	fi
	@mkdir -p $(WORKTREE_LOGS_DIR) $(WORKTREE_DATA_DIR)
	@command -v setsid >/dev/null 2>&1 || { echo "setsid required — install util-linux"; exit 127; }
	@# Seed dev.json with the webPort so the deploy hook can advertise the vite
	# (HMR) URL — the daemon writes its own port on boot but doesn't know about
	# vite. The daemon merges this with its port on next boot.
	@if command -v jq >/dev/null 2>&1 && [ -r $(DEV_STATE) ]; then \
		tmp=$$(mktemp); \
		jq --arg p $(WORKTREE_WEB_PORT) '.webPort=($$p|tonumber)' $(DEV_STATE) > $$tmp && mv $$tmp $(DEV_STATE); \
	else \
		mkdir -p $(dir $(DEV_STATE)); \
		printf '{"port":%d,"webPort":%d,"host":"127.0.0.1","worktreePath":"%s","writtenAt":"%s"}\n' \
			$(WORKTREE_PORT) $(WORKTREE_WEB_PORT) "$(CURDIR)" "$$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
			> $(DEV_STATE); \
	fi
	@chmod 600 $(DEV_STATE) 2>/dev/null || true
	@if [ -f $(WORKTREE_PID) ]; then \
		pgid="$$(cat $(WORKTREE_PID) 2>/dev/null || true)"; \
		if [ -n "$$pgid" ] && kill -0 -- "-$$pgid" 2>/dev/null; then \
			echo "→ Stopping previous dev stack pgid=$$pgid"; \
			kill -TERM -- "-$$pgid" 2>/dev/null || true; \
			sleep 1; \
			kill -KILL -- "-$$pgid" 2>/dev/null || true; \
		fi; \
		rm -f $(WORKTREE_PID); \
	fi
	@if command -v fuser >/dev/null 2>&1; then \
		fuser -k -n tcp $(WORKTREE_PORT)     2>/dev/null || true; \
		fuser -k -n tcp $(WORKTREE_WEB_PORT) 2>/dev/null || true; \
	fi
	@echo "→ Starting worktree dev stack (HMR, detached)"
	@echo "   cockpit → http://localhost:$(WORKTREE_WEB_PORT)  (vite, HMR)"
	@echo "   daemon  → http://localhost:$(WORKTREE_PORT)  (tsx watch)"
	@echo "   data    → $(WORKTREE_DATA_DIR)"
	@echo "   log     → $(WORKTREE_LOG)"
	@# WORKTREE ISOLATION: scrub any CITADEL_* env vars inherited from the
	@# parent (systemd unit, shell rc, cockpit Redeploy chain). Without this,
	@# CITADEL_CONFIG and CITADEL_DATA_DIR from the prod systemd service leak
	@# into the worktree daemon and it ends up reading/writing the prod data
	@# dir. `env -u` removes the var from the child environment; we then set
	@# only the worktree-scoped values explicitly.
	@set -e; \
		: > $(WORKTREE_LOG); \
		setsid nohup env \
			-u CITADEL_CONFIG \
			-u CITADEL_DATA_DIR \
			-u CITADEL_DAEMON_URL \
			-u CITADEL_PORT \
			-u CITADEL_WEB_PORT \
			-u CITADEL_BIND_HOST \
			-u CITADEL_AUTOMATED_GH \
			CITADEL_WORKTREE=1 \
			CITADEL_AUTOMATED_GH=$${CITADEL_ENABLE_WORKTREE_GH_AUTOMATION:-0} \
			CITADEL_PORT=$(WORKTREE_PORT) \
			CITADEL_DATA_DIR=$(WORKTREE_DATA_DIR) \
			CITADEL_DAEMON_URL=http://127.0.0.1:$(WORKTREE_PORT) \
			CITADEL_WEB_PORT=$(WORKTREE_WEB_PORT) \
			pnpm dev >>$(WORKTREE_LOG) 2>&1 & \
		pgid=$$!; \
		echo "$$pgid" > $(WORKTREE_PID); \
		disown "$$pgid" 2>/dev/null || true
	@# Poll the daemon's /api/state until it answers or we time out. Vite
	# usually wakes faster but the daemon is the source of truth.
	@deadline=$$(( $$(date +%s) + 20 )); \
		while [ $$(date +%s) -lt $$deadline ]; do \
			if curl -fsS --max-time 1 http://127.0.0.1:$(WORKTREE_PORT)/api/state >/dev/null 2>&1; then \
				lan_host=$$(hostname -I 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($$i !~ /^127\./ && $$i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$$/) { print $$i; exit } }'); \
				lan_host=$${lan_host:-127.0.0.1}; \
				echo "✓ Dev stack ready"; \
				echo "  cockpit: http://$$lan_host:$(WORKTREE_WEB_PORT)"; \
				echo "  daemon:  http://$$lan_host:$(WORKTREE_PORT)"; \
				exit 0; \
			fi; \
			sleep 0.5; \
		done; \
		echo "✗ Dev stack didn't answer on :$(WORKTREE_PORT) within 20s. Last 40 lines of $(WORKTREE_LOG):"; \
		tail -n 40 $(WORKTREE_LOG); \
		exit 1

# `make install` is for users (or your devbox). Writes a user-systemd unit
# pointing at THIS checkout and brings it up. Idempotent: re-run after a
# `git pull` on the long-term checkout, or to swap the supervised daemon to a
# different checkout entirely. Does NOT touch any worktree-local `deploy` stack.
#
# Critically: `make install` never restarts citadel-tmux.service. tmux is the
# substrate every live agent session lives in; restarting it kills them all.
# Apply tmux-unit changes via `make tmux-service` instead.
install:
	@bash scripts/install-systemd.sh

# `make tmux-service` is the destructive sibling: (re)starts
# citadel-tmux.service, killing every live tmux session on the citadel
# socket. Used to apply tmux-unit changes or recover from an orphan-server
# condition. Boot-restore resumes recoverable agents via `claude --resume`.
tmux-service:
	@bash scripts/restart-tmux-service.sh

# `make stop` kills the detached `deploy` stack (daemon + vite, single pgid).
# Doesn't touch the systemd unit (use `systemctl --user stop citadel.service`).
stop:
	@if [ -f $(WORKTREE_PID) ]; then \
		pgid="$$(cat $(WORKTREE_PID) 2>/dev/null || true)"; \
		if [ -n "$$pgid" ] && kill -0 -- "-$$pgid" 2>/dev/null; then \
			echo "→ Stopping worktree dev stack pgid=$$pgid"; \
			kill -TERM -- "-$$pgid" 2>/dev/null || true; \
			sleep 1; \
			kill -KILL -- "-$$pgid" 2>/dev/null || true; \
		fi; \
		rm -f $(WORKTREE_PID); \
	else \
		echo "→ No dev stack recorded for $(CURDIR)"; \
	fi

logs:
	@touch $(WORKTREE_LOG)
	@tail -n 80 -f $(WORKTREE_LOG)
