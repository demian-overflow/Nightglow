IMG ?= nightglow-operator:latest
NAMESPACE ?= nightglow-system

.PHONY: all build run install uninstall deploy undeploy fmt vet docker-build docker-push

all: build

##@ Development

fmt:
	go fmt ./...

vet:
	go vet ./...

build: fmt vet
	go build -o bin/operator ./cmd/operator/main.go

run: fmt vet
	go run ./cmd/operator/main.go

##@ Deployment

# Install CRDs into the cluster
install:
	kubectl apply -f config/crd/

# Uninstall CRDs from the cluster
uninstall:
	kubectl delete -f config/crd/

# Install RBAC
install-rbac:
	kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f config/rbac/

# Deploy operator to cluster
deploy: install install-rbac docker-build
	kubectl -n $(NAMESPACE) apply -f config/rbac/
	kubectl -n $(NAMESPACE) create deployment nightglow-operator \
		--image=$(IMG) \
		--dry-run=client -o yaml | kubectl apply -f -

undeploy:
	kubectl -n $(NAMESPACE) delete deployment nightglow-operator || true
	kubectl delete -f config/rbac/ || true

##@ Samples

# Apply the working example (end-to-end)
sample-setup:
	kubectl apply -f config/samples/00-namespace.yaml
	kubectl apply -f config/samples/01-browserless-pool.yaml
	@echo "Waiting for pool to be ready..."
	@sleep 5
	kubectl apply -f config/samples/02-browser-session.yaml
	@echo "Waiting for session to be active..."
	@sleep 5

sample-extract:
	kubectl apply -f config/samples/03-task-navigate-extract.yaml

sample-login:
	kubectl apply -f config/samples/04-task-login.yaml

sample-form:
	kubectl apply -f config/samples/05-task-form-fill.yaml

# Watch all resources
watch:
	kubectl get bpool,bsess,atask,trec -n browser-automation -w

# Get all task records
records:
	kubectl get taskrecords -n browser-automation -o wide

# Clean up samples
sample-clean:
	kubectl delete namespace browser-automation || true

##@ Docker

docker-build:
	docker build -t $(IMG) .

docker-push:
	docker push $(IMG)
