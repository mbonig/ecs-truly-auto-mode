package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

var client = &http.Client{Timeout: 10 * time.Second}

func health(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// Reaches a third-party API on the public internet. This is what forces the
// workload into private subnets with a NAT gateway.
func rates(w http.ResponseWriter, _ *http.Request) {
	resp, err := client.Get("https://api.exchangerate.host/latest?base=USD")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	json.NewEncoder(w).Encode(payload)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	http.HandleFunc("/health", health)
	http.HandleFunc("/rates", rates)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
