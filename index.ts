// Guestbook monitoring with Prometheus and Grafana on Kubernetes (Pulumi, TypeScript).
// Author: Dinesh Melimi
// Based on pulumi/examples kubernetes-ts-guestbook/simple.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as fs from "fs";
import * as path from "path";

const config = new pulumi.Config();
// minikube / kind / Docker Desktop: no cloud load balancer, so use ClusterIP for the app and NodePort for Grafana.
const isMinikube = config.getBoolean("isMinikube") ?? true;
const grafanaServiceType = isMinikube ? "NodePort" : "LoadBalancer";
const grafanaNodePort = 30300;

// ---------------------------------------------------------------------------
// Monitoring stack: Prometheus Operator, Prometheus, Grafana, kube-state-metrics,
// node-exporter (kube-prometheus-stack Helm chart).
// ---------------------------------------------------------------------------

const monitoringNs = new k8s.core.v1.Namespace("monitoring", { metadata: { name: "monitoring" } });

// Grafana admin password: generated, stored encrypted in Pulumi state, never hard-coded.
const grafanaAdminUser = "admin";
const grafanaAdminPassword = new random.RandomPassword("grafana-admin-password", {
    length: 20,
    special: false,
}).result;

const promStack = new k8s.helm.v3.Release("kube-prometheus-stack", {
    name: "kps",
    chart: "kube-prometheus-stack",
    version: "92.10.1",
    namespace: monitoringNs.metadata.name,
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    values: {
        prometheus: {
            prometheusSpec: {
                // Pick up ServiceMonitors / PrometheusRules from every namespace, not only ones
                // carrying this release's labels.
                serviceMonitorSelectorNilUsesHelmValues: false,
                podMonitorSelectorNilUsesHelmValues: false,
                ruleSelectorNilUsesHelmValues: false,
                scrapeInterval: "15s",
                retention: "2d",
            },
        },
        grafana: {
            adminUser: grafanaAdminUser,
            adminPassword: grafanaAdminPassword,
            // Chart keeps Grafana internal; the externally reachable Service is defined below.
            service: { type: "ClusterIP" },
            sidecar: {
                // Load any ConfigMap labelled grafana_dashboard=1 as a dashboard.
                dashboards: { enabled: true, label: "grafana_dashboard", labelValue: "1", searchNamespace: "ALL" },
            },
        },
        alertmanager: { enabled: true },
    },
}, { dependsOn: [monitoringNs] });

// ---------------------------------------------------------------------------
// Guestbook (from pulumi/examples kubernetes-ts-guestbook/simple), with metrics added.
// ---------------------------------------------------------------------------

const redisExporter = (target: string): k8s.types.input.core.v1.Container => ({
    name: "redis-exporter",
    image: "oliver006/redis_exporter:v1.62.0",
    env: [{ name: "REDIS_ADDR", value: target }],
    ports: [{ name: "metrics", containerPort: 9121 }],
    resources: { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "100m", memory: "64Mi" } },
});

// REDIS LEADER
const redisLeaderLabels = { app: "redis-leader", tier: "backend" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379 }],
                    },
                    redisExporter("redis://localhost:6379"),
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: { name: "redis-leader", labels: redisLeaderLabels },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: "metrics" },
        ],
        selector: redisLeaderLabels,
    },
});

// REDIS REPLICA
const redisReplicaLabels = { app: "redis-replica", tier: "backend" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                    redisExporter("redis://localhost:6379"),
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: { name: "redis-replica", labels: redisReplicaLabels },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: "metrics" },
        ],
        selector: redisReplicaLabels,
    },
});

// FRONTEND
// The PHP/Apache image has no metrics endpoint, so an nginx sidecar sits in front of it:
// traffic -> nginx :8080 -> apache :80. nginx exposes stub_status on :8081, and
// nginx-prometheus-exporter turns that into Prometheus metrics (requests, connections) on :9113.
const nginxConf = new k8s.core.v1.ConfigMap("frontend-nginx", {
    data: {
        "default.conf": `
server {
    listen 8080;
    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
server {
    listen 8081;
    location /stub_status {
        stub_status;
        allow 127.0.0.1;
        deny all;
    }
}
`,
    },
});

const frontendLabels = { app: "frontend", tier: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 80 }],
                    },
                    {
                        name: "nginx",
                        image: "nginx:1.27-alpine",
                        ports: [{ name: "http", containerPort: 8080 }],
                        volumeMounts: [{ name: "nginx-conf", mountPath: "/etc/nginx/conf.d" }],
                        resources: { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "200m", memory: "64Mi" } },
                        readinessProbe: { httpGet: { path: "/", port: 8080 }, periodSeconds: 10 },
                    },
                    {
                        name: "nginx-exporter",
                        image: "nginx/nginx-prometheus-exporter:1.3.0",
                        args: ["--nginx.scrape-uri=http://127.0.0.1:8081/stub_status"],
                        ports: [{ name: "metrics", containerPort: 9113 }],
                        resources: { requests: { cpu: "10m", memory: "16Mi" }, limits: { cpu: "50m", memory: "32Mi" } },
                    },
                ],
                volumes: [{ name: "nginx-conf", configMap: { name: nginxConf.metadata.name } }],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: { name: "frontend", labels: frontendLabels },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [
            { name: "http", port: 80, targetPort: "http" },
            { name: "metrics", port: 9113, targetPort: "metrics" },
        ],
        selector: frontendLabels,
    },
});

