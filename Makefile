# Makefile for building & publishing the telehelm Docker image.
#
# Version is read straight from package.json so it stays the single source
# of truth — bump it there (or via `make bump-*`) and every target follows.

IMAGE    ?= fuongz/telehelm
VERSION  := $(shell node -p "require('./package.json').version" 2>/dev/null || \
              grep -m1 '"version"' package.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')
PLATFORMS ?= linux/amd64,linux/arm64
BUILDER  ?= multi

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@echo "telehelm image targets (current version: $(VERSION))"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: login
login: ## Log in to Docker Hub (uses a Personal Access Token as the password)
	docker login -u fuongz

.PHONY: builder
builder: ## Ensure the multi-arch buildx builder exists and is selected
	docker buildx inspect $(BUILDER) >/dev/null 2>&1 || docker buildx create --name $(BUILDER) --use
	docker buildx use $(BUILDER)

.PHONY: build
build: ## Build a local single-arch image loaded into Docker (no push)
	docker build -t $(IMAGE):$(VERSION) -t $(IMAGE):latest .

.PHONY: publish
publish: builder ## Build multi-arch ($(PLATFORMS)) and push :$(VERSION) + :latest
	docker buildx build --platform $(PLATFORMS) \
		-t $(IMAGE):$(VERSION) -t $(IMAGE):latest \
		--push .
	@echo "Pushed $(IMAGE):$(VERSION) and $(IMAGE):latest"

.PHONY: bump-patch bump-minor bump-major
bump-patch: ## Bump patch version in package.json (1.0.0 -> 1.0.1)
	npm version patch --no-git-tag-version
bump-minor: ## Bump minor version in package.json (1.0.0 -> 1.1.0)
	npm version minor --no-git-tag-version
bump-major: ## Bump major version in package.json (1.0.0 -> 2.0.0)
	npm version major --no-git-tag-version

.PHONY: version
version: ## Print the version that will be published
	@echo $(VERSION)

.PHONY: release
release: publish ## Alias for publish (build multi-arch + push)
