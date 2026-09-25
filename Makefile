SHELL := /bin/bash

# Everything in this Makefile is scoped to the *current checkout* (worktree or
# main). Two flows live here:
#   1. Local iteration: `make deploy` (HMR foreground) or `make serve` (built,
#      detached). Both bind to a derived port, write to a worktree-local data
#      dir, and never touch the systemd-supervised long-term service.
#   2. Long-term devbox install: `make install` resolves the requested install
#      ref (latest release by default), (re)writes the user-systemd unit
#      `citadel.service` to point at $(CURDIR), brings it up, and runs doctor.
#      `make upgrade` is the same path under an operator-friendly verb.

# Worktree-derived ports. cksum-mod-100 is deterministic per absolute path, so
# `make deploy` from the same worktree always lands on the same ports. The
# daemon may shift to the next free port on EADDRINUSE and persist that to
# .citadel/dev.json; the deploy hook and EFFECTIVE_PORT below pick that up so
# the URLs printed here match where the daemon actually listens.
WORKTREE_PORT        := $(shell printf '%s' "$(CURDIR)"      | cksum 2>/dev/null | awk '{print 4110 + ($$1 % 100)}')
WORKTREE_WEB_PORT    := $(shell printf '%s' "$(CURDIR)/web"  | cksum 2>/dev/null | awk '{print 5210 + ($$1 % 100)}')
# tmux socket name. Per-checkout cksum (not port) so the socket stays stable
# even if the daemon walks ports on EADDRINUSE — agents keep the same tmux
# home across restarts. Disjoint from the systemd-managed `citadel` socket so
# the worktree daemon's orphan-reaper can never see prod sessions.
WORKTREE_TMUX_SOCKET := citadel-w-$(shell printf '%s' "$(CURDIR)" | cksum 2>/dev/null | awk '{print $$1}')
WORKTREE_DATA_DIR    := $(CURDIR)/.citadel/data
WORKTREE_LOGS_DIR    := $(CURDIR)/.citadel/logs
WORKTREE_PID         := $(WORKTREE_LOGS_DIR)/daemon.pid
WORKTREE_LOG         := $(WORKTREE_LOGS_DIR)/daemon.log
DEV_STATE            := $(CURDIR)/.citadel/dev.json

EFFECTIVE_PORT     := $(shell v=$$([ -r $(DEV_STATE) ] && command -v jq >/dev/null 2>&1 && jq -r '.port    // empty' $(DEV_STATE) 2>/dev/null); echo $${v:-$(WORKTREE_PORT)})
EFFECTIVE_WEB_PORT := $(shell v=$$([ -r $(DEV_STATE) ] && command -v jq >/dev/null 2>&1 && jq -r '.webPort // empty' $(DEV_STATE) 2>/dev/null); echo $${v:-$(WORKTREE_WEB_PORT)})

# Seeding worktree data dirs. The seed is checked-in fixture data — a tiny
# mock git repo materialized under $(WORKTREE_MOCK_REPO) plus synthetic rows
# inserted into the worktree SQLite. It is intentionally isolated from the
# systemd long-term daemon's prod data: seeding from prod would copy live
# workspace_sessions and the worktree daemon would race the live daemon for the
# same tmux sessions.
WORKTREE_MOCK_REPO       := $(CURDIR)/.citadel/mock-repo
WORKTREE_MOCK_WORKTREES  := $(CURDIR)/.citadel/mock-worktrees

CI_PORT                     ?= 4337
CI_WEB_PORT                 ?= 5173
CI_BASE_URL                 ?= http://127.0.0.1:$(CI_PORT)
CI_DAEMON_URL               ?= http://127.0.0.1:$(CI_PORT)
CI_WEB_URL                  ?= http://127.0.0.1:$(CI_WEB_PORT)
CI_E2E_PROJECTS             ?= desktop tablet mobile
CI_PLAYWRIGHT_INSTALL_ARGS  ?= --with-deps chromium
CI_DEV_LOG                  ?= /tmp/citadel-dev.log
CI_PLAYWRIGHT_DAEMON_LOG    ?= /tmp/citadel-playwright-daemon.log
CI_CLEAN_ALL_TMUX           ?= 0

.NOTPARALLEL: ci

