# Kubernetes deployment

## Required tracker credentials

Create the target namespace and the Secret referenced by
`tracker.auth.existingSecret` before installing the Helm chart. Use independent
random values and do not commit them:

```bash
kubectl create namespace openstreamgrid --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic openstreamgrid-auth \
  --namespace openstreamgrid \
  --from-literal=tracker-api-key='<random-admin-key>' \
  --from-literal=peer-session-secret='<at-least-32-random-bytes>'
```

The default chart intentionally uses one tracker replica with SQLite. It rejects
SQLite autoscaling or multiple replicas; choose a shared external store before
enabling horizontal scaling.

OpenStreamGrid ships a Helm chart for the tracker and origin services. The
default configuration creates one tracker replica backed by a 1 Gi SQLite PVC,
one origin replica with memory-backed HLS storage, and port-restricted network
policies. Ingress and tracker autoscaling are disabled by default.

## Prerequisites

- Kubernetes 1.23 or newer
- Helm 3
- An ingress controller when `ingress.enabled` is set
- Metrics Server only when a future shared tracker store permits autoscaling

The container images must be available to the cluster:

- `ghcr.io/mytrashcan/openstreamgrid-tracker:0.5.0`
- `ghcr.io/mytrashcan/openstreamgrid-origin:0.5.0`

## Deploy with Helm

Review and override the ingress host and storage class for your cluster:

```bash
helm upgrade --install openstreamgrid helm/openstreamgrid \
  --namespace openstreamgrid \
  --create-namespace \
  --set ingress.enabled=true \
  --set ingress.host=stream.example.com \
  --set ingress.className=nginx
```

For TLS, add a values file such as:

```yaml
ingress:
  enabled: true
  host: stream.example.com
  className: nginx
  tls:
    - secretName: openstreamgrid-tls
      hosts:
        - stream.example.com
```

Then apply it with `helm upgrade --install ... -f production-values.yaml`.

## Deploy with Kustomize

The Kustomize overlay inflates the local Helm chart, so Helm support must be
enabled explicitly:

```bash
kustomize build \
  --enable-helm \
  --load-restrictor=LoadRestrictionsNone \
  deploy/k8s | kubectl apply -f -
```

If only `kubectl` is installed, use:

```bash
kubectl kustomize \
  --enable-helm \
  --load-restrictor=LoadRestrictionsNone \
  deploy/k8s | kubectl apply -f -
```

## Verify the deployment

```bash
kubectl rollout status deployment/openstreamgrid-tracker -n openstreamgrid
kubectl rollout status deployment/openstreamgrid-origin -n openstreamgrid
kubectl get pods,services,ingress,hpa,pvc -n openstreamgrid
curl http://stream.example.com/health
curl http://stream.example.com/hls/stream.m3u8
```

Ingress uses Kubernetes `Prefix` paths: `/hls` and all of its subpaths route to
the origin, while `/` routes tracker API, dashboard, health, and WebSocket
traffic to the tracker.

## Operational notes

- The default `ReadWriteOnce` SQLite volume supports exactly one tracker
  replica. The chart rejects multiple SQLite replicas and SQLite autoscaling.
- For horizontally scaled production trackers, use a shared external store
  instead of a single SQLite file when that store adapter is available.
- The HLS `emptyDir` uses node memory and is intentionally ephemeral. Its
  default size limit is 256 MiB.
- The network policies allow inbound traffic only on tracker port 7070 and
  origin port 8080. Origin egress is limited to tracker and DNS traffic.

## Remove the deployment

For Helm:

```bash
helm uninstall openstreamgrid --namespace openstreamgrid
kubectl delete namespace openstreamgrid
```

For Kustomize:

```bash
kustomize build \
  --enable-helm \
  --load-restrictor=LoadRestrictionsNone \
  deploy/k8s | kubectl delete -f -
```
