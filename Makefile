SHELL := /bin/bash

CITADEL_HOME ?= $(HOME)/.citadel
DAEMON_PID := $(CITADEL_HOME)/daemon.pid
DAEMON_LOG := $(CITADEL_HOME)/daemon.log
DAEMON_PORT ?= 4010

# Worktree-local deploy state. When `make deploy` runs inside a git worktree
# (i.e. .git is a file pointing at the main repo's gitdir, not a directory),
# we run an isolated daemon for that worktree instead of touching the shared
# systemd unit. Each worktree gets a stable derived port (4110-4209), its own
# config + SQLite under .citadel/data/, and a PID file under .citadel/logs/.
WORKTREE_PORT := $(shell printf '%s' "$(CURDIR)" | cksum 2>/dev/null | awk '{print 4110 + ($$1 % 100)}')
WORKTREE_DATA_DIR := $(CURDIR)/.citadel/data
WORKTREE_LOGS_DIR := $(CURDIR)/.citadel/logs
WORKTREE_PID := $(WORKTREE_LOGS_DIR)/daemon.pid
WORKTREE_LOG := $(WORKTREE_LOGS_DIR)/daemon.log

.PHONY: help install dev dev-daemon dev-web build check typecheck lint test coverage e2e smoke performance clean deploy deploy-main deploy-worktree stop stop-worktree logs _stop_nohup

help:
	@echo "Citadel v2 commands"
	@echo "  make install         Install pnpm dependencies"
	@echo "  make dev             Run daemon and web dev servers"
	@echo "  make deploy          Worktree-aware: from a worktree → isolated daemon on a derived port; from main checkout → restart citadel.service / nohup daemon at :$(DAEMON_PORT)"
	@echo "  make deploy-main     Force the main-checkout deploy path (systemd or nohup at :$(DAEMON_PORT))"
	@echo "  make deploy-worktree Force the worktree-local deploy path (isolated daemon at :$(WORKTREE_PORT))"
	@echo "  make stop            Stop whichever daemon was started here (worktree-aware)"
	@echo "  make logs            Tail the deployed daemon's log"
	@echo "  make check        Run architecture, size, type, lint, test, coverage, security, build"
	@echo "  make smoke        Run local API smoke against a running daemon"
	@echo "  make e2e          Run Playwright happy-path tests"
	@echo "  make performance  Run local performance smoke against running app"

install:
	pnpm install

dev:
	pnpm dev

dev-daemon:
	pnpm dev:daemon

dev-web:
	pnpm dev:web

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

# `make deploy` is worktree-aware. The point: an agent working in a worktree
# can rebuild and run *its* cockpit without restarting the main daemon (which
# is the one the user actually uses). Detection: if .git is a file (gitlink),
# we're in a worktree; if it's a directory we're in the main checkout.
deploy:
	@if [ -f .git ]; then \
		echo "→ Worktree deploy ($(CURDIR))"; \
		$(MAKE) -s deploy-worktree; \
	else \
		$(MAKE) -s deploy-main; \
	fi

