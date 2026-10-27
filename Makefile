GO := $(shell command -v go 2>/dev/null || echo $(HOME)/.goenv/shims/go)
.PHONY: build linux mac release deploy portal rollback releases client-release
mac:
	bash apple/build-mac.sh
build: mac
	npm --prefix web run build
	$(GO) build -trimpath -o bin/aura ./cmd/aura
linux: mac
	npm --prefix web run build
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -o bin/aura-linux-amd64 ./cmd/aura
release:
	bash deploy/release.sh build
deploy:
	bash deploy/release.sh deploy
portal:
	bash deploy/release.sh portal
rollback:
	bash deploy/release.sh rollback $(COMMIT)
releases:
	bash deploy/release.sh list
client-release:
	gh workflow run client-release.yml --repo Crashmere/Aura --ref main
