#!/usr/bin/env bash
# Verify that Prometheus is scraping the Guestbook targets.
# Author: Dinesh Melimi
set -euo pipefail
kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-prometheus 9090:9090 >/dev/null 2>&1 &
PF=$!
trap 'kill $PF' EXIT
sleep 3
echo "Scrape targets (job, health):"
curl -s 'http://localhost:9090/api/v1/targets?state=active' \
  | jq -r '.data.activeTargets[] | select(.labels.job | test("frontend|redis-leader|redis-replica")) | "\(.labels.job)\t\(.labels.pod)\t\(.health)"'
echo
echo "Guestbook requests/sec (last 1m):"
curl -s --data-urlencode 'query=sum(rate(nginx_http_requests_total{job="frontend"}[1m]))' http://localhost:9090/api/v1/query | jq -r '.data.result[0].value[1] // "0"'
echo "Redis commands processed (leader):"
curl -s --data-urlencode 'query=redis_commands_processed_total{job="redis-leader"}' http://localhost:9090/api/v1/query | jq -r '.data.result[0].value[1] // "no data"'
