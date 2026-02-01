FROM golang:1.22-alpine AS builder

WORKDIR /workspace
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o nightglow-operator ./cmd/operator/main.go

FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=builder /workspace/nightglow-operator .
USER 65532:65532

ENTRYPOINT ["/nightglow-operator"]
