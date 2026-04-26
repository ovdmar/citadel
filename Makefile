SHELL := /bin/bash

LABEL := ai.openclaw.citadel
UID := $(shell id -u)
DOMAIN := gui/$(UID)
SERVICE := $(DOMAIN)/$(LABEL)
PLIST := $(HOME)/Library/LaunchAgents/$(LABEL).plist
LOG_DIR := $(HOME)/Library/Logs/Citadel
STDOUT_LOG := $(LOG_DIR)/stdout.log
STDERR_LOG := $(LOG_DIR)/stderr.log

.PHONY: help dev build deploy install-agent start stop restart logs status

help:
	@echo "Citadel commands"
	@echo "  make dev            Run the dev server"
	@echo "  make build          Build production assets"
	@echo "  make install-agent  Write/update the launchd plist"
	@echo "  make deploy         Build, install agent, and restart Citadel"
	@echo "  make start          Start the Citadel launchd service"
	@echo "  make stop           Stop the Citadel launchd service"
	@echo "  make restart        Restart the Citadel launchd service"
	@echo "  make logs           Tail Citadel stdout/stderr logs"
	@echo "  make status         Show launchd status for Citadel"

dev:
	npm run dev

build:
	npm run build

install-agent:
	./bin/install-launch-agent.sh

deploy: build install-agent restart

start: install-agent
	@mkdir -p "$(LOG_DIR)"
	@launchctl print "$(SERVICE)" >/dev/null 2>&1 || launchctl bootstrap "$(DOMAIN)" "$(PLIST)"
	@launchctl enable "$(SERVICE)" >/dev/null 2>&1 || true
	@launchctl kickstart -k "$(SERVICE)"
	@echo "Citadel started via $(SERVICE)"

stop:
	@launchctl bootout "$(SERVICE)" >/dev/null 2>&1 || launchctl bootout "$(DOMAIN)" "$(PLIST)" >/dev/null 2>&1 || true
	@echo "Citadel stopped"

restart: install-agent
	@mkdir -p "$(LOG_DIR)"
	@launchctl print "$(SERVICE)" >/dev/null 2>&1 || launchctl bootstrap "$(DOMAIN)" "$(PLIST)"
	@launchctl enable "$(SERVICE)" >/dev/null 2>&1 || true
	@launchctl kickstart -k "$(SERVICE)"
	@echo "Citadel restarted via $(SERVICE)"

logs:
	@mkdir -p "$(LOG_DIR)"
	@touch "$(STDOUT_LOG)" "$(STDERR_LOG)"
	@tail -n 200 -f "$(STDOUT_LOG)" "$(STDERR_LOG)"

status:
	@launchctl print "$(SERVICE)"
