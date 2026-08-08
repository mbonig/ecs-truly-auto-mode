FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/server .

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=builder /out/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
