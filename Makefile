SHELL := /bin/bash

.PHONY: help install dev dev-daemon dev-web build check typecheck lint test coverage e2e smoke clean

help:
	@echo "Citadel v2 commands"
	@echo "  make install      Install pnpm dependencies"
	@echo "  make dev          Run daemon and web dev servers"
	@echo "  make check        Run architecture, size, type, lint, test, coverage, security, build"
	@echo "  make smoke        Run local API smoke against a running daemon"
	@echo "  make e2e          Run Playwright happy-path tests"

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

clean:
	rm -rf apps/*/dist packages/*/dist coverage test-results playwright-report