# Main-checkout deploy: rebuild everything, then restart the systemd user
# service `citadel.service` if it exists (preferred — it carries TTYD_BIN,
# CITADEL_SHELL_BIN, etc. in the unit's Environment=), or fall back to a
# nohup-managed process tracked by $(DAEMON_PID) and $(DAEMON_LOG). The
# daemon serves the built web statically from apps/web/dist, so
# http://localhost:$(DAEMON_PORT) becomes the cockpit.
deploy-main:
	@# Recursive build keeps workspace package dists fresh; filtered builds
	# skip them and the daemon's tsc then reads stale .d.ts files.
	@echo "→ Building cockpit + daemon + workspace packages…"
	@pnpm build
	@if systemctl --user is-active --quiet citadel.service 2>/dev/null || systemctl --user is-enabled --quiet citadel.service 2>/dev/null; then \
		echo "→ Restarting systemd user service citadel.service…"; \
		systemctl --user restart citadel.service; \
		sleep 0.6; \
		if systemctl --user is-active --quiet citadel.service; then \
			echo "✓ Citadel deployed via systemd — http://localhost:$(DAEMON_PORT)"; \
		else \
			echo "✗ systemd unit failed to come up:"; \
			systemctl --user status citadel.service --no-pager | head -20; \
			exit 1; \
		fi; \
	else \
		mkdir -p $(CITADEL_HOME); \
		$(MAKE) -s _stop_nohup; \
		echo "→ Starting daemon (nohup), logging to $(DAEMON_LOG)…"; \
		nohup node apps/daemon/dist/index.js >>$(DAEMON_LOG) 2>&1 & echo $$! > $(DAEMON_PID); \
		sleep 0.8; \
		if kill -0 $$(cat $(DAEMON_PID)) 2>/dev/null; then \
			echo "✓ Citadel deployed — http://localhost:$(DAEMON_PORT)  (pid $$(cat $(DAEMON_PID)))"; \
		else \
			echo "✗ Daemon failed to start. Last 30 lines of $(DAEMON_LOG):"; \
			tail -n 30 $(DAEMON_LOG); \
			exit 1; \
		fi; \
	fi

# Worktree-local deploy: rebuild + run an isolated daemon for THIS worktree
# only. It binds a derived port (so it cannot collide with the main daemon or
# with sibling worktrees) and uses a CITADEL_DATA_DIR inside the worktree, so
# its SQLite, config, and ttyd state are fully isolated.
#
# We launch under setsid so the daemon (and any tmux/ttyd children it spawns)
# share one process group; recording that PGID in $(WORKTREE_PID) lets the
# next deploy take it down cleanly with `kill -- -PGID`.
deploy-worktree:
	@echo "→ Building cockpit + daemon + workspace packages for this worktree…"
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
	@echo "→ Starting worktree daemon on :$(WORKTREE_PORT)"
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
			echo "✓ Worktree Citadel deployed — http://$$lan_host:$(WORKTREE_PORT)  (pgid $$pid)"; \
		else \
			echo "✗ Worktree daemon failed to start. Last 30 lines of $(WORKTREE_LOG):"; \
			tail -n 30 $(WORKTREE_LOG); \
			exit 1; \
		fi

stop:
	@if [ -f .git ]; then \
		$(MAKE) -s stop-worktree; \
	elif systemctl --user is-active --quiet citadel.service 2>/dev/null; then \
		systemctl --user stop citadel.service && echo "→ Stopped systemd user service citadel.service"; \
	else \
		$(MAKE) -s _stop_nohup; \
	fi

stop-worktree:
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
		echo "→ No worktree daemon recorded for $(CURDIR)"; \
	fi

# Stop a nohup-started daemon. Carefully avoids the `pkill -f` self-match
# trap: the shell running pkill has the pattern in its own argv, so a naïve
# `pkill -f "apps/daemon/dist/index.js"` would SIGTERM its own parent.
_stop_nohup:
	@if [ -f $(DAEMON_PID) ] && kill -0 $$(cat $(DAEMON_PID)) 2>/dev/null; then \
		echo "→ Stopping daemon (pid $$(cat $(DAEMON_PID)))…"; \
		kill $$(cat $(DAEMON_PID)) 2>/dev/null || true; \
		sleep 0.4; \
		kill -9 $$(cat $(DAEMON_PID)) 2>/dev/null || true; \
		rm -f $(DAEMON_PID); \
	fi
	@pgrep -f "node .*apps/daemon/dist/index\.js" 2>/dev/null | while read pid; do \
		if [ "$$pid" != "$$$$" ] && [ "$$pid" != "$$PPID" ]; then \
			kill "$$pid" 2>/dev/null || true; \
		fi; \
	done

logs:
	@if [ -f .git ]; then \
		touch $(WORKTREE_LOG); \
		tail -n 80 -f $(WORKTREE_LOG); \
	elif systemctl --user is-active --quiet citadel.service 2>/dev/null; then \
		journalctl --user -u citadel.service -f -n 80; \
	else \
		touch $(DAEMON_LOG); \
		tail -n 80 -f $(DAEMON_LOG); \
	fi