// ---------------------------------------------------------------------------
// Scrape config: ServiceMonitors for the frontend and both Redis tiers.
// ---------------------------------------------------------------------------

const serviceMonitor = (name: string, labels: Record<string, string>, svc: k8s.core.v1.Service) =>
    new k8s.apiextensions.CustomResource(`${name}-servicemonitor`, {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: { name, namespace: "default", labels: { release: "kps" } },
        spec: {
            selector: { matchLabels: labels },
            namespaceSelector: { matchNames: ["default"] },
            endpoints: [{ port: "metrics", interval: "15s", path: "/metrics" }],
        },
    }, { dependsOn: [promStack, svc] });

serviceMonitor("guestbook-frontend", { app: "frontend" }, frontendService);
serviceMonitor("guestbook-redis-leader", { app: "redis-leader" }, redisLeaderService);
serviceMonitor("guestbook-redis-replica", { app: "redis-replica" }, redisReplicaService);

// Basic alerts so a broken guestbook is noticed, not just graphed.
new k8s.apiextensions.CustomResource("guestbook-alerts", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "PrometheusRule",
    metadata: { name: "guestbook-alerts", namespace: "default", labels: { release: "kps" } },
    spec: {
        groups: [{
            name: "guestbook",
            rules: [
                {
                    alert: "GuestbookFrontendDown",
                    expr: 'sum(up{job="frontend"}) == 0',
                    for: "2m",
                    labels: { severity: "critical" },
                    annotations: { summary: "No guestbook frontend pod is being scraped" },
                },
                {
                    alert: "GuestbookRedisDown",
                    expr: 'redis_up{job=~"redis-leader|redis-replica"} == 0',
                    for: "2m",
                    labels: { severity: "critical" },
                    annotations: { summary: "Redis {{ $labels.job }} is down" },
                },
                {
                    alert: "GuestbookFrontendHighCPU",
                    expr: 'sum(rate(container_cpu_usage_seconds_total{namespace="default",pod=~"frontend-.*",container="frontend"}[5m])) by (pod) > 0.08',
                    for: "10m",
                    labels: { severity: "warning" },
                    annotations: { summary: "Frontend pod {{ $labels.pod }} is using over 80% of its CPU request" },
                },
            ],
        }],
    },
}, { dependsOn: [promStack] });

// ---------------------------------------------------------------------------
// Grafana dashboard (stretch goal): loaded by the Grafana dashboard sidecar.
// ---------------------------------------------------------------------------

new k8s.core.v1.ConfigMap("guestbook-dashboard", {
    metadata: { namespace: monitoringNs.metadata.name, labels: { grafana_dashboard: "1" } },
    data: { "guestbook.json": fs.readFileSync(path.join(__dirname, "dashboards", "guestbook.json"), "utf8") },
}, { dependsOn: [promStack] });

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

// External Grafana Service, owned by this program so its address is known on the first deploy.
const grafanaService = new k8s.core.v1.Service("grafana-external", {
    metadata: { name: "grafana-external", namespace: monitoringNs.metadata.name },
    spec: {
        type: grafanaServiceType,
        selector: { "app.kubernetes.io/name": "grafana", "app.kubernetes.io/instance": "kps" },
        ports: [isMinikube
            ? { name: "http", port: 80, targetPort: 3000, nodePort: grafanaNodePort }
            : { name: "http", port: 80, targetPort: 3000 }],
    },
}, { dependsOn: [promStack] });

export const frontendIp = isMinikube
    ? frontendService.spec.clusterIP
    : frontendService.status.loadBalancer.ingress[0].ip;

export const grafanaUrl = isMinikube
    ? pulumi.output(`http://localhost:${grafanaNodePort}  (NodePort; on minikube use: minikube service grafana-external -n monitoring --url)`)
    : grafanaService.status.loadBalancer.ingress.apply(i => {
        const host = i?.[0]?.ip ?? i?.[0]?.hostname;
        return host ? `http://${host}` : "pending: run `pulumi refresh` once the load balancer is ready";
    });
export const grafanaServiceKind = grafanaServiceType;
export const grafanaAdminUsername = grafanaAdminUser;
export const grafanaAdminPasswordSecret = pulumi.secret(grafanaAdminPassword);
export const prometheusPortForward = "kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-prometheus 9090:9090";