.PHONY: help setup ci remote-checks ci-host-tools ci-setup ci-static ci-unit ci-build ci-install-playwright ci-e2e ci-smoke ci-clean-tmux ci-dump-playwright-log ci-dump-dev-log deploy install upgrade doctor tmux-service build check typecheck lint test coverage e2e smoke performance clean stop logs seed seed-reset

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
	@echo "Distribution:"
	@echo "  make install           Install/reinstall the latest released version."
	@echo "  make upgrade           Upgrade/reinstall to the latest released version."
	@echo "  make install REF=main  Install from latest origin/main instead of a release."
	@echo "  make upgrade REF=v0.3.0  Pin the install to an exact annotated release tag."
	@echo "  make doctor            Verify that everything is configured (binaries, daemon, config, hooks)."
	@echo ""
	@echo "Lifecycle:"
	@echo "  make setup        pnpm install"
	@echo "  make stop         Stop this worktree's deploy stack"
	@echo "  make logs         Tail the deploy stack's combined log (daemon + vite)"
	@echo ""
	@echo "Seeding (so a fresh worktree cockpit isn't empty):"
	@echo "  make seed         Materialize the checked-in mock repo + insert fixture rows into"
	@echo "                    this worktree's SQLite. Idempotent. 'make deploy' auto-runs this"
	@echo "                    on first launch of a fresh worktree."
	@echo "  make seed-reset   Stop this worktree's stack, wipe data + mock-repo + mock-worktrees,"
	@echo "                    re-seed from scratch. Use for a clean QA baseline."
	@echo ""
	@echo "Quality:"
	@echo "  make ci          Run every GitHub CI check locally (frozen install, static,"
	@echo "                   coverage, build, e2e desktop/tablet/mobile, smoke, performance)"
	@echo "  make check       typecheck + lint + coverage + build"
	@echo "  make smoke       Local API smoke against a running daemon"
	@echo "  make e2e         Playwright happy-path"
	@echo "  make performance Local performance smoke"

setup:
	pnpm install

remote-checks: ci

ci: ci-host-tools ci-setup ci-static ci-unit ci-build ci-install-playwright ci-e2e ci-smoke

ci-host-tools:
	@missing=""; \
	for bin in curl fuser git node pnpm setsid sqlite3 tmux; do \
		if ! command -v "$$bin" >/dev/null 2>&1; then \
			missing="$$missing $$bin"; \
		fi; \
	done; \
	if [ -n "$$missing" ]; then \
		echo "Missing tools required by GitHub CI:$$missing"; \
		exit 127; \
	fi; \
	node_major="$$(FORCE_COLOR=0 node -p 'Number(process.versions.node.split(".")[0])')"; \
	if [ "$$node_major" -lt 24 ]; then \
		echo "GitHub CI uses Node 24; found $$(node --version)"; \
		exit 1; \
	fi

ci-setup: ci-host-tools
	pnpm install --frozen-lockfile

ci-static:
	pnpm run check:arch
	pnpm run check:size
	pnpm run typecheck
	pnpm run lint
	pnpm run check:deps

ci-unit: ci-host-tools
	@set -e; \
	cleanup() { status=$$?; trap - EXIT INT TERM; bash scripts/dev/ci-clean-tmux.sh; exit $$status; }; \
	trap cleanup EXIT INT TERM; \
	pnpm run coverage

ci-build:
	pnpm run build

ci-install-playwright:
	pnpm exec playwright install $(CI_PLAYWRIGHT_INSTALL_ARGS)

ci-e2e: ci-host-tools ci-install-playwright
	@set -e; \
	dump_playwright_log() { \
		echo "=== $(CI_PLAYWRIGHT_DAEMON_LOG) ==="; \
		cat "$(CI_PLAYWRIGHT_DAEMON_LOG)" || echo "(no Playwright daemon log)"; \
		echo "=== ss -tlnp ==="; \
		ss -tlnp 2>/dev/null | head -20 || true; \
		echo "=== ls .citadel ==="; \
		ls -la .citadel 2>&1 || true; \
	}; \
	for project in $(CI_E2E_PROJECTS); do \
		echo "Running e2e ($$project)"; \
		( \
			set -e; \
			cleanup() { \
				status=$$?; \
				trap - EXIT INT TERM; \
				bash scripts/dev/ci-clean-tmux.sh; \
				if [ "$$status" -ne 0 ]; then dump_playwright_log; fi; \
				exit "$$status"; \
			}; \
			trap cleanup EXIT INT TERM; \
			pnpm e2e:isolated --project="$$project" --workers=1 \
		); \
	done

