SHELL := /bin/bash

CITADEL_HOME ?= $(HOME)/.citadel
DAEMON_PID := $(CITADEL_HOME)/daemon.pid
DAEMON_LOG := $(CITADEL_HOME)/daemon.log
DAEMON_PORT ?= 4010

.PHONY: help install dev dev-daemon dev-web build check typecheck lint test coverage e2e smoke performance clean deploy stop logs

help:
	@echo "Citadel v2 commands"
	@echo "  make install      Install pnpm dependencies"
	@echo "  make dev          Run daemon and web dev servers"
	@echo "  make deploy       Rebuild web + daemon, restart the local daemon serving the built web at :$(DAEMON_PORT)"
	@echo "  make stop         Stop the local daemon started by make deploy"
	@echo "  make logs         Tail the deployed daemon's log"
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

# Citadel is personal and single-environment: `make deploy` rebuilds the
# daemon and the cockpit, then restarts the local daemon. The daemon serves
# the built web statically from apps/web/dist, so http://localhost:$(DAEMON_PORT)
# becomes the cockpit. Logs and pid file live under $(CITADEL_HOME).
deploy:
	@mkdir -p $(CITADEL_HOME)
	@echo "→ Building cockpit (apps/web)…"
	@pnpm --filter @citadel/web build
	@echo "→ Building daemon (apps/daemon)…"
	@pnpm --filter @citadel/daemon build
	@$(MAKE) -s stop
	@echo "→ Starting daemon, logging to $(DAEMON_LOG)…"
	@nohup node apps/daemon/dist/index.js >>$(DAEMON_LOG) 2>&1 & echo $$! > $(DAEMON_PID)
	@sleep 0.8
	@if kill -0 $$(cat $(DAEMON_PID)) 2>/dev/null; then \
		echo "✓ Citadel deployed: http://localhost:$(DAEMON_PORT)  (pid $$(cat $(DAEMON_PID)))"; \
	else \
		echo "✗ Daemon failed to start. Last 30 lines of $(DAEMON_LOG):"; \
		tail -n 30 $(DAEMON_LOG); \
		exit 1; \
	fi

stop:
	@if [ -f $(DAEMON_PID) ] && kill -0 $$(cat $(DAEMON_PID)) 2>/dev/null; then \
		echo "→ Stopping daemon (pid $$(cat $(DAEMON_PID)))…"; \
		kill $$(cat $(DAEMON_PID)) 2>/dev/null || true; \
		sleep 0.4; \
		kill -9 $$(cat $(DAEMON_PID)) 2>/dev/null || true; \
		rm -f $(DAEMON_PID); \
	fi
	@# Catch any stragglers from earlier runs that predate the pid file.
	@pkill -f "apps/daemon/dist/index.js" 2>/dev/null || true

logs:
	@touch $(DAEMON_LOG)
	@tail -n 80 -f $(DAEMON_LOG)
