.PHONY: install build dev up down restart clean \
       bootstrap-grafana-token \
       typecheck lint lint-fix test test-ci e2e \
       build-panel build-timeseries build-app build-slo build-go build-slo-control-plane \
       openapi-generate openapi-lint \
       logs logs-grafana logs-clickhouse logs-collector logs-generator \
       eval

# ── Install ──────────────────────────────────────────────────────────
install: ## Install all dependencies (npm + go)
	npm install --workspaces
	cd trace-generator && go mod download

# ── Build ────────────────────────────────────────────────────────────
build: build-panel build-timeseries build-app build-slo build-go ## Build everything

build-panel: ## Build the heatmap panel plugin
	npm run build --workspace=plugins/heatmap-panel

build-timeseries: ## Build the timeseries selection panel plugin
	npm run build --workspace=plugins/timeseries-selection-panel

build-app: ## Build the Event Deltas Scenes app plugin
	npm run build --workspace=plugins/heatmap-app

build-slo: ## Build the SLO Scenes app plugin
	npm run build --workspace=plugins/slo-app

build-go: ## Build the Go trace generator (local binary)
	cd trace-generator && go build -o bin/trace-generator .

build-slo-control-plane: ## Build the standalone SLO control-plane
	cd services/slo-control-plane && go build ./...

# ── Dev ──────────────────────────────────────────────────────────────
dev: ## Watch-build all plugins
	npm run dev --workspace=plugins/heatmap-panel & \
	npm run dev --workspace=plugins/timeseries-selection-panel & \
	npm run dev --workspace=plugins/heatmap-app & \
	npm run dev --workspace=plugins/slo-app & \
	wait

dev-slo: ## Watch-build SLO app only
	npm run dev --workspace=plugins/slo-app

# ── Docker Compose ───────────────────────────────────────────────────
up: build ## Build stack, create Grafana token, recreate control-plane with token, seed demo SLOs
	@V="1.0.0-dev.$$(date +%s)"; \
	for d in plugins/heatmap-panel/dist plugins/timeseries-selection-panel/dist plugins/heatmap-app/dist plugins/slo-app/dist; do \
	  [ -f "$$d/plugin.json" ] && \
	  sed -i '' "s/\"version\": \"1.0.0\"/\"version\": \"$$V\"/" "$$d/plugin.json" || true; \
	done
	docker compose -f docker/docker-compose.yml up --build -d
	$(MAKE) bootstrap-grafana-token
	@docker compose --env-file docker/.env.slo -f docker/docker-compose.yml up -d --no-deps --force-recreate slo-control-plane
	@docker compose -f docker/docker-compose.yml restart grafana 2>/dev/null || true
	@cd services/slo-control-plane && API_BASE_URL=http://localhost:8080 ./scripts/crud-demo.sh seed

bootstrap-grafana-token: ## Create/update docker/.env.slo with Grafana service-account token
	@./docker/create-grafana-token.sh

down: ## Stop the stack
	docker compose -f docker/docker-compose.yml down

restart: down up ## Restart the stack

# ── Checks ───────────────────────────────────────────────────────────
typecheck: ## Run TypeScript type checking on all plugins
	npm run typecheck --workspace=plugins/heatmap-panel
	npm run typecheck --workspace=plugins/timeseries-selection-panel
	npm run typecheck --workspace=plugins/heatmap-app
	npm run typecheck --workspace=plugins/slo-app

lint: ## Run ESLint on all plugins
	npm run lint --workspace=plugins/heatmap-panel
	npm run lint --workspace=plugins/timeseries-selection-panel
	npm run lint --workspace=plugins/heatmap-app
	npm run lint --workspace=plugins/slo-app
	cd services/slo-control-plane && go test ./...

openapi-generate: ## Generate Go + TypeScript API bindings
	mkdir -p services/slo-control-plane/internal/api
	mkdir -p plugins/slo-app/src/api/generated
	cd . && go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen -generate types,chi-server,spec -package apiv1 api/openapi/slo-control-plane.openapi.yaml > services/slo-control-plane/internal/api/apiv1.gen.go
	npx openapi-typescript api/openapi/slo-control-plane.openapi.yaml -o plugins/slo-app/src/api/generated/types.ts

openapi-lint: ## Lint OpenAPI spec
	npx @redocly/cli lint --config .redocly.yaml api/openapi/slo-control-plane.openapi.yaml

lint-fix: ## Auto-fix lint + prettier issues
	npm run lint:fix --workspace=plugins/heatmap-panel
	npm run lint:fix --workspace=plugins/timeseries-selection-panel
	npm run lint:fix --workspace=plugins/heatmap-app
	npm run lint:fix --workspace=plugins/slo-app

test: ## Run jest in watch mode (all plugins)
	npm run test --workspace=plugins/heatmap-panel & \
	npm run test --workspace=plugins/timeseries-selection-panel & \
	npm run test --workspace=plugins/heatmap-app & \
	npm run test --workspace=plugins/slo-app & \
	wait

test-ci: ## Run jest once, no watch (CI mode)
	npm run test:ci --workspace=plugins/heatmap-panel
	npm run test:ci --workspace=plugins/timeseries-selection-panel
	npm run test:ci --workspace=plugins/heatmap-app
	npm run test:ci --workspace=plugins/slo-app

e2e: ## Run Playwright e2e tests (all plugins)
	npm run e2e --workspace=plugins/heatmap-panel
	npm run e2e --workspace=plugins/timeseries-selection-panel
	npm run e2e --workspace=plugins/heatmap-app
	npm run e2e --workspace=plugins/slo-app

# ── Eval ─────────────────────────────────────────────────────────────
eval: ## Run the agent-RCA eval matrix (needs `make up` + ANTHROPIC creds). Pass ARGS="--scenario S1 --arm wide-sql --trials 1" for a subset.
	cd eval && npm run eval -- $(ARGS)

# ── Logs ─────────────────────────────────────────────────────────────
logs: ## Tail all container logs
	docker compose -f docker/docker-compose.yml logs -f

logs-grafana: ## Tail Grafana logs
	docker compose -f docker/docker-compose.yml logs -f grafana

logs-clickhouse: ## Tail ClickHouse logs
	docker compose -f docker/docker-compose.yml logs -f clickhouse-server

logs-collector: ## Tail OTel collector logs
	docker compose -f docker/docker-compose.yml logs -f otel-collector

logs-generator: ## Tail trace generator logs
	docker compose -f docker/docker-compose.yml logs -f trace-generator

# ── Cleanup ──────────────────────────────────────────────────────────
clean: ## Remove build artifacts and node_modules
	rm -rf plugins/heatmap-panel/dist plugins/timeseries-selection-panel/dist plugins/heatmap-app/dist plugins/slo-app/dist
	rm -rf plugins/heatmap-panel/node_modules plugins/timeseries-selection-panel/node_modules plugins/heatmap-app/node_modules plugins/slo-app/node_modules
	rm -rf packages/shared-comparison/node_modules
	rm -rf node_modules
	rm -f trace-generator/bin/trace-generator

# ── Help ─────────────────────────────────────────────────────────────
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