ci-smoke: ci-host-tools ci-install-playwright
	@set -e; \
	rm -f "$(CI_DEV_LOG)"; \
	dump_dev_log() { \
		echo "=== $(CI_PLAYWRIGHT_DAEMON_LOG) ==="; \
		cat "$(CI_PLAYWRIGHT_DAEMON_LOG)" || echo "(no Playwright daemon log)"; \
		echo "=== $(CI_DEV_LOG) ==="; \
		cat "$(CI_DEV_LOG)" || echo "(no dev log)"; \
		echo "=== ss -tlnp ==="; \
		ss -tlnp 2>/dev/null | head -20 || true; \
		echo "=== ls .citadel ==="; \
		ls -la .citadel 2>&1 || true; \
	}; \
	cleanup() { \
		status=$$?; \
		trap - EXIT INT TERM; \
		if [ -n "$${dev_pgid:-}" ] && kill -0 -- "-$$dev_pgid" 2>/dev/null; then \
			kill -TERM -- "-$$dev_pgid" 2>/dev/null || true; \
			sleep 1; \
			kill -KILL -- "-$$dev_pgid" 2>/dev/null || true; \
		fi; \
		bash scripts/dev/ci-clean-tmux.sh; \
		if [ "$$status" -ne 0 ]; then dump_dev_log; fi; \
		exit "$$status"; \
	}; \
	trap cleanup EXIT INT TERM; \
	setsid env \
		CITADEL_PORT="$(CI_PORT)" \
		CITADEL_WEB_PORT="$(CI_WEB_PORT)" \
		CITADEL_DAEMON_URL="$(CI_DAEMON_URL)" \
		CITADEL_BASE_URL="$(CI_BASE_URL)" \
		CITADEL_WEB_URL="$(CI_WEB_URL)" \
		pnpm dev >"$(CI_DEV_LOG)" 2>&1 & \
	dev_pgid="$$!"; \
	for attempt in {1..60}; do \
		if curl -fsS "$(CI_BASE_URL)/api/health" >/dev/null && curl -fsS "http://127.0.0.1:$(CI_WEB_PORT)" >/dev/null; then \
			ready=1; \
			break; \
		fi; \
		sleep 1; \
	done; \
	if [ "$${ready:-0}" != "1" ]; then \
		echo "CI smoke dev stack did not become ready"; \
		exit 1; \
	fi; \
	CITADEL_BASE_URL="$(CI_BASE_URL)" pnpm smoke; \
	CI=true CITADEL_BASE_URL="$(CI_BASE_URL)" CITADEL_WEB_URL="$(CI_WEB_URL)" pnpm performance

ci-clean-tmux:
	@bash scripts/dev/ci-clean-tmux.sh

ci-dump-playwright-log:
	@echo "=== $(CI_PLAYWRIGHT_DAEMON_LOG) ==="; \
	cat "$(CI_PLAYWRIGHT_DAEMON_LOG)" || echo "(no Playwright daemon log)"; \
	echo "=== ss -tlnp ==="; \
	ss -tlnp 2>/dev/null | head -20 || true; \
	echo "=== ls .citadel ==="; \
	ls -la .citadel 2>&1 || true

ci-dump-dev-log:
	@echo "=== $(CI_PLAYWRIGHT_DAEMON_LOG) ==="; \
	cat "$(CI_PLAYWRIGHT_DAEMON_LOG)" || echo "(no Playwright daemon log)"; \
	echo "=== $(CI_DEV_LOG) ==="; \
	cat "$(CI_DEV_LOG)" || echo "(no dev log)"; \
	echo "=== ss -tlnp ==="; \
	ss -tlnp 2>/dev/null | head -20 || true; \
	echo "=== ls .citadel ==="; \
	ls -la .citadel 2>&1 || true

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
	CITADEL_BASE_URL="$${CITADEL_BASE_URL:-http://127.0.0.1:$(EFFECTIVE_PORT)}" pnpm smoke

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
	@# Auto-seed on a fresh worktree: if there's no mock repo AND no DB yet,
	@# run `make seed` once. Never re-seeds an existing worktree — that's what
	@# `make seed-reset` is for.
	@if [ ! -d "$(WORKTREE_MOCK_REPO)/.git" ] && [ ! -f "$(WORKTREE_DATA_DIR)/citadel.sqlite" ]; then \
		$(MAKE) -s seed; \
	fi
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
			-u CITADEL_TMUX_SOCKET \
			CITADEL_WORKTREE=1 \
			CITADEL_AUTOMATED_GH=$${CITADEL_ENABLE_WORKTREE_GH_AUTOMATION:-0} \
			CITADEL_PORT=$(WORKTREE_PORT) \
			CITADEL_DATA_DIR=$(WORKTREE_DATA_DIR) \
			CITADEL_DAEMON_URL=http://127.0.0.1:$(WORKTREE_PORT) \
			CITADEL_WEB_PORT=$(WORKTREE_WEB_PORT) \
			CITADEL_TMUX_SOCKET=$(WORKTREE_TMUX_SOCKET) \
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

# `make install` is for users (or your devbox). Resolves the install ref
# (latest release by default, REF=main for origin/main, REF=vX.Y.Z for an
# exact release), writes a user-systemd unit pointing at THIS checkout, brings
# it up, and runs doctor. Does NOT touch any worktree-local `deploy` stack.
#
install:
	@bash scripts/install/upgrade.sh $(if $(REF),REF=$(REF))

# Dedicated upgrade verb. Same end-state as `make install`, but with a
# named entry point that operators recognise + REF= pinning.
upgrade:
	@bash scripts/install/upgrade.sh $(if $(REF),REF=$(REF))

# Verify everything is configured. Outputs a human-readable table by
# default; pass `make doctor --json` to get machine-readable JSON.
doctor:
	@pnpm exec tsx scripts/doctor/run.ts $(filter-out $@,$(MAKECMDGOALS))

# Legacy no-op. Citadel now uses one tmux server per workspace, created on
# demand by tmux, so there is no separate citadel-tmux.service to maintain.
tmux-service:
	@echo "citadel-tmux.service is deprecated; workspace tmux servers are created on demand."

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

# `make seed` materializes the checked-in fixture: a mock git repo at
# $(WORKTREE_MOCK_REPO) (+ demo worktrees under $(WORKTREE_MOCK_WORKTREES))
# and synthetic rows in this worktree's SQLite. Idempotent — if either piece is
# already in place, that piece is skipped. `make deploy` auto-runs this on a
# fresh worktree so the cockpit isn't empty.
#
# Why not snapshot from prod: prod data carries live workspace_sessions rows that
# reference tmux sessions owned by the systemd long-term daemon. A worktree
# daemon booted on that data races/steals those sessions, breaking the live
# cockpit. The seed here is fully synthetic and references only paths inside
# this checkout.
seed:
	@if [ ! -d node_modules ]; then \
		echo "✗ node_modules missing — run 'make setup' first"; \
		exit 1; \
	fi
	@bash seeds/setup.sh "$(CURDIR)"
	@CITADEL_DATA_DIR="$(WORKTREE_DATA_DIR)" pnpm --silent seed

# `make seed-reset` is the destructive sibling: stops this worktree's stack,
# removes the SQLite, mock repo, and mock worktrees, then re-seeds. Use when
# you want a clean QA baseline.
seed-reset:
	@$(MAKE) -s stop
	@echo "→ Removing mock repo worktrees registered with $(WORKTREE_MOCK_REPO)"
	@if [ -d "$(WORKTREE_MOCK_REPO)/.git" ]; then \
		git -C "$(WORKTREE_MOCK_REPO)" worktree list --porcelain 2>/dev/null \
			| awk '/^worktree / && $$2 != "$(WORKTREE_MOCK_REPO)" { print $$2 }' \
			| while read -r wt; do git -C "$(WORKTREE_MOCK_REPO)" worktree remove --force "$$wt" 2>/dev/null || true; done; \
	fi
	@echo "→ Wiping seeded paths"
	@rm -rf "$(WORKTREE_DATA_DIR)" "$(WORKTREE_MOCK_REPO)" "$(WORKTREE_MOCK_WORKTREES)"
	@mkdir -p "$(WORKTREE_DATA_DIR)"
	@$(MAKE) -s seed
	@echo "✓ Worktree reset. Run 'make deploy' to start fresh."
